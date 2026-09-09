import {
	client,
	type RequestPermissionRequest,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	mkdir,
	mkdtemp,
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
type JourneyScripts = Record<string, JourneyMessage["content"][]>;
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
): JourneyMessage["content"] => [
	{ type: "toolCall", id: name, name, arguments: args },
];
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

/** Offline journeys exercise D3R, not binary launch, Zed rendering, live auth or model judgment. */
describe("native ACP shipped-workflow journeys", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const open = async (scripts: JourneyScripts) => {
		const root = await mkdtemp(
			resolve(await realpath(tmpdir()), "d3r-acp-journey-"),
		);
		directories.push(root);
		const home = resolve(root, "home");
		const cwd = resolve(root, "workspace");
		await Promise.all([mkdir(home), mkdir(cwd)]);
		await writeFile(
			resolve(cwd, "AGENTS.md"),
			"Preserve the offline user's requirements.",
		);
		const requests: { role: string; context: JourneyContext }[] = [];
		const permissions: RequestPermissionRequest[] = [];
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
			return journeyStream(content);
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
			const f = fixture(deps.createSession, async () => {}, {
				deps,
				clientApp: client().onRequest(
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
				),
			});
			cleanup.push(f.close);
			await f.initialize();
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
		return { cwd, requests, permissions, approval, connect };
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
				content: [
					{
						type: "diff",
						path: resolve(j.cwd, "design.md"),
						oldText: null,
						newText: design,
					},
				],
			}),
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});

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
				expect(permission.toolCall).toMatchObject({
					title: "write_file",
					rawInput: { path: "queue.txt", content },
				});
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
