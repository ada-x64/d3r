import {
	client,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type RequestPermissionRequest,
	type SessionNotification,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { SEED_ROOT } from "@d3r/core/vault/seed-root";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Models } from "../pi/auth.ts";
import { createNativeDeps } from "../../cli/src/native.ts";
import {
	nativeModelKey,
	type NativeModel,
} from "../../cli/src/native-models.ts";
import { deferred, fixture } from "./test-support.ts";

/** Provider fixtures use the adapter's public types, without another Pi dependency. */
type JourneyStream = ReturnType<Models["streamSimple"]>;
/** Capture model-facing context, not executable tool closures. */
type JourneyContext = Parameters<Models["streamSimple"]>[1];
/** Complete assistant responses enter the real embedded model/tool loop. */
type JourneyMessage = Awaited<ReturnType<JourneyStream["result"]>>;
/** Each role has its own script so parallel arrival order is irrelevant. */
type JourneyScripts = Record<
	string,
	(
		| JourneyMessage["content"]
		| ((context: JourneyContext) => JourneyMessage["content"])
	)[]
>;
/** An inert catalog cannot read credentials or discover live providers. */
const JOURNEY_MODEL: NativeModel = {
	id: "offline",
	name: "Offline journey model",
	provider: "fixture",
	api: "openai-completions",
	baseUrl: "https://provider.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 1024,
};
/** Only provider IO is replaced; messages and tool results still pass through Pi. */
const journeyStream = (content: JourneyMessage["content"]): JourneyStream => {
	const message: JourneyMessage = {
		role: "assistant",
		content,
		api: JOURNEY_MODEL.api,
		provider: JOURNEY_MODEL.provider,
		model: JOURNEY_MODEL.id,
		stopReason: content.some((part) => part.type === "toolCall")
			? "toolUse"
			: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const events = [
		{ type: "start", partial: message },
		...content.flatMap((part, contentIndex) =>
			part.type === "text"
				? [
						{
							type: "text_delta",
							contentIndex,
							delta: part.text,
							partial: message,
						},
					]
				: [],
		),
		{ type: "done", reason: message.stopReason, message },
	];
	let index = 0;
	return {
		[Symbol.asyncIterator]: () => ({
			next: async () =>
				index < events.length
					? { value: events[index++], done: false }
					: { value: undefined, done: true },
		}),
		result: async () => message,
	} as JourneyStream;
};
/** Raw provider IDs may be reused across isolated roles and subsequent turns. */
const journeyCall = (
	name: string,
	args: Record<string, unknown>,
	id = name,
): JourneyMessage["content"] => [
	{ type: "toolCall", id, name, arguments: args },
];
/** Look up observed results by provider call ID, not parallel role arrival order. */
const journeyResult = (context: JourneyContext, id: string) =>
	context.messages.findLast(
		(message) => message.role === "toolResult" && message.toolCallId === id,
	);
/** Read the public JSON text envelope; fixtures must use actual read snapshots. */
const journeyPage = (context: JourneyContext, id: string) => {
	const result = journeyResult(context, id);
	if (result?.role !== "toolResult" || result.isError) {
		throw new Error(`Missing successful vault read: ${id}`);
	}
	return JSON.parse(
		result.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n"),
	) as {
		path: string;
		text: string;
		snapshot: string;
		truncated: boolean;
		nextOffset?: number;
	};
};
/** Reports are model tool calls, never direct workflow callback submissions. */
const journeyReport = (summary: string, extra: Record<string, unknown> = {}) =>
	journeyCall("d3r_report", { status: "completed", summary, ...extra });
/** Segmentation is not a UX contract; assert the assembled assistant response. */
const journeyText = (updates: readonly SessionNotification[]) =>
	updates
		.flatMap(({ update }) =>
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text"
				? [update.content.text]
				: [],
		)
		.join("");

/** Inspect the content ACP clients render, rather than rawInput or rawOutput. */
const journeyToolText = ({ content }: Pick<ToolCallUpdate, "content">) =>
	(content ?? [])
		.flatMap((part) =>
			part.type === "content" && part.content.type === "text"
				? [part.content.text]
				: [],
		)
		.join("\n");
/** Preserve tool identity so assertions cover pending cards and their later results. */
const journeyTools = (updates: readonly SessionNotification[]) =>
	updates
		.map(({ update }) => update)
		.filter(
			(update) =>
				update.sessionUpdate === "tool_call" ||
				update.sessionUpdate === "tool_call_update",
		);

/** Offline journeys exercise D3R, not binary launch, Zed rendering, live auth or model judgment. */
describe("native ACP shipped-workflow journeys", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const open = async (
		scripts: JourneyScripts,
		{
			workspace = "workspace",
			readTextFile,
		}: {
			workspace?: string;
			readTextFile?: (
				request: ReadTextFileRequest,
			) => Promise<ReadTextFileResponse>;
		} = {},
	) => {
		const root = await mkdtemp(
			resolve(await realpath(tmpdir()), "d3r-acp-journey-"),
		);
		directories.push(root);
		const home = resolve(root, "home");
		const cwd = resolve(root, workspace);
		await Promise.all([mkdir(home), mkdir(cwd, { recursive: true })]);
		await writeFile(
			resolve(cwd, "AGENTS.md"),
			"Preserve the offline user's requirements.",
		);
		const requests: { role: string; context: JourneyContext }[] = [];
		const permissions: RequestPermissionRequest[] = [];
		const reads: ReadTextFileRequest[] = [];
		const approval = {
			decide: async (_request: RequestPermissionRequest) => true,
		};
		const streamSimple: Models["streamSimple"] = (_model, context) => {
			const role =
				/^You are (\w+)\./.exec(context.systemPrompt ?? "")?.[1] ?? "router";
			requests.push({
				role,
				context: {
					systemPrompt: context.systemPrompt,
					messages: structuredClone(context.messages),
					tools: context.tools?.map(({ name, description, parameters }) => ({
						name,
						description,
						parameters: structuredClone(parameters),
					})),
				},
			});
			const content = scripts[role]?.shift();
			if (!content) {
				throw new Error(`Unexpected offline request for ${role}`);
			}
			return journeyStream(
				typeof content === "function" ? content(context) : content,
			);
		};
		const connect = async () => {
			const deps = await createNativeDeps(
				{ home, version: "journey-test" },
				{
					createModelRuntime: async () => ({
						getAvailable: async () => [JOURNEY_MODEL],
						getProviders: () => [],
						logout: async () => {},
						streamSimple,
					}),
				},
			);
			const clientApp = client().onRequest(
				"session/request_permission",
				async ({ params }) => {
					permissions.push(params);
					const kind = (await approval.decide(params))
						? "allow_once"
						: "reject_once";
					return {
						outcome: {
							outcome: "selected",
							optionId: params.options.find((option) => option.kind === kind)!
								.optionId,
						},
					};
				},
			);
			const f = fixture(deps.createSession, async () => {}, {
				deps,
				clientApp: readTextFile
					? clientApp.onRequest("fs/read_text_file", ({ params }) => {
							reads.push(params);
							return readTextFile(params);
						})
					: clientApp,
			});
			cleanup.push(f.close);
			await f.peer.agent.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: readTextFile ? { fs: { readTextFile: true } } : {},
			});
			return {
				...f,
				checkpoint: async (sessionId: string) => {
					const saved = await deps.store!.get(sessionId);
					const record = saved?.records.at(-1);
					if (record?.kind !== "checkpoint") {
						throw new Error("Missing durable checkpoint");
					}
					return record.state;
				},
				prompt: (sessionId: string, text: string) =>
					f.peer.agent.request("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text }],
					}),
			};
		};
		return { root, cwd, requests, permissions, reads, approval, connect };
	};
	afterEach(async () => {
		try {
			await Promise.all(cleanup.splice(0).map((close) => close()));
		} finally {
			await Promise.all(
				directories
					.splice(0)
					.map((path) => rm(path, { recursive: true, force: true })),
			);
		}
	});

	// oxlint-disable-next-line max-statements -- Keep the human checkpoint, reconnect, and final effect in one journey.
	it("finishes /design after parallel recon, a persisted human checkpoint and fresh workspace trust", async () => {
		const recon = (summary: string) => [
			journeyCall("read_file", { path: "brief.txt" }),
			journeyReport(summary),
			[{ type: "text" as const, text: summary }],
		];
		const design = "Use a local queue; retain pending jobs across restarts.\n";
		const scripts: JourneyScripts = {
			router: [
				[
					{
						type: "text",
						text: "I am D3R. I coordinate design, implementation, and review.",
					},
				],
			],
			aggregator: recon("Existing jobs must survive restarts."),
			researcher: recon("A local queue meets the offline requirement."),
			designer: [
				journeyCall("write_file", { path: "design.md", content: design }),
				journeyReport("Designed the durable local queue."),
				[{ type: "text", text: "The design is ready in design.md." }],
			],
		};
		const j = await open(scripts);
		await writeFile(
			resolve(j.cwd, "brief.txt"),
			"Jobs must survive restarts without a network service.",
		);
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		const request = "/design Plan an offline job queue using brief.txt";
		const greeting = "Hi! tell me about yourself.";
		await expect(f.prompt(sessionId, greeting)).resolves.toEqual({
			stopReason: "end_turn",
		});
		// The baseline protects the setup UX, not IDs, envelopes or streaming chunk boundaries.
		expect(journeyText(f.updates)).toMatchInlineSnapshot(
			`"Select a model in Zed's Model picker before sending a prompt, or choose an explicit CLI preset configured in .agents/models.json. No model request or MCP connection was made."`,
		);
		expect(j.requests).toEqual([]);
		expect(j.permissions).toEqual([]);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		j.approval.decide = async () => false;
		const deniedStart = f.updates.length;
		await expect(f.prompt(sessionId, greeting)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(f.updates.slice(deniedStart))).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toEqual([]);
		j.approval.decide = async () => true;
		const greetingStart = f.updates.length;
		await expect(f.prompt(sessionId, greeting)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(f.updates.slice(greetingStart))).toContain("I am D3R");
		expect(JSON.stringify(j.requests[0].context.messages)).toContain(greeting);
		const reconStart = j.requests.length;
		await expect(f.prompt(sessionId, request)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(
			new Set(j.requests.slice(reconStart).map(({ role }) => role)),
		).toEqual(new Set(["aggregator", "researcher"]));
		for (const role of ["aggregator", "researcher"]) {
			const contexts = j.requests
				.filter((entry) => entry.role === role)
				.map(({ context }) => context);
			expect(contexts[0].systemPrompt).toContain(
				"Preserve the offline user's requirements.",
			);
			expect(JSON.stringify(contexts[0].messages)).toContain(request);
			expect(contexts[1].messages.at(-1)).toMatchObject({
				role: "toolResult",
				toolName: "read_file",
				isError: false,
			});
			expect(JSON.stringify(contexts[1].messages.at(-1))).toContain(
				"Jobs must survive restarts without a network service.",
			);
		}
		await expect(readFile(resolve(j.cwd, "design.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const beforeReload = j.requests.length;
		const permissionsBefore = j.permissions.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		expect(journeyText(resumed.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.permissions).toHaveLength(permissionsBefore);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		const answer = "Use a local queue and retain pending jobs across restarts.";
		j.approval.decide = async () => false;
		const untrustedStart = resumed.updates.length;
		await expect(resumed.prompt(sessionId, answer)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(resumed.updates.slice(untrustedStart))).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toHaveLength(beforeReload);
		await expect(readFile(resolve(j.cwd, "design.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		j.approval.decide = async () => true;
		const conflictStart = resumed.updates.length;
		const replacement = "/design Replace the queue with a lunar calendar";
		await expect(resumed.prompt(sessionId, replacement)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(resumed.updates.slice(conflictStart))).toMatch(
			/\/design[\s\S]*waiting/i,
		);
		expect(journeyText(resumed.updates.slice(conflictStart))).toMatch(
			/abandon[\s\S]*resend/i,
		);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload);
		await expect(resumed.prompt(sessionId, answer)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(await readFile(resolve(j.cwd, "design.md"), "utf8")).toBe(design);
		expect(journeyText(resumed.updates)).toContain(
			"Workflow /design completed with structured reports.",
		);
		const designer = j.requests.slice(beforeReload);
		expect(new Set(designer.map(({ role }) => role))).toEqual(
			new Set(["designer"]),
		);
		const [{ context }] = designer;
		expect(JSON.stringify(context.messages)).not.toContain(replacement);
		for (const text of [
			greeting,
			request,
			answer,
			"Existing jobs must survive restarts.",
			"A local queue meets the offline requirement.",
		]) {
			expect(JSON.stringify(context.messages)).toContain(text);
		}
		expect(
			context.tools?.find(({ name }) => name === "write_file")?.parameters,
		).toMatchObject({
			type: "object",
			required: expect.arrayContaining(["path", "content"]),
			properties: { path: { type: "string" }, content: { type: "string" } },
		});
		expect(context.tools?.map(({ name }) => name)).not.toContain("run_command");
		expect(
			j.permissions
				.slice(permissionsBefore)
				.map(({ toolCall }) => toolCall.title),
		).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^Trust workspace/),
				"write_file",
			]),
		);
		expect(resumed.updates.map(({ update }) => update)).toContainEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				status: "completed",
				content: expect.arrayContaining([
					{
						type: "diff",
						path: resolve(j.cwd, "design.md"),
						oldText: null,
						newText: design,
					},
				]),
			}),
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});

	// oxlint-disable-next-line max-statements -- Discovery, editor ownership and renewed trust belong to one persisted research journey.
	it("researches an ancestor vault from a nested worktree and reloads it without widening trust or opening search hits", async () => {
		const scripts: JourneyScripts = {};
		const editorText = "Unsaved editor brief: keep the queue local.\n";
		const j = await open(scripts, {
			workspace: "repo/worktrees/topic",
			readTextFile: async ({ path }) => {
				if (path !== resolve(j.cwd, "brief.txt")) {
					throw new Error(`Editor cannot open this file: ${path}`);
				}
				return { content: editorText };
			},
		});
		const vault = resolve(j.root, "repo/.agents/vault");
		const note = resolve(vault, "notes/queue.md");
		const prior = resolve(vault, "notes/prior.md");
		const local = resolve(j.cwd, "brief.txt");
		const source = resolve(j.cwd, "queue.ts");
		const outside = resolve(j.root, "repo/unrelated.txt");
		const diskNote =
			"# Prior design\nqueue survives restarts\nqueue needs no service\n";
		const diskBrief = "# Saved brief\nqueue disk requirement\n";
		await mkdir(resolve(vault, "notes"), { recursive: true });
		await Promise.all([
			writeFile(note, diskNote),
			writeFile(prior, "queue uses an append-only log\n"),
			writeFile(local, diskBrief),
			writeFile(source, "// queue implementation\n// queue recovery\n"),
			writeFile(outside, "Unrelated parent data must never reach the model."),
		]);
		const recon = (summary: string) => [
			journeyCall("search", { path: vault, query: "queue" }),
			journeyCall("search", { path: ".", query: "queue" }),
			journeyCall("read_file", { path: note }),
			journeyCall("read_file", { path: "brief.txt" }),
			journeyCall("read_file", { path: "../../unrelated.txt" }),
			journeyReport(summary),
			[{ type: "text" as const, text: summary }],
		];
		scripts.aggregator = recon("The vault says the queue survives restarts.");
		scripts.researcher = recon("The saved queue uses an append-only log.");
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const request =
			"/design Research the local queue; report in chat, no files needed.";
		j.approval.decide = async () => false;
		await expect(f.prompt(sessionId, request)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(f.updates)).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toEqual([]);
		expect(j.reads).toEqual([]);
		j.approval.decide = async () => true;
		await expect(f.prompt(sessionId, request)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["aggregator", "researcher"]),
		);
		const vaultHits = [
			`${note}:2: queue survives restarts`,
			`${note}:3: queue needs no service`,
			`${prior}:1: queue uses an append-only log`,
		];
		const workspaceHits = [
			`${local}:2: queue disk requirement`,
			`${source}:1: // queue implementation`,
			`${source}:2: // queue recovery`,
		];
		for (const role of ["aggregator", "researcher"]) {
			const [
				initial,
				vaultSearch,
				workspaceSearch,
				noteRead,
				localRead,
				outsideRead,
			] = j.requests
				.filter((entry) => entry.role === role)
				.map(({ context }) => context);
			expect(initial.systemPrompt).toContain(vault);
			for (const [context, hits] of [
				[vaultSearch, vaultHits],
				[workspaceSearch, workspaceHits],
			] as const) {
				expect(context.messages.at(-1)).toMatchObject({
					toolName: "search",
					isError: false,
				});
				for (const hit of hits) {
					expect(context.messages.at(-1)).toMatchObject({
						content: expect.arrayContaining([
							{ type: "text", text: expect.stringContaining(hit) },
						]),
					});
				}
				expect(JSON.stringify(context.messages.at(-1))).not.toContain(
					"Unsaved editor brief",
				);
			}
			expect(noteRead.messages.at(-1)).toMatchObject({
				toolName: "read_file",
				isError: false,
			});
			expect(JSON.stringify(noteRead.messages.at(-1))).toContain(
				"queue survives restarts",
			);
			expect(localRead.messages.at(-1)).toMatchObject({
				toolName: "read_file",
				isError: false,
			});
			expect(JSON.stringify(localRead.messages.at(-1))).toContain(
				editorText.trim(),
			);
			expect(JSON.stringify(localRead.messages.at(-1))).not.toContain(
				"queue disk requirement",
			);
			expect(outsideRead.messages.at(-1)).toMatchObject({
				toolName: "read_file",
				isError: true,
			});
		}
		expect(JSON.stringify(j.requests)).not.toContain(
			"Unrelated parent data must never reach the model.",
		);
		expect(j.reads.map(({ path }) => path)).toEqual([local, local]);
		const searches = journeyTools(f.updates).filter(
			({ kind }) => kind === "search",
		);
		expect(searches.length).toBeGreaterThan(0);
		for (const search of searches) {
			expect(search.locations ?? []).toEqual([]);
		}
		const completedSearches = searches.filter(
			({ status }) => status === "completed",
		);
		for (const hits of [vaultHits, workspaceHits]) {
			const matching = completedSearches.filter((tool) =>
				hits.every((hit) => journeyToolText(tool).includes(hit)),
			);
			expect(matching.map(({ toolCallId }) => toolCallId)).toHaveLength(
				["aggregator", "researcher"].length,
			);
		}
		expect(journeyTools(f.updates)).toContainEqual(
			expect.objectContaining({
				status: "completed",
				locations: expect.arrayContaining([{ path: local, line: 1 }]),
				content: expect.arrayContaining([
					expect.objectContaining({
						type: "content",
						content: {
							type: "text",
							text: expect.stringContaining(editorText.trim()),
						},
					}),
				]),
			}),
		);
		await expect(readFile(local, "utf8")).resolves.toBe(diskBrief);
		await expect(readFile(note, "utf8")).resolves.toBe(diskNote);
		const beforeReload = j.requests.length;
		const readsBefore = j.reads.length;
		const permissionsBefore = j.permissions.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const renewedNote = "queue reload uses the same vault on disk";
		await writeFile(note, `${diskNote}${renewedNote}\n`);
		scripts.designer = [
			journeyCall("read_file", { path: note }),
			journeyReport(renewedNote),
			[
				{
					type: "text",
					text: "Keep the local append-only queue; no design file was requested.",
				},
			],
		];
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(journeyText(resumed.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.permissions).toHaveLength(permissionsBefore);
		j.approval.decide = async () => false;
		const answer =
			"Keep the queue local. Re-read the vault note and finish with a report only.";
		const deniedStart = resumed.updates.length;
		await expect(resumed.prompt(sessionId, answer)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(resumed.updates.slice(deniedStart))).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.reads).toHaveLength(readsBefore);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		j.approval.decide = async () => true;
		await expect(resumed.prompt(sessionId, answer)).resolves.toEqual({
			stopReason: "end_turn",
		});
		const designer = j.requests.slice(beforeReload);
		expect(new Set(designer.map(({ role }) => role))).toEqual(
			new Set(["designer"]),
		);
		expect(designer[0].context.systemPrompt).toContain(vault);
		expect(JSON.stringify(designer[0].context.messages)).toContain(
			"The vault says the queue survives restarts.",
		);
		expect(JSON.stringify(designer[0].context.messages)).toContain(
			"The saved queue uses an append-only log.",
		);
		expect(designer[1].context.messages.at(-1)).toMatchObject({
			toolName: "read_file",
			isError: false,
		});
		expect(JSON.stringify(designer[1].context.messages.at(-1))).toContain(
			renewedNote,
		);
		expect(j.reads).toHaveLength(readsBefore);
		expect(journeyText(resumed.updates)).toContain(
			"Workflow /design completed with structured reports.",
		);
		for (const { toolCall } of j.permissions) {
			expect(toolCall.title).toMatch(/^Trust workspace/);
			const preview = journeyToolText(toolCall);
			for (const text of [
				JSON.stringify(j.cwd),
				JSON.stringify(vault),
				"not its parent directory",
				"disk IO, not editor buffers",
				"Writes still require separate approval",
				"Trust is not saved",
			]) {
				expect(preview).toContain(text);
			}
		}
		expect(j.permissions.slice(permissionsBefore)).toHaveLength(
			["denied", "allowed"].length,
		);
		await expect(readFile(local, "utf8")).resolves.toBe(diskBrief);
		await expect(readFile(outside, "utf8")).resolves.toBe(
			"Unrelated parent data must never reach the model.",
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});

	// oxlint-disable-next-line max-statements -- Template discovery, held publication and a fresh role's read form one acceptance journey.
	it("writes remember.md from the real parent vault template and reads it after a fresh /design session load", async () => {
		const scripts: JourneyScripts = {};
		const j = await open(scripts, {
			workspace: "repo/worktrees/topic",
			readTextFile: async ({ path }) => {
				if (path !== resolve(j.cwd, "brief.txt")) {
					throw new Error(`Zed refuses out-of-root reads: ${path}`);
				}
				return { content: "Unsaved brief: preserve offline jobs." };
			},
		});
		const vault = resolve(j.root, "repo/.agents/vault");
		await cp(SEED_ROOT, vault, { recursive: true });
		const templatePath = ".misc/templates/remember.md";
		const pageSize = 256;
		const template = await readFile(resolve(vault, templatePath), "utf8");
		const priorPath = ".misc/archive/prior-queue.md";
		const prior = "Prior queue fact: jobs survive restarts.\n";
		const outside = resolve(j.root, "repo/.agents/outside.txt");
		const sentinel = "PRIVATE outside-vault sentinel must never reach a model";
		await mkdir(resolve(vault, ".git"));
		await Promise.all([
			writeFile(resolve(vault, priorPath), prior),
			writeFile(outside, sentinel),
			writeFile(resolve(vault, ".git/private.txt"), sentinel),
			writeFile(
				resolve(j.cwd, "brief.txt"),
				"Saved brief, not the editor buffer.",
			),
		]);
		const artifact = "process/designs/offline-queue/recon/remember.md";
		const parent = resolve(vault, "process/designs/offline-queue");
		const body =
			"# Remember: offline-queue\n\n## 1. Prior behavior\n\n**Source:** [[.misc/archive/prior-queue]]\n\nJobs survive restarts.\n";
		const document = `---\ncreated: 2026-09-09\nstatus: draft\nkind: remember\n---\n${body}`;
		scripts.aggregator = [
			journeyCall(
				"vault_read",
				{ path: templatePath, limit: pageSize },
				"template-first",
			),
			(context) =>
				journeyCall(
					"vault_read",
					{
						path: templatePath,
						offset: journeyPage(context, "template-first").nextOffset,
					},
					"template-rest",
				),
			journeyCall("vault_ls", { path: ".misc" }),
			journeyCall("vault_find", {
				glob: ".misc/archive/**",
				query: "Prior queue fact",
			}),
			journeyCall("vault_read", { path: priorPath }, "prior"),
			journeyCall("read_file", { path: "brief.txt" }),
			journeyCall("vault_write", {
				mode: "doc",
				path: artifact,
				kind: "remember",
				frontmatter: { created: "2026-09-09", status: "draft" },
				body,
			}),
			journeyReport(`Saved factual recon in ${artifact}.`),
			[{ type: "text", text: "Remember artifact saved in the vault." }],
		];
		scripts.researcher = [
			journeyCall("vault_read", { path: templatePath }, "research-template"),
			(context) =>
				journeyCall(
					"vault_edit",
					{
						path: templatePath,
						find: "Remember",
						replace: "Tampered",
						snapshot: journeyPage(context, "research-template").snapshot,
					},
					"forbidden-edit",
				),
			[
				...journeyCall("vault_read", { path: outside }, "absolute-read"),
				...journeyCall(
					"vault_read",
					{ path: "../outside.txt" },
					"traversal-read",
				),
				...journeyCall(
					"vault_read",
					{ path: ".git/private.txt" },
					"private-read",
				),
				...journeyCall(
					"vault_read",
					{ path: "outside.txt", root: resolve(vault, "..") },
					"root-read",
				),
			],
			journeyReport(
				"Research used the real remember template without modifying it.",
			),
			[{ type: "text", text: "Research complete." }],
		];
		scripts.designer = [
			journeyCall("vault_read", { path: artifact }, "remember-reloaded"),
			journeyCall("vault_lint", { paths: [artifact] }),
			journeyReport(
				"Used the saved remember artifact to design the offline queue.",
			),
			[{ type: "text", text: "Design complete using the persisted recon." }],
		];
		const asked = deferred<RequestPermissionRequest>();
		const answer = deferred<boolean>();
		j.approval.decide = async (permission) => {
			if (permission.toolCall.title?.startsWith("Trust workspace")) {
				return true;
			}
			asked.resolve(permission);
			return answer.promise;
		};
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const pending = f.prompt(
			sessionId,
			"/design Read .misc/templates/remember.md with vault_read and save factual recon as process/designs/offline-queue/recon/remember.md in the vault.",
		);
		try {
			const permission = await Promise.race([
				asked.promise,
				pending.then(() => {
					throw new Error("Design ended without vault write approval");
				}),
			]);
			expect(permission.toolCall.title).toBe("vault_write");
			expect(journeyToolText(permission.toolCall)).toContain(artifact);
			expect(journeyToolText(permission.toolCall)).toContain("remember");
			await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(resolve(vault, artifact))).rejects.toMatchObject({
				code: "ENOENT",
			});
			await f.peer.agent.request("session/list", {});
			await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
			answer.resolve(true);
			await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		} finally {
			answer.resolve(false);
			await f.peer.agent.notify("session/cancel", { sessionId });
			await pending;
		}
		await expect(readFile(resolve(vault, artifact), "utf8")).resolves.toBe(
			document,
		);
		expect(journeyTools(f.updates)).toContainEqual(
			expect.objectContaining({
				status: "completed",
				content: expect.arrayContaining([
					{
						type: "diff",
						path: resolve(vault, artifact),
						oldText: null,
						newText: document,
					},
				]),
			}),
		);
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		const aggregator = j.requests.findLast(
			({ role }) => role === "aggregator",
		)!.context;
		const researcher = j.requests.findLast(
			({ role }) => role === "researcher",
		)!.context;
		const first = journeyPage(aggregator, "template-first");
		const rest = journeyPage(aggregator, "template-rest");
		expect(first).toMatchObject({
			path: templatePath,
			text: template.slice(0, pageSize),
			truncated: true,
			nextOffset: pageSize,
			snapshot: expect.any(String),
		});
		expect(rest).toMatchObject({
			path: templatePath,
			truncated: false,
			snapshot: first.snapshot,
		});
		expect(first.text + rest.text).toBe(template);
		expect(journeyPage(researcher, "research-template").text).toBe(template);
		expect(journeyPage(aggregator, "prior").text).toBe(prior);
		for (const [id, text] of [
			["vault_ls", "templates"],
			["vault_find", priorPath],
		]) {
			expect(journeyResult(aggregator, id)).toMatchObject({ isError: false });
			expect(JSON.stringify(journeyResult(aggregator, id))).toContain(text);
		}
		expect(JSON.stringify(journeyResult(aggregator, "read_file"))).toContain(
			"Unsaved brief",
		);
		for (const id of [
			"forbidden-edit",
			"absolute-read",
			"traversal-read",
			"private-read",
			"root-read",
		]) {
			expect(journeyResult(researcher, id), id).toMatchObject({
				isError: true,
			});
		}
		expect(researcher.tools?.map(({ name }) => name)).not.toContain(
			"vault_edit",
		);
		expect(aggregator.tools?.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"vault_read",
				"vault_ls",
				"vault_find",
				"vault_write",
				"vault_mv",
				"vault_rm",
				"vault_lint",
			]),
		);
		expect(
			aggregator.tools?.find(({ name }) => name === "vault_write")?.parameters,
		).toMatchObject({
			type: "object",
			required: expect.arrayContaining(["mode", "path"]),
			properties: {
				mode: { enum: expect.arrayContaining(["raw", "doc"]) },
				path: { type: "string" },
				contents: { type: "string" },
				kind: { type: "string" },
				body: { type: "string" },
				frontmatter: { type: "object" },
				snapshot: { type: "string" },
			},
		});
		const beforeReload = j.requests.length;
		const permissionsBefore = j.permissions.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.permissions).toHaveLength(permissionsBefore);
		j.approval.decide = async () => true;
		await expect(
			resumed.prompt(
				sessionId,
				"Use the saved remember.md; finish the design in chat.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const designer = j.requests.findLast(
			({ role }) => role === "designer",
		)!.context;
		expect(journeyPage(designer, "remember-reloaded")).toMatchObject({
			path: artifact,
			text: document,
			truncated: false,
		});
		const lint = journeyResult(designer, "vault_lint");
		expect(lint).toMatchObject({ isError: false });
		if (lint?.role !== "toolResult") {
			throw new Error("Missing vault lint result");
		}
		const lintText = lint.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("");
		expect(JSON.parse(lintText)).toMatchObject({
			findings: [{ path: artifact, kind: "remember", ok: true }],
			summary: { total: 1, ok: 1, failed: 0 },
			truncated: false,
			skipped: 0,
		});
		expect(journeyText(resumed.updates)).toContain(
			"Workflow /design completed with structured reports.",
		);
		expect(
			j.permissions
				.slice(permissionsBefore)
				.map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		for (const { context } of j.requests) {
			expect(context.systemPrompt).toContain(vault);
			expect(context.systemPrompt).toMatch(/vault-relative paths/);
			expect(context.tools?.map(({ name }) => name)).not.toContain(
				"vault_init",
			);
			const calls = context.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((part) => part.type === "toolCall")
					: [],
			);
			expect(calls.map(({ name }) => name)).not.toContain("run_command");
		}
		expect(
			JSON.stringify([j.requests, f.updates, resumed.updates]),
		).not.toContain(sentinel);
		expect(j.reads.map(({ path }) => path)).toEqual([
			resolve(j.cwd, "brief.txt"),
		]);
		await expect(readFile(resolve(vault, templatePath), "utf8")).resolves.toBe(
			template,
		);
		await expect(readFile(outside, "utf8")).resolves.toBe(sentinel);
		await expect(
			readFile(resolve(vault, ".git/private.txt"), "utf8"),
		).resolves.toBe(sentinel);
		await expect(readFile(resolve(j.cwd, artifact))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			readdir(resolve(j.cwd, ".agents/vault")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});

	it.each(["denied", "cancelled"] as const)(
		"recovers a %s vault mutation on /develop reload and protects an external edit with real read snapshots",
		// oxlint-disable-next-line max-statements -- Approval failure, fresh pin and snapshot-safe recovery must share the same real workflow.
		async (failure) => {
			const scripts: JourneyScripts = {};
			const j = await open(scripts, {
				workspace: "repo/worktrees/topic",
				readTextFile: async ({ path }) => {
					throw new Error(
						`Zed cannot open vault files outside the worktree: ${path}`,
					);
				},
			});
			const vault = resolve(j.root, "repo/.agents/vault");
			await cp(SEED_ROOT, vault, { recursive: true });
			const note = "notes/queue.md";
			const original = "# Queue\nState: pending\n";
			const external = `${original}User added this line during approval.\n`;
			const edited = external.replace("pending", "ready");
			const artifact = "process/tasks/offline-queue/implementation-log.md";
			const parent = resolve(vault, "process/tasks/offline-queue");
			const contents = "# Implementation log\nQueue is ready.\n";
			const sentinel = "PRIVATE mutation sentinel must remain untouched";
			const outside = resolve(vault, "../outside.txt");
			await mkdir(resolve(vault, ".git"));
			await Promise.all([
				writeFile(resolve(vault, note), original),
				writeFile(
					resolve(vault, "notes/occupied.md"),
					"Existing destination\n",
				),
				writeFile(outside, sentinel),
				writeFile(resolve(vault, ".git/private.txt"), sentinel),
			]);
			const write = journeyCall(
				"vault_write",
				{ mode: "raw", path: artifact, contents },
				"publish-log",
			);
			scripts.implementor = [
				journeyCall("vault_read", { path: note }, "before-denial"),
				write,
				journeyReport("Vault write was not authorized.", { status: "blocked" }),
				[{ type: "text", text: "No vault mutation was made." }],
			];
			const asked = deferred<RequestPermissionRequest>();
			const answer = deferred<boolean>();
			j.approval.decide = async (permission) => {
				if (permission.toolCall.title?.startsWith("Trust workspace")) {
					return true;
				}
				asked.resolve(permission);
				return answer.promise;
			};
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const request =
				"/develop Update the saved queue note and write an implementation log in the parent vault.";
			await expect(f.prompt(sessionId, request)).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(journeyText(f.updates)).toContain("Choose develop mode");
			const pending = f.prompt(sessionId, "auto");
			try {
				const permission = await Promise.race([
					asked.promise,
					pending.then(() => {
						throw new Error("Develop ended without vault write approval");
					}),
				]);
				expect(permission.toolCall.title).toBe("vault_write");
				expect(journeyToolText(permission.toolCall)).toContain(artifact);
				expect(journeyToolText(permission.toolCall)).toContain(
					JSON.stringify(contents),
				);
				await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(readFile(resolve(vault, artifact))).rejects.toMatchObject({
					code: "ENOENT",
				});
				if (failure === "cancelled") {
					await f.peer.agent.notify("session/cancel", { sessionId });
				} else {
					answer.resolve(false);
				}
				await expect(pending).resolves.toEqual({
					stopReason: failure === "cancelled" ? "cancelled" : "end_turn",
				});
				// A late allow must not revive a cancelled publication or create its parents.
				answer.resolve(true);
				await f.peer.agent.request("session/list", {});
				await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
					original,
				);
			} finally {
				answer.resolve(false);
				await f.peer.agent.notify("session/cancel", { sessionId });
				await pending;
			}
			const initial = j.requests.findLast(
				({ role }) => role === "implementor",
			)!.context;
			expect(journeyPage(initial, "before-denial").text).toBe(original);
			if (failure === "denied") {
				expect(journeyResult(initial, "publish-log")).toMatchObject({
					isError: true,
				});
				expect(JSON.stringify(journeyResult(initial, "publish-log"))).toMatch(
					/permission.*denied/i,
				);
			}
			expect(
				journeyTools(f.updates).filter(
					({ status, kind }) => status === "completed" && kind === "edit",
				),
			).toEqual([]);
			const beforeReload = j.requests.length;
			const permissionsBefore = j.permissions.length;
			await f.close();
			const resumed = await j.connect();
			await resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			});
			expect(j.requests).toHaveLength(beforeReload);
			expect(j.permissions).toHaveLength(permissionsBefore);
			await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
			j.approval.decide = async () => true;
			await expect(resumed.prompt(sessionId, "continue")).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(j.requests).toHaveLength(beforeReload);
			scripts.implementor = [
				journeyCall("vault_read", { path: note }, "stale-read"),
				(context) =>
					journeyCall(
						"vault_edit",
						{
							path: note,
							find: "pending",
							replace: "ready",
							snapshot: journeyPage(context, "stale-read").snapshot,
						},
						"stale-edit",
					),
				journeyCall("vault_read", { path: note }, "fresh-read"),
				(context) =>
					journeyCall(
						"vault_edit",
						{
							path: note,
							find: "pending",
							replace: "ready",
							snapshot: journeyPage(context, "fresh-read").snapshot,
						},
						"fresh-edit",
					),
				journeyCall("vault_read", { path: note }, "edited-read"),
				(context) => {
					const { snapshot } = journeyPage(context, "edited-read");
					return [
						...journeyCall(
							"vault_write",
							{
								mode: "raw",
								path: note,
								contents: "Clobbered without a snapshot",
							},
							"missing-snapshot",
						),
						...journeyCall(
							"vault_mv",
							{ from: note, to: "notes/occupied.md", snapshot },
							"occupied-move",
						),
						...journeyCall(
							"vault_mv",
							{
								from: note,
								to: "notes/occupied.md",
								snapshot,
								overwrite: true,
							},
							"overwrite-move",
						),
						...journeyCall(
							"vault_mv",
							{ from: "notes", to: "moved-notes", snapshot },
							"directory-move",
						),
						...journeyCall(
							"vault_rm",
							{ path: "notes", snapshot },
							"directory-remove",
						),
						...journeyCall(
							"vault_rm",
							{ path: "notes", snapshot, recursive: true },
							"recursive-remove",
						),
						...journeyCall(
							"vault_write",
							{
								mode: "raw",
								path: resolve(vault, "../absolute-escape/new.md"),
								contents: "Escaped",
							},
							"absolute-write",
						),
						...journeyCall(
							"vault_write",
							{
								mode: "raw",
								path: "../traversal-escape/new.md",
								contents: "Escaped",
							},
							"traversal-write",
						),
						...journeyCall(
							"vault_write",
							{
								mode: "raw",
								path: ".git/private-escape/new.md",
								contents: "Escaped",
							},
							"private-write",
						),
						...journeyCall(
							"vault_write",
							{
								mode: "raw",
								path: "root-escape/new.md",
								root: resolve(vault, ".."),
								contents: "Escaped",
							},
							"root-write",
						),
					];
				},
				write,
				journeyReport(
					"Updated the queue note without losing the user's external edit.",
				),
				[{ type: "text", text: "Implementation complete." }],
			];
			scripts.reviewer = [
				journeyCall("vault_read", { path: note }, "review-note"),
				journeyCall("vault_read", { path: artifact }, "review-log"),
				journeyReport("Verified both saved vault artifacts.", {
					review: "approved",
				}),
				[{ type: "text", text: "Review approved." }],
			];
			scripts.auditor = [
				journeyCall("vault_read", { path: note }, "audit-note"),
				journeyReport("The external edit is preserved on disk."),
				[{ type: "text", text: "Audit complete." }],
			];
			if (failure === "cancelled") {
				await resumed.prompt(sessionId, "abandon");
				await resumed.prompt(sessionId, request);
			}
			const editAsked = deferred<RequestPermissionRequest>();
			const editAnswer = deferred<boolean>();
			j.approval.decide = async (permission) => {
				if (permission.toolCall.title !== "vault_edit") {
					return true;
				}
				editAsked.resolve(permission);
				return editAnswer.promise;
			};
			const recovery = resumed.prompt(
				sessionId,
				failure === "denied" ? "restart" : "auto",
			);
			try {
				const permission = await Promise.race([
					editAsked.promise,
					recovery.then(() => {
						throw new Error("Recovery ended without snapshot edit approval");
					}),
				]);
				expect(permission.toolCall.title).toBe("vault_edit");
				expect(journeyToolText(permission.toolCall)).toContain(note);
				await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
					original,
				);
				await writeFile(resolve(vault, note), external);
				editAnswer.resolve(true);
				await expect(recovery).resolves.toEqual({ stopReason: "end_turn" });
			} finally {
				editAnswer.resolve(false);
				await resumed.peer.agent.notify("session/cancel", { sessionId });
				await recovery;
			}
			const implementor = j.requests.findLast(
				({ role }) => role === "implementor",
			)!.context;
			const reviewer = j.requests.findLast(
				({ role }) => role === "reviewer",
			)!.context;
			const auditor = j.requests.findLast(
				({ role }) => role === "auditor",
			)!.context;
			expect(journeyPage(implementor, "stale-read").text).toBe(original);
			expect(journeyResult(implementor, "stale-edit")).toMatchObject({
				isError: true,
			});
			expect(JSON.stringify(journeyResult(implementor, "stale-edit"))).toMatch(
				/snapshot|changed|stale/i,
			);
			expect(journeyPage(implementor, "fresh-read").text).toBe(external);
			expect(journeyPage(implementor, "fresh-read").snapshot).not.toBe(
				journeyPage(implementor, "stale-read").snapshot,
			);
			expect(journeyResult(implementor, "fresh-edit")).toMatchObject({
				isError: false,
			});
			expect(journeyPage(implementor, "edited-read").text).toBe(edited);
			for (const id of [
				"missing-snapshot",
				"occupied-move",
				"overwrite-move",
				"directory-move",
				"directory-remove",
				"recursive-remove",
				"absolute-write",
				"traversal-write",
				"private-write",
				"root-write",
			]) {
				expect(journeyResult(implementor, id), id).toMatchObject({
					isError: true,
				});
			}
			expect(journeyPage(reviewer, "review-note").text).toBe(edited);
			expect(journeyPage(reviewer, "review-log").text).toBe(contents);
			expect(journeyPage(auditor, "audit-note").text).toBe(edited);
			for (const context of [initial, implementor]) {
				expect(context.systemPrompt).toContain(vault);
				expect(context.systemPrompt).toMatch(/vault-relative paths/);
				expect(context.tools?.map(({ name }) => name)).toEqual(
					expect.arrayContaining([
						"vault_read",
						"vault_ls",
						"vault_find",
						"vault_write",
						"vault_edit",
						"vault_mv",
						"vault_rm",
						"vault_lint",
					]),
				);
				expect(context.tools?.map(({ name }) => name)).not.toContain(
					"vault_init",
				);
				for (const name of ["vault_edit", "vault_mv", "vault_rm"]) {
					expect(
						context.tools?.find((tool) => tool.name === name)?.parameters,
					).toMatchObject({ required: expect.arrayContaining(["snapshot"]) });
				}
			}
			for (const tool of initial.tools?.filter(({ name }) =>
				name.startsWith("vault_"),
			) ?? []) {
				expect(
					implementor.tools?.find(({ name }) => name === tool.name)?.parameters,
				).toEqual(tool.parameters);
			}
			expect(
				j.permissions
					.slice(permissionsBefore)
					.map(({ toolCall }) => toolCall.title),
			).toContainEqual(expect.stringMatching(/^Trust workspace/));
			const effects = journeyTools(resumed.updates)
				.filter(({ status }) => status === "completed")
				.flatMap(
					({ content }) =>
						content?.filter((part) => part.type === "diff") ?? [],
				);
			expect(effects).toEqual(
				expect.arrayContaining([
					{
						type: "diff",
						path: resolve(vault, note),
						oldText: external,
						newText: edited,
					},
					{
						type: "diff",
						path: resolve(vault, artifact),
						oldText: null,
						newText: contents,
					},
				]),
			);
			expect(effects).toHaveLength([note, artifact].length);
			await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
				edited,
			);
			await expect(readFile(resolve(vault, artifact), "utf8")).resolves.toBe(
				contents,
			);
			await expect(
				readFile(resolve(vault, "notes/occupied.md"), "utf8"),
			).resolves.toBe("Existing destination\n");
			await expect(readFile(outside, "utf8")).resolves.toBe(sentinel);
			await expect(
				readFile(resolve(vault, ".git/private.txt"), "utf8"),
			).resolves.toBe(sentinel);
			await expect(
				readdir(resolve(vault, "moved-notes")),
			).rejects.toMatchObject({ code: "ENOENT" });
			await Promise.all(
				[
					"../absolute-escape",
					"../traversal-escape",
					".git/private-escape",
					"../root-escape",
					"root-escape",
				].map(async (path) => {
					await expect(readdir(resolve(vault, path))).rejects.toMatchObject({
						code: "ENOENT",
					});
				}),
			);
			await expect(readFile(resolve(j.cwd, artifact))).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(j.reads).toEqual([]);
			expect(
				JSON.stringify([j.requests, f.updates, resumed.updates]),
			).not.toContain(sentinel);
			expect(journeyText(resumed.updates)).toContain(
				"Workflow /develop completed with structured reports.",
			);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
			await resumed.peer.agent.request("session/close", { sessionId });
		},
	);

	it.each(["allowed", "denied", "cancelled"] as const)(
		"shows concise command approval before a real process is %s",
		// oxlint-disable-next-line max-statements -- Keep the pending permission, process effect and workflow outcome together.
		async (decision) => {
			const markerName = "marker file.txt";
			const literal = "literal value with spaces & no shell";
			const input = Object.freeze({
				command: process.execPath,
				args: Object.freeze([
					"-e",
					"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() })); console.log(process.argv[2]);",
					markerName,
					literal,
					"",
					"single'quote",
					'double"quote',
					String.raw`a\b`,
					"first\nsecond",
					"$(touch should-not-exist)",
					"last-safe-word",
				]),
				cwd: "command cwd",
				timeoutMs: 10_000,
			});
			const scripts: JourneyScripts = {
				aggregator: [
					journeyCall("run_command", input),
					journeyReport(
						decision === "allowed"
							? "The local probe completed."
							: "The local probe was not authorized.",
					),
					[{ type: "text", text: "Recon finished without further commands." }],
				],
				researcher: [
					journeyReport("No external research was needed."),
					[{ type: "text", text: "Research complete." }],
				],
				designer: [
					journeyReport("Use the local queue."),
					[{ type: "text", text: "Design complete in chat." }],
				],
			};
			const j = await open(scripts);
			const cwd = resolve(j.cwd, input.cwd);
			const marker = resolve(cwd, markerName);
			await mkdir(cwd);
			const asked = deferred<RequestPermissionRequest>();
			const answer = deferred<boolean>();
			j.approval.decide = async (permission) => {
				if (permission.toolCall.title?.startsWith("Trust workspace")) {
					return true;
				}
				asked.resolve(permission);
				return answer.promise;
			};
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const pending = f.prompt(
				sessionId,
				"/design Probe the local queue; a chat report is sufficient.",
			);
			try {
				const permission = await Promise.race([
					asked.promise,
					pending.then(() => {
						throw new Error("Turn ended without requesting command permission");
					}),
				]);
				const preview = journeyToolText(permission.toolCall);
				const block =
					/^(`{3,})[^\n]*\n(?<line>[^\n]+)\n(?<cwdLine>[^\n]+)\n\1$/.exec(
						preview,
					);
				expect(
					block,
					"Only the full command and compact cwd should be displayed",
				).not.toBeNull();
				const { line, cwdLine } = block!.groups!;
				const executable = /^[A-Za-z0-9_./:-]+$/.test(input.command)
					? input.command
					: `'${input.command.replaceAll("'", String.raw`'\''`)}'`;
				expect(line.startsWith(`${executable} -e `)).toBe(true);
				expect(line).toContain("process.argv.slice(1)");
				expect(
					line.endsWith(
						String.raw`'marker file.txt' 'literal value with spaces & no shell' '' 'single'\''quote' 'double"quote' 'a\b' $'first\nsecond' '$(touch should-not-exist)' last-safe-word`,
					),
				).toBe(true);
				expect(cwdLine).toBe(
					`# cwd: '${cwd.replaceAll("'", String.raw`'\''`)}'`,
				);
				expect(preview).not.toMatch(
					/run_command:|UNSANDBOXED|wrappers|Executable:|Literal argv:|timeout/i,
				);
				expect(permission.toolCall.rawInput).toEqual({ ...input, cwd });

				const { title } = permission.toolCall;
				expect(title!.startsWith(`${executable} -e `)).toBe(true);
				const titleLimit = 100;
				expect(title!.length).toBeLessThanOrEqual(titleLimit);
				expect(line.startsWith(title!.replace(/\.\.\.$/, ""))).toBe(true);
				const initial = journeyTools(f.updates).find(
					({ toolCallId }) => toolCallId === permission.toolCall.toolCallId,
				)!;
				expect(initial.title).toBe(title);
				expect(journeyToolText(initial).split("\n").slice(1, -1)).toEqual([
					line,
					"# requested cwd: 'command cwd'",
				]);
				expect(initial.rawInput).toEqual(input);
				await expect(readFile(marker)).rejects.toMatchObject({
					code: "ENOENT",
				});
				// A protocol round trip leaves the permission pending; only this role must wait.
				await f.peer.agent.request("session/list", {});
				expect(
					j.requests.filter(({ role }) => role === "aggregator"),
				).toHaveLength(1);
				await expect(readFile(marker)).rejects.toMatchObject({
					code: "ENOENT",
				});
				if (decision === "cancelled") {
					await f.peer.agent.notify("session/cancel", { sessionId });
				} else {
					answer.resolve(decision === "allowed");
				}
				await expect(pending).resolves.toEqual({
					stopReason: decision === "cancelled" ? "cancelled" : "end_turn",
				});
				if (decision === "cancelled") {
					// Even a late approval cannot revive the cancelled process.
					answer.resolve(true);
					await f.peer.agent.request("session/list", {});
					expect(
						j.requests.filter(({ role }) => role === "aggregator"),
					).toHaveLength(1);
				} else {
					const result = j.requests
						.filter(({ role }) => role === "aggregator")[1]
						.context.messages.at(-1);
					expect(result).toMatchObject({
						toolName: "run_command",
						isError: decision !== "allowed",
					});
					const completed = journeyTools(f.updates).findLast(
						({ toolCallId }) => toolCallId === permission.toolCall.toolCallId,
					)!;
					expect(completed.title).toBe(title);
					expect(journeyToolText(completed)).toContain(preview);
					expect(completed.status).toBe(
						decision === "allowed" ? "completed" : "failed",
					);
					if (decision === "allowed") {
						// The raw tool payload, never parsed preview text, is the execution oracle.
						const observed = JSON.parse(await readFile(marker, "utf8"));
						const nodeEvalArgCount = 2;
						expect(observed).toEqual({
							argv: input.args.slice(nodeEvalArgCount),
							cwd,
						});
						expect(completed.rawInput).toEqual(input);
						expect(JSON.stringify(result)).toContain(literal);
						expect(journeyToolText(completed)).toContain(`${literal}\n`);
						expect(journeyToolText(completed)).toContain("Exit code: 0");
					} else {
						expect(JSON.stringify(result)).toMatch(/permission.*denied/i);
					}
					expect(journeyText(f.updates)).toContain(
						"Discuss design questions before drafting",
					);
					await expect(
						f.prompt(
							sessionId,
							"Finish with a chat report; do not run more commands.",
						),
					).resolves.toEqual({ stopReason: "end_turn" });
					expect(journeyText(f.updates)).toContain(
						"Workflow /design completed with structured reports.",
					);
					expect(
						Object.values(scripts).every((steps) => steps.length === 0),
					).toBe(true);
				}
			} finally {
				answer.resolve(false);
				await f.peer.agent.notify("session/cancel", { sessionId });
				await pending;
			}
			if (decision !== "allowed") {
				await expect(readFile(marker)).rejects.toMatchObject({
					code: "ENOENT",
				});
			}
			await expect(
				readFile(resolve(cwd, "should-not-exist")),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				j.permissions.filter(
					({ toolCall }) =>
						(toolCall.rawInput as { command?: unknown } | undefined)
							?.command === input.command,
				),
			).toHaveLength(1);
			await f.peer.agent.request("session/close", { sessionId });
		},
	);

	it.each(["denied", "cancelled"] as const)(
		"recovers a %s /develop write without replay, then implements, reviews and audits through real tools",
		// oxlint-disable-next-line max-statements -- Failure, persisted recovery and successful retry are one acceptance journey.
		async (failure) => {
			const content = "Durable offline jobs\n";
			const write = journeyCall("write_file", { path: "queue.txt", content });
			const scripts: JourneyScripts = {
				implementor: [
					journeyCall("write_file", { path: 42, content }),
					write,
					journeyReport(
						"Write permission was denied; no implementation was made.",
						{ status: "blocked" },
					),
					[{ type: "text", text: "The write was not authorized." }],
				],
			};
			const j = await open(scripts);
			const asked = deferred<RequestPermissionRequest>();
			const answer = deferred<boolean>();
			j.approval.decide = async (permission) => {
				if (permission.toolCall.title?.startsWith("Trust workspace")) {
					return true;
				}
				asked.resolve(permission);
				return answer.promise;
			};
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const request = "/develop Create queue.txt for durable offline jobs";
			await expect(f.prompt(sessionId, request)).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(journeyText(f.updates)).toContain("Choose develop mode");
			expect(j.requests).toEqual([]);
			const pending = f.prompt(sessionId, "auto");
			try {
				const permission = await Promise.race([
					asked.promise,
					pending.then(() => {
						throw new Error("Turn ended without requesting write permission");
					}),
				]);
				expect(permission.toolCall.title).toBe("write_file");
				expect(journeyToolText(permission.toolCall)).toContain("queue.txt");
				expect(journeyToolText(permission.toolCall)).toContain(
					JSON.stringify(content),
				);
				expect(
					j.permissions.filter(
						({ toolCall }) => toolCall.title === "write_file",
					),
				).toHaveLength(1);
				expect(j.requests.at(-1)?.context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "write_file",
					isError: true,
				});
				await expect(
					readFile(resolve(j.cwd, "queue.txt")),
				).rejects.toMatchObject({ code: "ENOENT" });
				if (failure === "cancelled") {
					await f.peer.agent.notify("session/cancel", { sessionId });
				} else {
					answer.resolve(false);
				}
				await expect(pending).resolves.toEqual({
					stopReason: failure === "cancelled" ? "cancelled" : "end_turn",
				});
			} finally {
				answer.resolve(false);
				await f.peer.agent.notify("session/cancel", { sessionId });
				await pending;
			}
			await expect(readFile(resolve(j.cwd, "queue.txt"))).rejects.toMatchObject(
				{ code: "ENOENT" },
			);
			if (failure === "denied") {
				expect(journeyText(f.updates)).toContain("Write permission was denied");
				expect(j.requests.at(-1)?.context.messages.at(-1)).toMatchObject({
					toolName: "d3r_report",
					isError: false,
				});
			}
			const beforeReload = j.requests.length;
			await f.close();
			j.approval.decide = async () => true;
			const resumed = await j.connect();
			await resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			});
			const checkpoint = await resumed.checkpoint(sessionId);
			const replacement =
				"/develop Replace all local jobs with a cloud service";
			const conflictStart = resumed.updates.length;
			await expect(resumed.prompt(sessionId, replacement)).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(journeyText(resumed.updates.slice(conflictStart))).toMatch(
				/abandon[\s\S]*resend/i,
			);
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			await expect(resumed.prompt(sessionId, "continue")).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(j.requests).toHaveLength(beforeReload);
			await expect(readFile(resolve(j.cwd, "queue.txt"))).rejects.toMatchObject(
				{ code: "ENOENT" },
			);
			scripts.implementor = [
				write,
				journeyReport("Created queue.txt for durable offline jobs."),
				[{ type: "text", text: "Implementation ready." }],
			];
			scripts.reviewer = [
				journeyCall("read_file", { path: "queue.txt" }),
				journeyReport("Verified queue.txt contents.", { review: "approved" }),
				[{ type: "text", text: "Review approved." }],
			];
			scripts.auditor = [
				journeyCall("read_file", { path: "queue.txt" }),
				journeyReport("Audited the durable queue."),
				[{ type: "text", text: "Audit complete." }],
			];
			const recoveryUpdates = resumed.updates.length;
			if (failure === "denied") {
				await expect(resumed.prompt(sessionId, "restart")).resolves.toEqual({
					stopReason: "end_turn",
				});
			} else {
				await expect(resumed.prompt(sessionId, "abandon")).resolves.toEqual({
					stopReason: "end_turn",
				});
				expect(j.requests).toHaveLength(beforeReload);
				await expect(resumed.prompt(sessionId, request)).resolves.toEqual({
					stopReason: "end_turn",
				});
				await expect(resumed.prompt(sessionId, "auto")).resolves.toEqual({
					stopReason: "end_turn",
				});
			}
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(content);
			expect(journeyText(resumed.updates.slice(recoveryUpdates))).toContain(
				"Workflow /develop completed with structured reports.",
			);
			const recovery = j.requests.slice(beforeReload);
			const progression = recovery
				.map(({ role }) => role)
				.filter(
					(role, index, roles) => index === 0 || role !== roles[index - 1],
				);
			expect(progression).toEqual(["implementor", "reviewer", "auditor"]);
			for (const { context } of recovery) {
				expect(JSON.stringify(context.messages)).toContain(request);
				expect(JSON.stringify(context.messages)).not.toContain(replacement);
			}
			for (const role of ["reviewer", "auditor"]) {
				const contexts = recovery
					.filter((entry) => entry.role === role)
					.map(({ context }) => context);
				expect(JSON.stringify(contexts[0].messages)).toContain(request);
				expect(JSON.stringify(contexts[0].messages)).toContain(
					"Created queue.txt for durable offline jobs.",
				);
				expect(contexts[1].messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "read_file",
					isError: false,
				});
				expect(JSON.stringify(contexts[1].messages.at(-1))).toContain(
					content.trim(),
				);
			}
			const effects = resumed.updates
				.slice(recoveryUpdates)
				.flatMap(({ update }) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "completed"
						? (update.content?.filter((part) => part.type === "diff") ?? [])
						: [],
				);
			expect(effects).toEqual([
				{
					type: "diff",
					path: resolve(j.cwd, "queue.txt"),
					oldText: null,
					newText: content,
				},
			]);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
			await resumed.peer.agent.request("session/close", { sessionId });
		},
	);
});
