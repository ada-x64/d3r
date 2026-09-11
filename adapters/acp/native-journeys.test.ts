import {
	client,
	RequestError,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type RequestPermissionRequest,
	type SessionNotification,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { SEED_ROOT } from "@d3r/core/vault/seed-root";
import { execFile } from "node:child_process";
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
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Models } from "../pi/auth.ts";
import { createEmbeddedRuntime } from "../pi/embedded.ts";
import {
	createNativeDeps,
	type NativeDependencies,
} from "../../cli/src/native.ts";
import {
	nativeModelKey,
	type NativeModel,
} from "../../cli/src/native-models.ts";
import { parseNativeCheckpoint } from "../../cli/src/native-resources.ts";
import { deferred, fixture, waitForAbort } from "./test-support.ts";

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
/** Legacy compatibility journeys retain their separate automatic synthesis provider. */
const JOURNEY_SUMMARY =
	"## Workflow complete\n\nThe requested phase is complete; its results are retained for the next decision.\n\n**Next:** Review the results before choosing the next phase.";
/** Only provider IO is replaced; messages and tool results still pass through Pi. */
const journeyStream = (
	content: JourneyMessage["content"],
	beforeEvent?: (index: number) => Promise<void>,
): JourneyStream => {
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
		...content.flatMap((part, contentIndex) => {
			if (part.type !== "text" && part.type !== "thinking") {
				return [];
			}
			return [
				{
					type: part.type === "text" ? "text_delta" : "thinking_delta",
					contentIndex,
					delta: part.type === "text" ? part.text : part.thinking,
					partial: message,
				},
			];
		}),
		{ type: "done", reason: message.stopReason, message },
	];
	let index = 0;
	return {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				await beforeEvent?.(index);
				return index < events.length
					? { value: events[index++], done: false }
					: { value: undefined, done: true };
			},
		}),
		result: async () => message,
	} as JourneyStream;
};
/** Pause provider IO before a tool response, without changing production permission or execution paths. */
const journeyToolGate = (id: string) => {
	const reached = deferred<JourneyMessage["content"]>();
	const release = deferred<void>();
	return {
		reached,
		release,
		stream: (content: JourneyMessage["content"], signal?: AbortSignal) =>
			journeyStream(content, async (index) => {
				if (
					index === 0 &&
					content.some((part) => part.type === "toolCall" && part.id === id)
				) {
					reached.resolve(content);
					await Promise.race([
						release.promise,
						...(signal ? [waitForAbort(signal)] : []),
					]);
				}
			}),
	};
};
/** A terminal provider rejection carries no deltas or usage, only untrusted diagnostics. */
const journeyFailureStream = (errorMessage: string): JourneyStream => {
	const message = journeyStream([])
		.result()
		.then((initial) => ({
			...initial,
			stopReason: "error" as const,
			errorMessage,
			provider: "diagnostic-provider",
			model: "diagnostic-model",
		}));
	let delivered = false;
	return {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				if (delivered) {
					return { value: undefined, done: true };
				}
				delivered = true;
				return {
					value: { type: "error", reason: "error", error: await message },
					done: false,
				};
			},
		}),
		result: () => message,
	} as JourneyStream;
};
/** Synthetic diagnostic-only canaries must not enter output, storage or later model context. */
const JOURNEY_PRIVATE_DIAGNOSTIC =
	"Authorization: Bearer journey-secret-canary; x-api-key: journey-header-canary; https://diagnostic.invalid/private?token=journey-url-canary\nprompt: journey-prompt-canary\n at journey-stack-canary (/private/provider.ts:19:4)";
/** Match individual fields too, so partial diagnostic leaks cannot pass a whole-string check. */
const JOURNEY_DIAGNOSTIC_LEAK =
	/journey-(?:secret|header|url|prompt|stack)-canary|diagnostic\.invalid|Authorization|x-api-key|diagnostic-provider|diagnostic-model|\/private\/provider\.ts/;
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
/** Read model-visible tool output without asserting inside the provider callback. */
const journeyResultText = (context: JourneyContext, id: string) => {
	const result = journeyResult(context, id);
	return result?.role === "toolResult"
		? result.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n")
		: "";
};
/** Read the latest request, not earlier messages with superseded host state. */
const journeyUserText = (context: JourneyContext): string => {
	const message = context.messages.findLast(({ role }) => role === "user");
	if (message?.role !== "user") {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");
};
/** Workers and follow-on routing copy the runtime's current topic rather than inventing slugs. */
const journeyTopic = (context: JourneyContext): string => {
	const topic = [
		...journeyUserText(context).matchAll(
			/^Topic name: ([a-z0-9]+(?:-[a-z0-9]+)*)$/gm,
		),
	].at(-1)?.[1];
	if (!topic) {
		throw new Error("Missing shared topic in the current provider request");
	}
	return topic;
};
/** Shortcut fixtures translate user intent only at provider IO, never at phase execution. */
const journeyRouterShortcut = (
	context: JourneyContext,
): JourneyMessage["content"] | undefined => {
	const last = context.messages.at(-1);
	if (
		last?.role === "toolResult" &&
		/^d3r_(?:.*_phase|phase_status)$/.test(last.toolName)
	) {
		const result = journeyResultText(context, last.toolCallId);
		return [
			{
				type: "text",
				text:
					!last.isError && /^## Phase: [^\n]+\nStatus: completed\n/.test(result)
						? `${JOURNEY_SUMMARY}\n\n${result}`
						: result,
			},
		];
	}
	if (last?.role !== "user") {
		return undefined;
	}
	const parts =
		typeof last.content === "string"
			? [last.content]
			: last.content.flatMap((part) =>
					part.type === "text" ? [part.text] : [],
				);
	const marker = "D3R runtime phase state (authoritative):\n";
	const state =
		parts.findLast((part) => part.startsWith(marker))?.slice(marker.length) ??
		"";
	const request =
		parts
			.findLast(
				(part) =>
					!part.startsWith(marker) && !part.startsWith("Native vault status:"),
			)
			?.trim() ?? "";
	if (request === "status") {
		return journeyCall("d3r_phase_status", {});
	}
	const phase =
		/^\/(design|delegate|develop|summarize)\b/.exec(request)?.[1] ??
		/No active workflow\. Selected phase: (design|delegate|develop|summarize)\./.exec(
			state,
		)?.[1];
	if (phase) {
		return journeyCall("d3r_start_phase", {
			phase,
			brief: {
				goal: request,
				context: request,
				acceptanceCriteria: [request],
			},
		});
	}
	if (/Status: (waiting|blocked|interrupted)/.test(state)) {
		return request === "abandon"
			? journeyCall("d3r_abandon_phase", { reason: request })
			: journeyCall("d3r_continue_phase", { instructions: request });
	}
	return undefined;
};
/** Explicit router scripts summarize observed role evidence rather than canned success. */
const journeyPhaseReply =
	(id: string, heading: string) =>
	(context: JourneyContext): JourneyMessage["content"] => {
		const result = journeyResultText(context, id);
		const evidence = result
			.split("\n\n")
			.filter(
				(part) =>
					!part.startsWith("## Phase:") && !part.startsWith("Return control"),
			);
		return [
			{ type: "text", text: `## ${heading}\n\n${evidence.join("\n\n")}` },
		];
	};
/** Allow real CLI startup and seed Git operations on slower hosts without unbounded waits. */
const JOURNEY_INIT_TIMEOUT = 20_000;
/** Small real invocation limits make boundary journeys independent of production defaults. */
const JOURNEY_BUDGET = { maxTurns: 3, maxTotalTurns: 6 };
/** Shipped auditor/reviewer capabilities allow report writes, but not editing, web access or delegation. */
const JOURNEY_INSPECTION_TOOLS = [
	"read_file",
	"list_directory",
	"search",
	"write_file",
	"run_command",
	"read_skill",
	"vault_read",
	"vault_ls",
	"vault_find",
	"vault_lint",
	"vault_write",
	"vault_mv",
	"vault_rm",
	"d3r_report",
	"d3r_request_extension",
].toSorted();
/** ACP grants must select an offered option; cancellation is not a rejection selection. */
type JourneyDecision = boolean | "allow_scope" | "cancelled";
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
/** A role must submit its structured report and then finish the real model loop. */
const journeyDone = (summary: string): JourneyMessage["content"][] => [
	journeyReport(summary),
	[{ type: "text", text: summary }],
];
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
/** ACP owns the outer checkpoint; native state lives inside its runtime field. */
const journeyCheckpoint = (state: unknown) =>
	parseNativeCheckpoint((state as { runtime: unknown }).runtime);
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
// oxlint-disable-next-line max-statements -- Keep the journey matrix under one isolated workspace lifecycle.
describe("native ACP shipped-workflow journeys", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const open = async (
		scripts: JourneyScripts,
		{
			workspace = "workspace",
			routerShortcuts = true,
			models = [JOURNEY_MODEL],
			readTextFile,
			getWebConfig = () => ({ providerId: "exa" }),
			createRuntime = createEmbeddedRuntime,
			streamResponse = (_role: string, content: JourneyMessage["content"]) =>
				journeyStream(content),
		}: {
			workspace?: string;
			routerShortcuts?: boolean;
			models?: NativeModel[];
			getWebConfig?: NativeDependencies["getWebProviderConfig"];
			createRuntime?: NativeDependencies["createEmbeddedRuntime"];
			streamResponse?: (
				role: string,
				content: JourneyMessage["content"],
				// oxlint-disable-next-line no-magic-numbers -- The provider's third argument carries its cancellation signal.
				settings: Parameters<Models["streamSimple"]>[2],
			) => JourneyStream;
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
		const requests: {
			role: string;
			model: NativeModel;
			context: JourneyContext;
		}[] = [];
		const runtimes: {
			options: Parameters<NativeDependencies["createEmbeddedRuntime"]>[0];
			input: Parameters<
				ReturnType<NativeDependencies["createEmbeddedRuntime"]>
			>[0];
		}[] = [];
		const permissions: RequestPermissionRequest[] = [];
		const reads: ReadTextFileRequest[] = [];
		const approval = {
			decide: async (
				_request: RequestPermissionRequest,
			): Promise<JourneyDecision> => true,
		};
		const streamSimple: Models["streamSimple"] = (model, context, settings) => {
			const role = context.systemPrompt?.startsWith(
				"You summarize completed D3R workflows.",
			)
				? "summary"
				: (/^You are (\w+)\./.exec(context.systemPrompt ?? "")?.[1] ??
					"router");
			requests.push({
				role,
				model: structuredClone(model),
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
			const content =
				role === "summary" && !Object.hasOwn(scripts, role)
					? [{ type: "text" as const, text: JOURNEY_SUMMARY }]
					: ((role === "router" &&
						routerShortcuts &&
						context.systemPrompt?.startsWith(
							"You are D3R's native workflow orchestrator in Zed.",
						)
							? journeyRouterShortcut(context)
							: undefined) ?? scripts[role]?.shift());
			if (!content) {
				throw new Error(`Unexpected offline request for ${role}`);
			}
			return streamResponse(
				role,
				typeof content === "function" ? content(context) : content,
				settings,
			);
		};
		const connect = async () => {
			const deps = await createNativeDeps(
				{ home, version: "journey-test" },
				{
					getWebProviderConfig: getWebConfig,
					createEmbeddedRuntime: (options) => (input) => {
						runtimes.push({ options, input });
						return createRuntime(options)(input);
					},
					createModelRuntime: async ({ stateDir }) => {
						await mkdir(stateDir, { recursive: true, mode: 0o700 });
						return {
							getAvailable: async () => models,
							getProviders: () => [],
							logout: async () => {},
							streamSimple,
						};
					},
				},
			);

			const clientApp = client().onRequest(
				"session/request_permission",
				async ({ params }) => {
					permissions.push(params);
					const decision = await approval.decide(params);
					if (decision === "cancelled") {
						return { outcome: { outcome: "cancelled" } };
					}
					const once = decision ? "allow_once" : "reject_once";
					const kind = decision === "allow_scope" ? "allow_always" : once;
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
				/** Restore the old on-disk format through ACP, with no orchestration opt-out in production. */
				legacySession: async () => {
					const created = await f.newSession(cwd);
					const { sessionId } = created;
					await f.peer.agent.request("session/set_config_option", {
						sessionId,
						configId: "model",
						value: nativeModelKey(JOURNEY_MODEL),
					});
					await f.peer.agent.request("session/close", { sessionId });
					const saved = (await deps.store!.get(sessionId))!;
					const record = saved.records.at(-1)!;
					if (record.kind !== "checkpoint") {
						throw new Error("Missing legacy fixture resource pin");
					}
					const pin = journeyCheckpoint(record.state);
					pin.inner = {
						version: 1,
						format: "d3r.workflow",
						workflow: pin.resources.workflow,
						phase: "routing",
						engine: null,
						history: [],
						input: [],
						routingInterrupted: false,
						routingInput: [],
						routingHistory: 0,
						routing: {
							version: 1,
							format: "d3r.pi.embedded",
							model: { provider: JOURNEY_MODEL.provider, id: JOURNEY_MODEL.id },
							thinkingLevel: "off",
							messages: [],
						},
					};
					await deps.store!.save({
						...saved,
						records: [
							...saved.records.slice(0, -1),
							{
								kind: "checkpoint",
								state: { ...(record.state as object), runtime: pin },
							},
						],
					});
					await f.peer.agent.request("session/load", {
						sessionId,
						cwd,
						mcpServers: [],
					});
					return created;
				},
				saved: (sessionId: string) => deps.store!.get(sessionId),
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
		return {
			root,
			cwd,
			requests,
			runtimes,
			permissions,
			reads,
			approval,
			connect,
		};
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

	// oxlint-disable-next-line max-statements -- Direct implementation, role boundaries and protected disk effects form one journey.
	it("runs a direct implementor's writes and edits plus cross-role vault mutations with workspace trust alone", async () => {
		const gate = journeyToolGate("stale-workspace-edit");
		const scripts: JourneyScripts = {};
		const j = await open(scripts, {
			routerShortcuts: false,
			streamResponse: (_role, content, settings) =>
				gate.stream(content, settings?.signal),
		});
		const vault = resolve(j.cwd, ".agents/vault");
		await cp(SEED_ROOT, vault, { recursive: true });
		const sentinel = "PRIVATE automatic-write sentinel";
		const privateFile = resolve(j.cwd, ".git/private.txt");
		const outside = resolve(j.root, "outside.txt");
		await mkdir(dirname(privateFile));
		await Promise.all([
			writeFile(privateFile, sentinel),
			writeFile(outside, sentinel),
		]);
		const original = "Queue: pending\n";
		const external = "Queue: ready\nOperator comment\n";
		const final = external.replace("ready", "done");
		const note = "notes/automatic.md";
		const moved = "notes/reviewed.md";
		const snapshot = (context: JourneyContext, id: string) =>
			/^Snapshot: ([a-f0-9]{64})/m.exec(journeyResultText(context, id))?.[1];
		const goal =
			"Implement the local queue in auto mode, with workspace files and a vault log; no commands.";
		scripts.router = [
			journeyCall(
				"d3r_run_role",
				{
					role: "implementor",
					mode: "auto",
					brief: {
						goal,
						context: "Preserve external edits and private paths.",
						acceptanceCriteria: [
							"Save the queue and counter, and update its vault log.",
						],
					},
				},
				"implement",
			),
			journeyPhaseReply("implement", "Implementation saved"),
			journeyCall(
				"d3r_run_role",
				{
					role: "reviewer",
					brief: {
						goal: "Review the queue and move its vault log; save notes/review.md.",
						context: goal,
						acceptanceCriteria: [
							"Verify the saved files before moving the log.",
						],
					},
				},
				"review",
			),
			journeyPhaseReply("review", "Review saved"),
			journeyCall(
				"d3r_run_role",
				{
					role: "auditor",
					brief: {
						goal: "Audit the saved review, remove the temporary vault log and save notes/audit.md.",
						context: goal,
						acceptanceCriteria: ["Read the log before removing it."],
					},
				},
				"audit",
			),
			journeyPhaseReply("audit", "Audit saved"),
		];
		scripts.implementor = [
			[
				...journeyCall(
					"write_file",
					{ path: "queue.txt", content: original },
					"create-queue",
				),
				...journeyCall(
					"write_file",
					{ path: "counter.txt", content: "Count: 0\n" },
					"create-counter",
				),
			],
			[
				...journeyCall("read_file", { path: "queue.txt" }, "queue-read"),
				...journeyCall("read_file", { path: "counter.txt" }, "counter-read"),
			],
			(context) => [
				...journeyCall(
					"edit_file",
					{
						path: "queue.txt",
						oldText: "pending",
						newText: "ready",
						snapshot: snapshot(context, "queue-read"),
					},
					"edit-queue",
				),
				...journeyCall(
					"edit_file",
					{
						path: "counter.txt",
						oldText: "0",
						newText: "1",
						snapshot: snapshot(context, "counter-read"),
					},
					"edit-counter",
				),
			],
			[
				...journeyCall("read_file", { path: "queue.txt" }, "before-external"),
				...journeyCall("read_file", { path: "counter.txt" }, "counter-edited"),
			],
			(context) =>
				journeyCall(
					"edit_file",
					{
						path: "queue.txt",
						oldText: "ready",
						newText: "done",
						snapshot: snapshot(context, "before-external"),
					},
					"stale-workspace-edit",
				),
			journeyCall("read_file", { path: "queue.txt" }, "fresh-queue"),
			(context) => [
				...journeyCall(
					"edit_file",
					{
						path: "queue.txt",
						oldText: "ready",
						newText: "done",
						snapshot: snapshot(context, "fresh-queue"),
					},
					"fresh-workspace-edit",
				),
				...journeyCall(
					"write_file",
					{
						path: "counter.txt",
						content: "Count: 2\n",
						snapshot: snapshot(context, "counter-edited"),
					},
					"overwrite-counter",
				),
			],
			[
				...journeyCall(
					"write_file",
					{ path: "queue.txt", content: "Clobbered" },
					"missing-workspace-snapshot",
				),
				...journeyCall(
					"write_file",
					{ path: ".git/private.txt", content: "Clobbered" },
					"private-workspace-write",
				),
				...journeyCall(
					"write_file",
					{ path: outside, content: "Clobbered" },
					"outside-workspace-write",
				),
				...journeyCall(
					"vault_write",
					{ mode: "raw", path: note, contents: "State: pending\n" },
					"create-log",
				),
			],
			journeyCall("vault_read", { path: note }, "log-read"),
			(context) =>
				journeyCall(
					"vault_edit",
					{
						path: note,
						find: "pending",
						replace: "done",
						snapshot: journeyPage(context, "log-read").snapshot,
					},
					"edit-log",
				),
			...journeyDone(
				"Saved queue.txt, counter.txt and the vault log with the operator comment intact.",
			),
		];
		scripts.reviewer = [
			[
				...journeyCall("read_file", { path: "queue.txt" }, "review-queue"),
				...journeyCall("read_file", { path: "counter.txt" }, "review-counter"),
				...journeyCall("vault_read", { path: note }, "review-log"),
			],
			(context) =>
				journeyCall(
					"vault_mv",
					{
						from: note,
						to: moved,
						snapshot: journeyPage(context, "review-log").snapshot,
					},
					"move-log",
				),
			journeyCall(
				"vault_write",
				{
					mode: "raw",
					path: "notes/review.md",
					contents: "Queue and counter verified.\n",
				},
				"save-review",
			),
			journeyReport("Reviewed the saved files and moved the log.", {
				review: "approved",
			}),
			[{ type: "text", text: "Review complete." }],
		];
		scripts.auditor = [
			[
				...journeyCall("vault_read", { path: moved }, "audit-log"),
				...journeyCall(
					"vault_read",
					{ path: "notes/review.md" },
					"audit-review",
				),
			],
			(context) =>
				journeyCall(
					"vault_rm",
					{ path: moved, snapshot: journeyPage(context, "audit-log").snapshot },
					"remove-log",
				),
			journeyCall(
				"vault_write",
				{
					mode: "raw",
					path: "notes/audit.md",
					contents: "Review verified; temporary log removed.\n",
				},
				"save-audit",
			),
			...journeyDone(
				"Audited the saved review and removed only the temporary log.",
			),
		];
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		j.approval.decide = async () => false;
		await expect(f.prompt(sessionId, goal)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(j.requests).toEqual([]);
		await expect(readFile(resolve(j.cwd, "queue.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		j.approval.decide = async ({ toolCall }) =>
			toolCall.title?.startsWith("Trust workspace") === true;
		const pending = f.prompt(sessionId, goal);
		try {
			await Promise.race([
				gate.reached.promise,
				pending.then(() => {
					throw new Error(
						"Implementation ended before the stale snapshot gate",
					);
				}),
			]);
			await expect(readFile(resolve(j.cwd, "queue.txt"), "utf8")).resolves.toBe(
				"Queue: ready\n",
			);
			await writeFile(resolve(j.cwd, "queue.txt"), external);
			gate.release.resolve();
			await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		} finally {
			await f.peer.agent.notify("session/cancel", { sessionId });
			gate.release.resolve();
			await pending;
		}
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "implementor"]),
		);
		expect(
			journeyCheckpoint(await f.checkpoint(sessionId)).inner,
		).toMatchObject({
			standaloneRole: "implementor",
			engine: { command: "standalone", status: "completed", mode: "auto" },
		});
		const implemented = j.requests.findLast(
			({ role }) => role === "implementor",
		)!.context;
		for (const id of [
			"create-queue",
			"create-counter",
			"edit-queue",
			"edit-counter",
			"fresh-workspace-edit",
			"overwrite-counter",
			"create-log",
			"edit-log",
		]) {
			expect(journeyResult(implemented, id), id).toMatchObject({
				isError: false,
			});
		}
		for (const id of [
			"stale-workspace-edit",
			"missing-workspace-snapshot",
			"private-workspace-write",
			"outside-workspace-write",
		]) {
			expect(journeyResult(implemented, id), id).toMatchObject({
				isError: true,
			});
		}
		expect(journeyResultText(implemented, "stale-workspace-edit")).toBe(
			"Tool execution failed; effects may have occurred. Do not automatically retry.",
		);
		expect(snapshot(implemented, "fresh-queue")).not.toBe(
			snapshot(implemented, "before-external"),
		);
		for (const line of external.trim().split("\n")) {
			expect(journeyResultText(implemented, "fresh-queue")).toContain(line);
		}
		await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
			"State: done\n",
		);
		await expect(
			f.prompt(
				sessionId,
				"Review the files, move the temporary log and save notes/review.md.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const reviewed = j.requests.findLast(
			({ role }) => role === "reviewer",
		)!.context;
		for (const line of final.trim().split("\n")) {
			expect(journeyResultText(reviewed, "review-queue")).toContain(line);
		}
		expect(journeyResultText(reviewed, "review-counter")).toContain("Count: 2");
		expect(journeyPage(reviewed, "review-log").text).toBe("State: done\n");
		for (const id of ["move-log", "save-review"]) {
			expect(journeyResult(reviewed, id), id).toMatchObject({ isError: false });
		}
		await expect(readFile(resolve(vault, moved), "utf8")).resolves.toBe(
			"State: done\n",
		);
		await expect(readFile(resolve(vault, note))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			f.prompt(
				sessionId,
				"Audit the review, remove the temporary log and save notes/audit.md.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const audited = j.requests.findLast(
			({ role }) => role === "auditor",
		)!.context;
		expect(journeyPage(audited, "audit-log").text).toBe("State: done\n");
		expect(journeyPage(audited, "audit-review").text).toBe(
			"Queue and counter verified.\n",
		);
		for (const id of ["remove-log", "save-audit"]) {
			expect(journeyResult(audited, id), id).toMatchObject({ isError: false });
		}
		await expect(readFile(resolve(vault, moved))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await Promise.all(
			[
				[resolve(j.cwd, "queue.txt"), final],
				[resolve(j.cwd, "counter.txt"), "Count: 2\n"],
				[resolve(vault, "notes/review.md"), "Queue and counter verified.\n"],
				[
					resolve(vault, "notes/audit.md"),
					"Review verified; temporary log removed.\n",
				],
				[privateFile, sentinel],
				[outside, sentinel],
			].map(async ([path, content]) => {
				await expect(readFile(path, "utf8")).resolves.toBe(content);
			}),
		);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(journeyText(f.updates)).toContain("Audited the saved review");
		expect(JSON.stringify([j.requests, f.updates])).not.toContain(sentinel);
		expect(JSON.stringify(await f.saved(sessionId))).not.toMatch(
			/allow_scope|d3r:native:workspace-edits/,
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Real worktree evidence, role isolation, and subsequent discussion form one journey.
	it("runs a standalone auditor read-only, reloads completed-role Phase picker changes and starts only the next requested phase", async () => {
		const ordinarySources = [
			"cli/src/verbs/auth.ts",
			"adapters/pi/auth.ts",
			"adapters/pi/auth-store.ts",
			"adapters/acp/secrets.ts",
			"src/auth/secrets/policy.ts",
			"auth.json",
		].map((path) => ({
			path,
			text: path.endsWith(".json")
				? `${JSON.stringify({ purpose: `enqueue source fixture ${path}` })}\n`
				: `export const purpose = "enqueue source fixture ${path}";\n`,
		}));
		const sourceDirectories = [
			...new Set(ordinarySources.map(({ path }) => dirname(path))),
		];
		const privatePath = ".agents/d3r/private/credentials.json";
		const privateCanary = "enqueue-private-credential-canary";
		const goal = "audit this worktree";
		const scope = `Inspect queue.mjs, scratch.txt and ${ordinarySources.map(({ path }) => path).join(", ")}, including uncommitted and untracked contents, not just a commit.`;
		const criterion =
			"Return inline findings with severity and file locations.";
		const constraint =
			"Read-only inspection; do not fix, write reports, stage or commit.";
		const source = "export const enqueue = (jobs, job) => jobs.push(job);\n";
		const untracked =
			"Untracked enqueue probe: callers expect an unchanged input array.\n";
		const finding =
			"**High - queue.mjs:1:** enqueue mutates the caller's array and returns a length, not a queue. The untracked scratch.txt:1 probe expects unchanged input." +
			`\n\n## Source coverage\n\n${ordinarySources.map(({ path, text }) => `- ${path}:1: inspected ${text.trim()}`).join("\n")}\n\nNo source coverage omitted. Stored private credential values excluded.`;
		const command = {
			command: process.execPath,
			args: [
				"--input-type=module",
				"-e",
				"import { readFileSync } from 'node:fs'; for (const path of ['queue.mjs', 'scratch.txt']) console.log(path + ': ' + readFileSync(path, 'utf8'));",
			],
		};
		const scripts: JourneyScripts = {
			router: [
				journeyCall(
					"d3r_run_role",
					{
						role: "auditor",
						brief: {
							goal,
							context: scope,
							acceptanceCriteria: [criterion],
							constraints: [constraint],
						},
					},
					"audit-worktree",
				),
				journeyPhaseReply("audit-worktree", "Worktree audit"),
				(context) => [
					{
						type: "text",
						text: journeyResultText(context, "audit-worktree").includes(finding)
							? "## Audit discussion\n\nThe enqueue finding includes the untracked probe. No fixes or develop phase were started."
							: "Missing prior audit evidence.",
					},
				],
			],
			auditor: [
				journeyCall("read_file", { path: "AGENTS.md" }, "conventions"),
				journeyCall("read_file", { path: "queue.mjs" }, "changed-source"),
				[...sourceDirectories, "src", "src/auth", ".agents/d3r"].flatMap(
					(path) => journeyCall("list_directory", { path }, `list:${path}`),
				),
				journeyCall(
					"search",
					{ path: ".", query: "enqueue" },
					"worktree-search",
				),
				ordinarySources.flatMap(({ path }) =>
					journeyCall("read_file", { path }, `read:${path}`),
				),
				journeyCall("read_file", { path: privatePath }, "private-read"),
				journeyCall("run_command", command, "inspect-disk"),
				(context) =>
					journeyReport(
						ordinarySources.every(
							({ path, text }) =>
								journeyResultText(context, `read:${path}`).includes(
									text.trim(),
								) &&
								journeyResultText(context, "worktree-search").includes(
									text.trim(),
								) &&
								journeyResultText(context, `list:${dirname(path)}`).includes(
									basename(path),
								),
						)
							? finding
							: "Source audit coverage incomplete.",
					),
				[{ type: "text", text: "Worker-only audit response" }],
			],
		};
		const j = await open(scripts, {
			routerShortcuts: false,
			readTextFile: async ({ path }) => {
				if (
					![
						"AGENTS.md",
						"queue.mjs",
						"scratch.txt",
						privatePath,
						...ordinarySources.map((file) => file.path),
					].some((file) => resolve(j.cwd, file) === path)
				) {
					throw new Error("Editor read outside audit fixtures");
				}
				return { content: await readFile(path, "utf8") };
			},
		});
		await Promise.all(
			[
				...ordinarySources,
				{
					path: privatePath,
					text: JSON.stringify({ token: privateCanary }),
				},
			].map(async ({ path, text }) => {
				await mkdir(dirname(resolve(j.cwd, path)), { recursive: true });
				await writeFile(resolve(j.cwd, path), text);
			}),
		);
		const git = (...args: string[]) =>
			promisify(execFile)(
				"git",
				["--no-pager", "--no-optional-locks", ...args],
				{ cwd: j.cwd, timeout: 5000 },
			);
		// An index baseline gives real dirty/untracked files without creating a fixture commit.
		await git("init", "--quiet");
		await writeFile(
			resolve(j.cwd, "queue.mjs"),
			"export const enqueue = (jobs, job) => [...jobs, job];\n",
		);
		await git("add", "--", "queue.mjs");
		await Promise.all([
			writeFile(resolve(j.cwd, "queue.mjs"), source),
			writeFile(resolve(j.cwd, "scratch.txt"), untracked),
		]);
		const { stdout: beforeStatus } = await git("status", "--porcelain=v1");
		expect(beforeStatus).toContain("AM queue.mjs");
		expect(beforeStatus).toContain("?? scratch.txt");
		const files = await readdir(j.cwd, { recursive: true });
		const index = await readFile(resolve(j.cwd, ".git/index"));
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const pin = journeyCheckpoint(await f.checkpoint(sessionId));
		expect(
			pin.resources.agents.find(({ spec }) => spec.name === "auditor")?.spec
				.capabilities,
		).toEqual(["read", "bash", "write"]);
		await expect(
			readFile(resolve(pin.resources.vaultRoot, "AGENTS.md")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			f.prompt(sessionId, `${goal}\n${scope}\n${criterion}\n${constraint}`),
		).resolves.toEqual({ stopReason: "end_turn" });
		const completed = journeyCheckpoint(await f.checkpoint(sessionId));
		expect(completed.resources).toEqual(pin.resources);
		expect(completed.inner).toMatchObject({
			orchestrated: true,
			standaloneRole: "auditor",
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: {
				command: "standalone",
				status: "completed",
				mode: null,
				pause: null,
			},
		});
		expect(completed.inner!.engine!.workflow).toEqual({
			commands: {
				standalone: {
					description: "Run auditor independently",
					chain: [{ kind: "agent", name: "auditor" }],
				},
			},
			vault: pin.resources.workflow.vault,
		});
		expect(completed.inner!.engine!.records).toEqual([
			expect.objectContaining({
				kind: "agent",
				role: "auditor",
				loops: [],
				status: "completed",
				outcome: { status: "completed", summary: finding },
			}),
		]);
		expect(completed.inner).not.toHaveProperty("summary");
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"auditor",
		]);
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "auditor"]),
		);
		const auditor = j.requests.filter(({ role }) => role === "auditor");
		for (const fact of [
			goal,
			scope,
			criterion,
			constraint,
			"Conversation-derived standalone role brief:",
			"Execute only auditor as a standalone role",
			"including uncommitted and untracked work",
			"Keep inspection read-only",
		]) {
			expect(JSON.stringify(auditor[0].context.messages)).toContain(fact);
		}
		expect(auditor[0].context.systemPrompt).toMatch(
			/no prior phase or formal vault documents are required/i,
		);
		for (const { context } of auditor) {
			expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
				JOURNEY_INSPECTION_TOOLS,
			);
		}
		const evidence = auditor.at(-1)!.context;
		for (const { path, text } of ordinarySources) {
			expect(journeyResult(evidence, `read:${path}`)).toMatchObject({
				isError: false,
			});
			expect(journeyResultText(evidence, `read:${path}`)).toContain(
				`1: ${text.trim()}`,
			);
			expect(journeyResultText(evidence, "worktree-search")).toContain(
				`${resolve(j.cwd, path)}:1: ${text.trim()}`,
			);
			expect(journeyResult(evidence, `list:${dirname(path)}`)).toMatchObject({
				isError: false,
			});
			expect(
				journeyResultText(evidence, `list:${dirname(path)}`).split("\n"),
			).toContain(basename(path));
			expect(j.reads.map((read) => read.path)).toContain(resolve(j.cwd, path));
		}
		for (const [path, entry] of [
			["src", "auth/"],
			["src/auth", "secrets/"],
		]) {
			expect(journeyResult(evidence, `list:${path}`)).toMatchObject({
				isError: false,
			});
			expect(journeyResultText(evidence, `list:${path}`)).toContain(entry);
		}
		expect(journeyResult(evidence, "list:.agents/d3r")).toMatchObject({
			isError: false,
		});
		expect(journeyResultText(evidence, "list:.agents/d3r")).not.toContain(
			"private",
		);
		expect(journeyResult(evidence, "private-read")).toMatchObject({
			isError: true,
		});

		expect(journeyResultText(evidence, "worktree-search")).not.toContain(
			privatePath,
		);
		for (const surface of [j.requests, f.updates, await f.saved(sessionId)]) {
			expect(JSON.stringify(surface)).not.toContain(privateCanary);
		}
		expect(j.reads.map(({ path }) => path)).not.toContain(
			resolve(j.cwd, privatePath),
		);
		for (const id of [
			"conventions",
			"changed-source",
			"worktree-search",
			"inspect-disk",
			"d3r_report",
		]) {
			expect(journeyResult(evidence, id)).toMatchObject({ isError: false });
		}
		expect(journeyResultText(evidence, "conventions")).toContain(
			"Preserve the offline user's requirements.",
		);
		expect(journeyResultText(evidence, "changed-source")).toContain(
			source.trim(),
		);
		expect(journeyResultText(evidence, "worktree-search")).toContain(
			`${resolve(j.cwd, "queue.mjs")}:1: ${source.trim()}`,
		);
		expect(journeyResultText(evidence, "worktree-search")).toContain(
			`${resolve(j.cwd, "scratch.txt")}:1: ${untracked.trim()}`,
		);
		for (const text of [source.trim(), untracked.trim()]) {
			expect(journeyResultText(evidence, "inspect-disk")).toContain(text);
		}
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringContaining("--input-type=module"),
		]);
		expect(j.permissions.at(-1)!.toolCall.rawInput).toMatchObject(command);
		expect(
			journeyTools(f.updates).filter(
				({ status, kind }) => status === "completed" && kind === "execute",
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rawInput: expect.objectContaining(command) }),
			]),
		);
		const final = j.requests.findLast(({ role }) => role === "router")!.context;
		expect(journeyResult(final, "audit-worktree")).toMatchObject({
			isError: false,
		});
		expect(journeyResultText(final, "audit-worktree")).toContain(
			"## Role: auditor\nStatus: completed\nMode: standalone\nThis is an independent role task, not completion or approval of a phase.",
		);
		expect(journeyText(f.updates)).toMatch(/^## Worktree audit/);
		expect(journeyText(f.updates)).toContain(finding);
		expect(journeyText(f.updates)).not.toMatch(
			/Worker-only|"status"|```json|## Phase:|Workflow complete/,
		);
		expect(
			f.updates.filter(
				({ update }) => update.sessionUpdate === "agent_message_chunk",
			),
		).toHaveLength(1);
		const beforePicker = {
			requests: j.requests.length,
			runtimes: j.runtimes.length,
			permissions: j.permissions.length,
		};
		const selected = await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "phase",
			value: "develop",
		});
		expect(selected.configOptions).toContainEqual(
			expect.objectContaining({ id: "phase", currentValue: "develop" }),
		);
		const selectedCheckpoint = await f.checkpoint(sessionId);
		expect(journeyCheckpoint(selectedCheckpoint)).toEqual({
			...completed,
			phase: "develop",
			inner: { ...completed.inner, phase: "develop" },
		});
		await f.peer.agent.request("session/close", { sessionId });
		await f.close();
		const resumed = await j.connect();
		const loaded = await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		expect(loaded.configOptions).toContainEqual(
			expect.objectContaining({ id: "phase", currentValue: "develop" }),
		);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(
			selectedCheckpoint,
		);
		expect(j.requests).toHaveLength(beforePicker.requests);
		expect(j.runtimes).toHaveLength(beforePicker.runtimes);
		expect(j.permissions).toHaveLength(beforePicker.permissions);
		expect(journeyText(resumed.updates)).toContain(finding);
		await expect(
			resumed.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "phase",
				value: "standalone",
			}),
		).rejects.toBeInstanceOf(RequestError);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(
			selectedCheckpoint,
		);
		const changed = await resumed.peer.agent.request(
			"session/set_config_option",
			{
				sessionId,
				configId: "phase",
				value: "delegate",
			},
		);
		expect(changed.configOptions).toContainEqual(
			expect.objectContaining({ id: "phase", currentValue: "delegate" }),
		);
		expect(journeyCheckpoint(await resumed.checkpoint(sessionId))).toEqual({
			...completed,
			phase: "delegate",
			inner: { ...completed.inner, phase: "delegate" },
		});
		expect(j.requests).toHaveLength(beforePicker.requests);
		expect(j.runtimes).toHaveLength(beforePicker.runtimes);
		expect(j.permissions).toHaveLength(beforePicker.permissions);
		const beforeDiscussion = j.requests.length;
		const permissions = j.permissions.length;
		await expect(
			resumed.prompt(
				sessionId,
				"Discuss the untracked probe finding; do not start any fixes.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(j.requests.slice(beforeDiscussion).map(({ role }) => role)).toEqual([
			"router",
		]);
		expect(
			j.permissions.slice(permissions).map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		expect(journeyText(resumed.updates)).toContain(
			"No fixes or develop phase were started.",
		);
		expect(
			journeyResultText(j.requests.at(-1)!.context, "audit-worktree"),
		).toContain(finding);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
			"No active workflow. Selected phase: delegate.",
		);
		expect(
			journeyCheckpoint(await resumed.checkpoint(sessionId)).inner,
		).toMatchObject({
			phase: "delegate",
			engine: null,
			workflow: pin.resources.workflow,
		});
		const nextGoal =
			"Use the selected delegate phase to outline the enqueue fix inline, without implementation or files.";
		const reports = {
			planner:
				"Scope the fix to queue.mjs: preserve the caller's array and return the extended queue.",
			schemer:
				"Acceptance: the scratch.txt probe must observe unchanged input and both jobs in the returned queue.",
		};
		scripts.router.push(
			journeyCall(
				"d3r_start_phase",
				{
					phase: "delegate",
					brief: {
						goal: nextGoal,
						context: finding,
						acceptanceCriteria: [criterion],
						constraints: [constraint],
					},
				},
				"delegate-after-audit",
			),
			journeyPhaseReply("delegate-after-audit", "Inline task ready"),
		);
		scripts.planner = [
			journeyCall("read_file", { path: "queue.mjs" }),
			...journeyDone(reports.planner),
		];
		scripts.schemer = [
			journeyCall("read_file", { path: "scratch.txt" }),
			...journeyDone(reports.schemer),
		];
		const nextStart = j.requests.length;
		const nextUpdates = resumed.updates.length;
		await expect(resumed.prompt(sessionId, nextGoal)).resolves.toEqual({
			stopReason: "end_turn",
		});
		const delegated = journeyCheckpoint(await resumed.checkpoint(sessionId));
		expect(delegated.resources).toEqual(pin.resources);
		expect(delegated.inner).not.toHaveProperty("standaloneRole");
		expect(delegated.inner).toMatchObject({
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: {
				command: "delegate",
				status: "completed",
				workflow: pin.resources.workflow,
			},
		});
		expect(
			delegated.inner!.engine!.records.map(({ role, status, outcome }) => ({
				role,
				status,
				summary: outcome?.summary,
			})),
		).toEqual(
			Object.entries(reports).map(([role, summary]) => ({
				role,
				status: "completed",
				summary,
			})),
		);
		for (const [role, text] of [
			["planner", source],
			["schemer", untracked],
		]) {
			const { context } = j.requests.findLast((entry) => entry.role === role)!;
			expect(journeyResult(context, "read_file")).toMatchObject({
				isError: false,
			});
			expect(journeyResultText(context, "read_file")).toContain(text.trim());
		}
		expect(
			new Set(j.requests.slice(nextStart).map(({ role }) => role)),
		).toEqual(new Set(["router", "planner", "schemer"]));
		expect(j.requests.filter(({ role }) => role === "auditor")).toEqual(
			auditor,
		);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"auditor",
			"routing",
			"planner",
			"schemer",
		]);
		expect(
			j.permissions.slice(permissions).map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		expect(
			journeyResult(j.requests.at(-1)!.context, "delegate-after-audit"),
		).toMatchObject({ isError: false });
		expect(journeyText(resumed.updates.slice(nextUpdates))).toMatch(
			/^## Inline task ready/,
		);
		for (const report of Object.values(reports)) {
			expect(journeyText(resumed.updates.slice(nextUpdates))).toContain(report);
		}
		expect(
			resumed.updates
				.slice(nextUpdates)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		for (const { context } of j.requests.filter(
			({ role }) => role === "router",
		)) {
			expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
				[
					...JOURNEY_INSPECTION_TOOLS.filter((name) => name !== "d3r_report"),
					"edit_file",
					"vault_edit",
					"web_search",
					"web_fetch",
					"d3r_start_phase",
					"d3r_run_role",
					"d3r_continue_phase",
					"d3r_abandon_phase",
					"d3r_phase_status",
				].toSorted(),
			);
			expect(
				context.tools?.find(({ name }) => name === "d3r_run_role")?.parameters,
			).toMatchObject({
				type: "object",
				required: ["role", "brief"],
				additionalProperties: false,
				properties: {
					role: {
						type: "string",
						enum: pin.resources.agents
							.filter(({ spec }) => spec.name !== "orchestrator")
							.map(({ spec }) => spec.name),
					},
					brief: {
						type: "object",
						required: ["goal", "context", "acceptanceCriteria"],
						additionalProperties: false,
					},
					mode: { type: "string", enum: ["semi", "auto"] },
				},
			});
		}
		for (const surface of [
			j.requests,
			f.updates,
			resumed.updates,
			await resumed.saved(sessionId),
		]) {
			expect(JSON.stringify(surface)).not.toContain(privateCanary);
		}
		expect(j.reads.map(({ path }) => path)).not.toContain(
			resolve(j.cwd, privatePath),
		);
		expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
		expect(await readFile(resolve(j.cwd, ".git/index"))).toEqual(index);
		const { stdout: afterStatus } = await git("status", "--porcelain=v1");
		expect(afterStatus).toBe(beforeStatus);
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(source);
		expect(await readFile(resolve(j.cwd, "scratch.txt"), "utf8")).toBe(
			untracked,
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	it.each(["needs_human", "cancelled"] as const)(
		"reloads a standalone auditor %s checkpoint, rejects active-role picker changes and continues only that auditor",
		// oxlint-disable-next-line max-statements -- Persistence, inert load, and retained worker evidence form one recovery journey.
		async (pause) => {
			const goal = "Audit local queue retention without starting develop.";
			const scope =
				"policy.txt leaves the retention period undecided; ask me rather than inventing a limit.";
			const question = "How many hours may an offline queue job be retained?";
			const answer =
				"Retain jobs for 72 hours; continue this audit, not implementation.";
			const finding =
				"**High - queue.txt:1:** the worktree retains jobs for 96 hours, exceeding the user's 72-hour limit.";
			const atRead = deferred<void>();
			const scripts: JourneyScripts = {
				router: [
					journeyCall(
						"d3r_run_role",
						{
							role: "auditor",
							brief: {
								goal,
								context: scope,
								acceptanceCriteria: [
									"Report retention mismatches inline; do not edit files.",
								],
							},
						},
						"audit-question",
					),
					...(pause === "needs_human"
						? [journeyPhaseReply("audit-question", "Retention decision needed")]
						: []),
					journeyCall(
						"d3r_continue_phase",
						{ instructions: answer },
						"resume-audit",
					),
					journeyPhaseReply("resume-audit", "Retention audit complete"),
				],
				auditor: [
					journeyCall("read_file", { path: "policy.txt" }, "policy-read"),
					...(pause === "needs_human"
						? [
								journeyCall(
									"d3r_report",
									{ status: "needs_human", summary: question },
									"missing-limit",
								),
								[
									{
										type: "text" as const,
										text: "Worker-only waiting response",
									},
								],
							]
						: [[{ type: "text" as const, text: question }]]),
					journeyCall("read_file", { path: "queue.txt" }, "queue-read"),
					journeyReport(finding),
					[{ type: "text", text: "Worker-only resumed response" }],
				],
			};
			const j = await open(scripts, {
				routerShortcuts: false,
				readTextFile: async ({ path }) => ({
					content: await readFile(path, "utf8"),
				}),
				streamResponse: (role, content, settings) =>
					journeyStream(content, async (index) => {
						if (
							pause === "cancelled" &&
							role === "auditor" &&
							index === 0 &&
							content.some(
								(part) => part.type === "text" && part.text === question,
							)
						) {
							atRead.resolve();
							await waitForAbort(settings!.signal!);
						}
					}),
			});
			const policy =
				"Retention period: undecided. Queue jobs are stored locally.\n";
			const queue = "Queue retention: 96 hours.\n";
			await Promise.all([
				writeFile(resolve(j.cwd, "policy.txt"), policy),
				writeFile(resolve(j.cwd, "queue.txt"), queue),
			]);
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const pin = journeyCheckpoint(await f.checkpoint(sessionId));
			const pending = f.prompt(sessionId, `${goal}\n${scope}`);
			if (pause === "cancelled") {
				try {
					await Promise.race([
						atRead.promise,
						pending.then(() => {
							throw new Error(
								"Turn ended before the auditor's settled-read cancellation boundary",
							);
						}),
					]);
					expect(
						journeyResult(j.requests.at(-1)!.context, "policy-read"),
					).toMatchObject({ isError: false });
					await f.peer.agent.notify("session/cancel", { sessionId });
					await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
				} finally {
					await f.peer.agent.notify("session/cancel", { sessionId });
					await pending;
				}
			} else {
				await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
			}
			const checkpoint = await f.checkpoint(sessionId);
			const waiting = journeyCheckpoint(checkpoint).inner!;
			expect(waiting).toMatchObject({
				orchestrated: true,
				standaloneRole: "auditor",
				phase: "routing",
				workflow: pin.resources.workflow,
				engine: {
					command: "standalone",
					status: pause === "needs_human" ? "waiting" : "interrupted",
					mode: null,
					pause:
						pause === "needs_human"
							? { kind: "report", message: question }
							: { kind: "interrupted" },
				},
			});
			expect(waiting.engine!.workflow).toEqual({
				commands: {
					standalone: {
						description: "Run auditor independently",
						chain: [{ kind: "agent", name: "auditor" }],
					},
				},
				vault: pin.resources.workflow.vault,
			});
			expect(waiting.engine!.records).toEqual([
				expect.objectContaining({
					kind: "agent",
					role: "auditor",
					loops: [],
					status: pause === "needs_human" ? "waiting" : "interrupted",
					...(pause === "needs_human"
						? { outcome: { status: "needs_human", summary: question } }
						: {}),
				}),
			]);
			const [worker] = waiting.engine!.records;
			expect(waiting.continuations?.map(({ recordId }) => recordId)).toEqual([
				worker.id,
			]);
			if (pause === "needs_human") {
				expect(
					journeyResultText(j.requests.at(-1)!.context, "audit-question"),
				).toContain(
					"## Role: auditor\nStatus: waiting\nMode: standalone\nThis is an independent role task, not completion or approval of a phase.",
				);
				expect(journeyText(f.updates)).toContain(question);
			} else {
				expect(worker).not.toHaveProperty("outcome");
				expect(JSON.stringify(waiting.continuations)).toContain("policy-read");
			}
			expect(journeyText(f.updates)).not.toContain("72");
			expect(j.reads.map(({ path }) => path)).toEqual([
				resolve(j.cwd, "policy.txt"),
			]);
			expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
				"auditor",
			]);
			const beforeReload = {
				requests: j.requests.length,
				permissions: j.permissions.length,
				runtimes: j.runtimes.length,
			};
			await expect(
				f.peer.agent.request("session/set_config_option", {
					sessionId,
					configId: "phase",
					value: "develop",
				}),
			).rejects.toBeInstanceOf(RequestError);
			await expect(f.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			await f.peer.agent.request("session/close", { sessionId });
			await f.close();
			const resumed = await j.connect();
			await resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			});
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			await expect(
				resumed.peer.agent.request("session/set_config_option", {
					sessionId,
					configId: "phase",
					value: "delegate",
				}),
			).rejects.toBeInstanceOf(RequestError);
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(j.requests).toHaveLength(beforeReload.requests);
			expect(j.permissions).toHaveLength(beforeReload.permissions);
			expect(j.runtimes).toHaveLength(beforeReload.runtimes);
			expect(j.reads.map(({ path }) => path)).toEqual([
				resolve(j.cwd, "policy.txt"),
			]);
			if (pause === "needs_human") {
				expect(journeyText(resumed.updates)).toContain(question);
			}
			const start = resumed.updates.length;
			await expect(resumed.prompt(sessionId, answer)).resolves.toEqual({
				stopReason: "end_turn",
			});
			const recovery = j.requests.slice(beforeReload.requests);
			expect(new Set(recovery.map(({ role }) => role))).toEqual(
				new Set(["router", "auditor"]),
			);
			const auditor = recovery.find(({ role }) => role === "auditor")!.context;
			for (const fact of [
				goal,
				scope,
				...(pause === "needs_human" ? [question] : []),
				answer,
				"Execute only auditor as a standalone role",
			]) {
				expect(JSON.stringify(auditor.messages)).toContain(fact);
			}
			expect(journeyResult(auditor, "policy-read")).toMatchObject({
				isError: false,
			});
			expect(journeyResultText(auditor, "policy-read")).toContain(
				policy.trim(),
			);
			if (pause === "needs_human") {
				expect(journeyResult(auditor, "missing-limit")).toMatchObject({
					isError: false,
				});
			} else {
				expect(journeyResult(auditor, "missing-limit")).toBeUndefined();
			}
			const reported = recovery.findLast(
				({ role }) => role === "auditor",
			)!.context;
			expect(journeyResult(reported, "queue-read")).toMatchObject({
				isError: false,
			});
			expect(journeyResultText(reported, "queue-read")).toContain(queue.trim());
			expect(journeyResult(reported, "d3r_report")).toMatchObject({
				isError: false,
			});
			expect(j.reads.map(({ path }) => path)).toEqual([
				resolve(j.cwd, "policy.txt"),
				resolve(j.cwd, "queue.txt"),
			]);
			const completed = journeyCheckpoint(await resumed.checkpoint(sessionId));
			expect(completed.resources).toEqual(pin.resources);
			expect(completed.inner).toMatchObject({
				standaloneRole: "auditor",
				phase: "routing",
				workflow: pin.resources.workflow,
				engine: {
					command: "standalone",
					workflow: waiting.engine!.workflow,
					status: "completed",
					pause: null,
				},
			});
			expect(completed.inner!.engine!.records).toEqual([
				{
					...worker,
					status: "completed",
					outcome: { status: "completed", summary: finding },
				},
			]);
			expect(completed.inner!.continuations ?? []).toEqual([]);
			expect(completed.inner).not.toHaveProperty("summary");
			expect(
				journeyResult(recovery.at(-1)!.context, "resume-audit"),
			).toMatchObject({ isError: false });
			expect(
				journeyResultText(recovery.at(-1)!.context, "resume-audit"),
			).toContain("## Role: auditor\nStatus: completed\nMode: standalone");
			expect(journeyText(resumed.updates.slice(start))).toContain(finding);
			expect(journeyText(resumed.updates.slice(start))).not.toMatch(
				/Worker-only|"status"|## Phase:|Workflow complete/,
			);
			expect(
				resumed.updates
					.slice(start)
					.filter(
						({ update }) => update.sessionUpdate === "agent_message_chunk",
					),
			).toHaveLength(1);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
				expect.stringMatching(/^Trust workspace/),
			]);
			expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
				"auditor",
				"routing",
				"auditor",
			]);
			for (const { context } of j.requests.filter(
				({ role }) => role === "auditor",
			)) {
				expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
					JOURNEY_INSPECTION_TOOLS,
				);
			}
			expect(await readdir(j.cwd)).toEqual([
				"AGENTS.md",
				"policy.txt",
				"queue.txt",
			]);
			expect(await readFile(resolve(j.cwd, "policy.txt"), "utf8")).toBe(policy);
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(queue);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
		},
	);

	// oxlint-disable-next-line max-statements -- Standalone approval and a later explicit develop must remain separate lifecycles.
	it("keeps standalone reviewer approval independent and starts the normal develop graph only when requested", async () => {
		const original = "export const first = (jobs) => jobs[0];\n";
		const source = "export const first = (jobs) => jobs.at(0) ?? null;\n";
		const approval =
			"Approved queue.mjs:1 for the existing nonempty-input contract; this is standalone review evidence, not develop approval.";
		const goal = "Now develop an empty-queue fallback returning null.";
		const scope = "Only queue.mjs; do not commit or create vault artifacts.";
		const criterion =
			"An empty queue returns null and a nonempty queue returns its first job.";
		const reports = {
			implementor: "Implemented the empty-queue fallback in queue.mjs.",
			reviewer: "Approved the new null fallback after inspecting queue.mjs:1.",
			auditor:
				"Audited the null fallback independently of the earlier standalone approval.",
		};
		const scripts: JourneyScripts = {
			router: [
				journeyCall(
					"d3r_run_role",
					{
						role: "reviewer",
						brief: {
							goal: "Review queue.mjs independently.",
							context:
								"The current contract accepts nonempty queues; do not implement or audit anything else.",
							acceptanceCriteria: [
								"Return an inline verdict, not a report file.",
							],
						},
					},
					"standalone-review",
				),
				journeyPhaseReply("standalone-review", "Independent review"),
				journeyCall(
					"d3r_start_phase",
					{
						phase: "develop",
						brief: { goal, context: scope, acceptanceCriteria: [criterion] },
					},
					"choose-develop-mode",
				),
				journeyPhaseReply("choose-develop-mode", "Choose develop mode"),
				journeyCall(
					"d3r_continue_phase",
					{ instructions: "auto" },
					"develop-after-review",
				),
				journeyPhaseReply(
					"develop-after-review",
					"Fallback implemented, reviewed and audited",
				),
			],
			reviewer: [
				journeyCall("read_file", { path: "queue.mjs" }, "standalone-source"),
				journeyReport(approval, { review: "approved" }),
				[{ type: "text", text: "Worker-only standalone approval" }],
				journeyCall(
					"read_file",
					{ path: "queue.mjs" },
					"develop-review-source",
				),
				journeyReport(reports.reviewer, { review: "approved" }),
				[{ type: "text", text: "Worker-only develop approval" }],
			],
			implementor: [
				journeyCall("read_file", { path: "queue.mjs" }),
				(context) =>
					journeyCall("write_file", {
						path: "queue.mjs",
						content: source,
						snapshot: /^Snapshot: ([a-f0-9]{64})/m.exec(
							journeyResultText(context, "read_file"),
						)?.[1],
					}),
				journeyReport(reports.implementor, { allDone: true }),
				[{ type: "text", text: "Worker-only implementation" }],
			],
			auditor: [
				journeyCall("read_file", { path: "queue.mjs" }, "develop-audit-source"),
				...journeyDone(reports.auditor),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		await writeFile(resolve(j.cwd, "queue.mjs"), original);
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const pin = journeyCheckpoint(await f.checkpoint(sessionId));
		await expect(
			f.prompt(
				sessionId,
				"Review queue.mjs against its nonempty-input contract only; give an inline verdict, without implementation or audit.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const reviewed = journeyCheckpoint(await f.checkpoint(sessionId));
		expect(reviewed.resources).toEqual(pin.resources);
		expect(reviewed.inner).toMatchObject({
			standaloneRole: "reviewer",
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: { command: "standalone", status: "completed", pause: null },
		});
		expect(reviewed.inner!.engine!.workflow).toEqual({
			commands: {
				standalone: {
					description: "Run reviewer independently",
					chain: [{ kind: "agent", name: "reviewer" }],
				},
			},
			vault: pin.resources.workflow.vault,
		});
		expect(reviewed.inner!.engine!.records).toEqual([
			expect.objectContaining({
				kind: "agent",
				role: "reviewer",
				loops: [],
				status: "completed",
				outcome: { status: "completed", summary: approval, review: "approved" },
			}),
		]);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"reviewer",
		]);
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "reviewer"]),
		);
		expect(
			journeyResultText(
				j.requests.findLast(({ role }) => role === "reviewer")!.context,
				"standalone-source",
			),
		).toContain(original.trim());
		expect(
			journeyResultText(j.requests.at(-1)!.context, "standalone-review"),
		).toContain(
			"## Role: reviewer\nStatus: completed\nMode: standalone\nThis is an independent role task, not completion or approval of a phase.",
		);
		expect(journeyText(f.updates)).toContain(approval);
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(original);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		const beforeDevelop = j.requests.length;
		await expect(
			f.prompt(sessionId, `${goal}\n${scope}\n${criterion}`),
		).resolves.toEqual({ stopReason: "end_turn" });
		const waiting = journeyCheckpoint(await f.checkpoint(sessionId));
		expect(waiting.resources).toEqual(pin.resources);
		expect(waiting.inner).not.toHaveProperty("standaloneRole");
		expect(waiting.inner).toMatchObject({
			phase: "develop",
			workflow: pin.resources.workflow,
			engine: {
				command: "develop",
				workflow: pin.resources.workflow,
				status: "waiting",
				mode: null,
				pause: { kind: "mode" },
			},
		});
		expect(
			waiting.inner!.engine!.records.every(
				({ status, outcome }) => status === "pending" && outcome === undefined,
			),
		).toBe(true);
		expect(
			waiting
				.inner!.engine!.records.filter(({ kind }) => kind === "agent")
				.map(({ role }) => role),
		).toEqual([
			"implementor",
			"reviewer",
			"implementor",
			"reviewer",
			"implementor",
			"reviewer",
			"auditor",
		]);
		expect(j.requests.slice(beforeDevelop).map(({ role }) => role)).toEqual([
			"router",
			"router",
		]);
		expect(journeyText(f.updates)).toContain("Choose develop mode");
		const start = f.updates.length;
		await expect(f.prompt(sessionId, "auto")).resolves.toEqual({
			stopReason: "end_turn",
		});
		const completed = journeyCheckpoint(await f.checkpoint(sessionId));
		expect(completed.resources).toEqual(pin.resources);
		expect(completed.inner).not.toHaveProperty("standaloneRole");
		expect(completed.inner).not.toHaveProperty("summary");
		expect(completed.inner).toMatchObject({
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: {
				command: "develop",
				workflow: pin.resources.workflow,
				status: "completed",
				mode: "auto",
				pause: null,
			},
		});
		expect(
			completed
				.inner!.engine!.records.filter(
					({ kind, status }) => kind === "agent" && status === "completed",
				)
				.map(({ role, outcome }) => ({ role, summary: outcome!.summary })),
		).toEqual(
			Object.entries(reports).map(([role, summary]) => ({ role, summary })),
		);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"reviewer",
			"implementor",
			"reviewer",
			"auditor",
		]);
		for (const { role, context } of j.requests.filter(
			(entry) => entry.role !== "router",
		)) {
			expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
				role === "implementor"
					? [...JOURNEY_INSPECTION_TOOLS, "edit_file", "vault_edit"].toSorted()
					: JOURNEY_INSPECTION_TOOLS,
			);
		}
		expect(
			journeyResult(
				j.requests.findLast(({ role }) => role === "implementor")!.context,
				"write_file",
			),
		).toMatchObject({ isError: false });
		for (const [role, id] of [
			["reviewer", "develop-review-source"],
			["auditor", "develop-audit-source"],
		]) {
			const { context } = j.requests.findLast((entry) => entry.role === role)!;
			expect(journeyResult(context, id)).toMatchObject({ isError: false });
			expect(journeyResultText(context, id)).toContain(source.trim());
		}
		expect(
			journeyResult(j.requests.at(-1)!.context, "develop-after-review"),
		).toMatchObject({ isError: false });
		expect(
			journeyResultText(j.requests.at(-1)!.context, "develop-after-review"),
		).toContain("## Phase: develop\nStatus: completed\nMode: auto");
		for (const summary of Object.values(reports)) {
			expect(journeyText(f.updates.slice(start))).toContain(summary);
		}
		expect(journeyText(f.updates.slice(start))).not.toMatch(
			/Worker-only|"status"|Workflow complete/,
		);
		expect(
			f.updates
				.slice(start)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
		expect(await readdir(j.cwd)).toEqual(["AGENTS.md", "queue.mjs"]);
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(source);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Conversation, actual effects, and subsequent discussion form one acceptance journey.
	it("orchestrates conversation directly into develop, then discusses the actual reviewed results", async () => {
		const goal =
			"Add an offline enqueue helper that preserves insertion order.";
		const scope =
			"Only queue.mjs; no dependencies, network, commits, or deployment.";
		const criterion =
			"Appending a job returns both jobs in their original order without mutating the input.";
		const source = "export const enqueue = (jobs, job) => [...jobs, job];\n";
		const reports = {
			implementor:
				"Created queue.mjs; the Node assertion passed for insertion order and unchanged input.",
			reviewer:
				"Approved the helper after reading queue.mjs; scope is limited to the requested file.",
			auditor:
				"Audited the offline helper and test evidence; no dependencies or deployment were added.",
		};
		const scripts: JourneyScripts = {
			router: [
				[
					{
						type: "text",
						text: "I can implement that directly. What is the scope, acceptance criterion, and develop mode?",
					},
				],
				journeyCall(
					"d3r_start_phase",
					{
						phase: "develop",
						brief: {
							goal,
							context: scope,
							acceptanceCriteria: [criterion],
							constraints: ["Do not commit or deploy."],
						},
					},
					"choose-mode",
				),
				journeyPhaseReply("choose-mode", "Choose develop mode"),
				journeyCall("d3r_continue_phase", { instructions: "auto" }, "develop"),
				journeyPhaseReply("develop", "Offline helper ready"),
				(context) => [
					{
						type: "text",
						text: `## Next decision\n\n${journeyResultText(context, "develop").includes(reports.auditor) ? "The reviewed helper is complete. Deployment remains unapproved; no further work was started." : "Missing previous audit evidence."}`,
					},
				],
			],
			implementor: [
				journeyCall("write_file", { path: "queue.mjs", content: source }),
				journeyCall("run_command", {
					command: process.execPath,
					args: [
						"--input-type=module",
						"-e",
						"import assert from 'node:assert/strict'; import { enqueue } from './queue.mjs'; const jobs = ['first']; assert.deepEqual(enqueue(jobs, 'second'), ['first', 'second']); assert.deepEqual(jobs, ['first']); console.log('queue assertions passed');",
					],
				}),
				journeyReport(reports.implementor, { allDone: true }),
				[{ type: "text", text: "Worker implementation response" }],
			],
			reviewer: [
				journeyCall("read_file", { path: "queue.mjs" }),
				journeyReport(reports.reviewer, { review: "approved" }),
				[{ type: "text", text: "Worker review response" }],
			],
			auditor: [
				journeyCall("read_file", { path: "queue.mjs" }),
				...journeyDone(reports.auditor),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(f.prompt(sessionId, goal)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(j.requests.map(({ role }) => role)).toEqual(["router"]);
		expect(
			journeyCheckpoint(await f.checkpoint(sessionId)).inner,
		).toMatchObject({ orchestrated: true, engine: null });
		await expect(
			f.prompt(sessionId, `${scope}\n${criterion}\nImplement directly.`),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(
			journeyCheckpoint(await f.checkpoint(sessionId)).inner!.engine,
		).toMatchObject({
			command: "develop",
			mode: null,
			status: "waiting",
			pause: { kind: "mode" },
		});
		expect(j.requests.every(({ role }) => role === "router")).toBe(true);
		expect(await readdir(j.cwd)).toEqual(["AGENTS.md"]);
		expect(journeyText(f.updates)).toContain("Choose develop mode");
		const start = f.updates.length;
		await expect(f.prompt(sessionId, "auto")).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(source);
		const files = await readdir(j.cwd);
		expect(files.toSorted()).toEqual(["AGENTS.md", "queue.mjs"]);
		const workers = j.requests.filter(({ role }) => role !== "router");
		expect(new Set(workers.map(({ role }) => role))).toEqual(
			new Set(Object.keys(reports)),
		);
		for (const role of Object.keys(reports)) {
			const { context } = workers.find((entry) => entry.role === role)!;
			for (const fact of [goal, scope, criterion, "Do not commit or deploy."]) {
				expect(JSON.stringify(context.messages)).toContain(fact);
			}
			expect(context.systemPrompt).toMatch(
				/\bno prior phase or formal vault documents are required\b/i,
			);
			expect(context.tools?.map(({ name }) => name)).not.toContain(
				"d3r_start_phase",
			);
		}
		const implemented = workers.findLast(
			({ role }) => role === "implementor",
		)!.context;
		expect(journeyResult(implemented, "run_command")).toMatchObject({
			isError: false,
		});
		expect(journeyResultText(implemented, "run_command")).toContain(
			"queue assertions passed",
		);
		const final = j.requests.findLast(({ role }) => role === "router")!.context;
		expect(journeyResult(final, "develop")).toMatchObject({ isError: false });
		expect(journeyResultText(final, "develop")).toContain(
			"## Phase: develop\nStatus: completed\nMode: auto",
		);
		for (const report of Object.values(reports)) {
			expect(journeyText(f.updates.slice(start))).toContain(report);
		}
		expect(
			f.updates
				.slice(start)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		expect(journeyText(f.updates.slice(start))).toMatch(
			/^## Offline helper ready/,
		);
		expect(journeyText(f.updates.slice(start))).not.toMatch(
			/Worker .* response|"status"/,
		);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"implementor",
			"reviewer",
			"auditor",
		]);
		expect(j.requests.filter(({ role }) => role === "summary")).toEqual([]);
		const completed = journeyCheckpoint(await f.checkpoint(sessionId)).inner!;
		expect(completed.engine).toMatchObject({ status: "completed" });
		expect(completed).not.toHaveProperty("summary");
		const beforeDiscussion = j.requests.length;
		const permissions = j.permissions.length;
		await expect(
			f.prompt(
				sessionId,
				"What did review find, and can we discuss deployment without starting it?",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(j.requests.slice(beforeDiscussion).map(({ role }) => role)).toEqual([
			"router",
		]);
		expect(j.permissions).toHaveLength(permissions);
		expect(journeyText(f.updates)).toContain(
			"Deployment remains unapproved; no further work was started.",
		);
		for (const report of Object.values(reports)) {
			expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
				report,
			);
		}
		for (const { context } of j.requests.filter(
			({ role }) => role === "router",
		)) {
			expect(context.systemPrompt).toMatch(
				/^You are D3R's native workflow orchestrator in Zed\./,
			);
			expect(context.tools?.map(({ name }) => name)).toEqual(
				expect.arrayContaining([
					"d3r_start_phase",
					"d3r_continue_phase",
					"d3r_abandon_phase",
					"d3r_phase_status",
				]),
			);
		}
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- The checkpoint and user-directed phase switch must share a persistent conversation.
	it("orchestrates /design discussion without auto-answering, then abandons it for direct develop", async () => {
		const brief = {
			goal: "Create a local queue marker.",
			context: "No network or formal design artifacts are needed.",
			acceptanceCriteria: ["queue.txt contains offline only."],
		};
		const scripts: JourneyScripts = {
			router: [
				journeyCall("d3r_start_phase", { phase: "design", brief }, "design"),
				journeyCall(
					"d3r_continue_phase",
					{ instructions: "Invent an answer and draft now." },
					"auto-answer",
				),
				journeyPhaseReply("design", "Design questions"),
				journeyCall("d3r_phase_status", {}, "discussion"),
				journeyPhaseReply(
					"discussion",
					"Still discussing; no answer submitted",
				),
				journeyCall(
					"d3r_abandon_phase",
					{
						reason:
							"The user explicitly skipped design and requested direct implementation.",
					},
					"skip",
				),
				journeyCall("d3r_phase_status", {}, "after-abandon"),
				journeyCall(
					"d3r_start_phase",
					{ phase: "develop", brief, mode: "auto" },
					"direct",
				),
				journeyPhaseReply("direct", "Direct implementation reviewed"),
			],
			aggregator: journeyDone("The workspace needs only a local marker."),
			researcher: journeyDone(
				"No network research is necessary; confirm the design scope with the user.",
			),
			implementor: [
				journeyCall("write_file", { path: "queue.txt", content: "offline\n" }),
				journeyReport("Created the requested offline marker.", {
					allDone: true,
				}),
				[{ type: "text", text: "Marker created." }],
			],
			reviewer: [
				journeyCall("read_file", { path: "queue.txt" }),
				journeyReport("Approved the exact offline marker contents.", {
					review: "approved",
				}),
				[{ type: "text", text: "Review complete." }],
			],
			auditor: journeyDone(
				"Audited the marker; no design artifact or network operation was created.",
			),
		};
		const j = await open(scripts, { routerShortcuts: false });
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(
			f.prompt(sessionId, "/design Create a local queue marker"),
		).resolves.toEqual({ stopReason: "end_turn" });
		const waiting = journeyCheckpoint(await f.checkpoint(sessionId)).inner!;
		expect(waiting).toMatchObject({
			orchestrated: true,
			engine: {
				command: "design",
				status: "waiting",
				pause: { kind: "human" },
			},
		});
		const firstFinal = j.requests.at(-1)!.context;
		expect(journeyResult(firstFinal, "auto-answer")).toMatchObject({
			isError: true,
		});
		expect(journeyResultText(firstFinal, "auto-answer")).toContain(
			"already ran in this turn",
		);
		expect(journeyResultText(firstFinal, "design")).toContain(
			"Discuss design questions before drafting",
		);
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(j.requests.some(({ role }) => role === "designer")).toBe(false);
		const beforeDiscussion = j.requests.length;
		await expect(
			f.prompt(
				sessionId,
				"Why would we need a design document? Let's discuss; do not draft yet.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(
			j.requests.slice(beforeDiscussion).every(({ role }) => role === "router"),
		).toBe(true);
		expect(
			journeyCheckpoint(await f.checkpoint(sessionId)).inner!.engine,
		).toEqual(waiting.engine);
		expect(journeyText(f.updates)).toContain(
			"Still discussing; no answer submitted",
		);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		const start = f.updates.length;
		await expect(
			f.prompt(
				sessionId,
				"Skip and abandon design. Develop the marker directly in auto mode.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(
			"offline\n",
		);
		expect(await readdir(j.cwd)).not.toContain("design.md");
		const final = j.requests.at(-1)!.context;
		expect(journeyResult(final, "skip")).toMatchObject({ isError: false });
		expect(journeyResultText(final, "skip")).toContain(
			"Existing effects remain",
		);
		expect(waiting.topic).toMatch(/^create-a-local-queue-marker-[a-z0-9]+$/);
		expect(journeyResult(final, "after-abandon")).toMatchObject({
			isError: false,
		});
		expect(journeyResultText(final, "after-abandon")).toContain(
			`Topic name: ${waiting.topic}`,
		);
		expect(journeyResultText(final, "after-abandon")).toContain(
			"Most recent topic; reuse only for follow-on work on the same subject:",
		);
		expect(journeyResultText(final, "direct")).toContain(
			"## Phase: develop\nStatus: completed\nMode: auto",
		);
		expect(journeyText(f.updates.slice(start))).toContain(
			"Approved the exact offline marker contents.",
		);
		expect(
			f.updates
				.slice(start)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		expect(
			j.requests.some(({ role }) => role === "designer" || role === "summary"),
		).toBe(false);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"aggregator",
			"researcher",
			"implementor",
			"reviewer",
			"auditor",
		]);
		const completed = journeyCheckpoint(await f.checkpoint(sessionId)).inner!;
		expect(completed.engine).toMatchObject({
			command: "develop",
			status: "completed",
		});
		expect(completed.topic).toMatch(/^create-a-local-queue-marker-[a-z0-9]+$/);
		expect(completed.topic).not.toBe(waiting.topic);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Clarification, reload, sibling preservation, and completion prove one real needs_human handoff.
	it("clarifies a missing fact through needs_human and resumes only the waiting worker's retained conversation", async () => {
		const question =
			"How many hours should an offline job be retained before expiration?";
		const answer =
			"Retain each offline job for 72 hours; continue research using that limit.";
		const siblingSummary =
			"The queue runs locally; no network service is required.";
		const researchSummary =
			"The user chose a 72-hour retention limit; expiration can remain local.";
		const design =
			"# Queue expiration\n\nRetain offline jobs for 72 hours, then expire them locally.\n";
		const scripts: JourneyScripts = {
			router: [
				journeyCall(
					"d3r_start_phase",
					{
						phase: "design",
						brief: {
							goal: "Design expiration for offline jobs.",
							context:
								"The retention period is undecided; policy.txt contains the known facts.",
							acceptanceCriteria: [
								"Expiration uses the retention period chosen by the user, not an invented default.",
							],
						},
					},
					"clarify",
				),
				journeyPhaseReply("clarify", "Retention decision needed"),
				journeyCall("d3r_continue_phase", { instructions: answer }, "answer"),
				journeyPhaseReply(
					"answer",
					"Research clarified; confirm before drafting",
				),
				journeyCall(
					"d3r_continue_phase",
					{
						instructions:
							"Draft the local expiration design using the agreed retention limit.",
					},
					"draft-design",
				),
				journeyPhaseReply("draft-design", "Expiration design ready"),
			],
			aggregator: journeyDone(siblingSummary),
			researcher: [
				journeyCall("read_file", { path: "policy.txt" }, "retention-read"),
				journeyCall(
					"d3r_report",
					{ status: "needs_human", summary: question },
					"missing-retention",
				),
				[{ type: "text", text: "Waiting for the user's retention decision." }],
				journeyCall(
					"d3r_report",
					{ status: "completed", summary: researchSummary },
					"clarified-retention",
				),
				[{ type: "text", text: "Research now has the missing fact." }],
			],
			designer: [
				journeyCall("write_file", { path: "expiration.md", content: design }),
				...journeyDone(
					"Saved expiration.md with the agreed 72-hour local retention policy.",
				),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		await writeFile(
			resolve(j.cwd, "policy.txt"),
			"Offline jobs expire locally. Retention period: undecided.\n",
		);
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(
			f.prompt(
				sessionId,
				"Design local expiration; ask me for the missing retention period.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const checkpoint = await f.checkpoint(sessionId);
		const waiting = journeyCheckpoint(checkpoint).inner!;
		expect(waiting).toMatchObject({
			orchestrated: true,
			engine: {
				status: "waiting",
				pause: { kind: "report", message: question },
			},
		});
		const sibling = waiting.engine!.records.find(
			({ role }) => role === "aggregator",
		)!;
		const waitingWorker = waiting.engine!.records.find(
			({ role }) => role === "researcher",
		)!;
		expect(sibling).toMatchObject({
			status: "completed",
			outcome: { summary: siblingSummary },
		});
		const siblingRequests = j.requests.filter(
			({ role }) => role === "aggregator",
		);
		expect(waitingWorker).toMatchObject({
			status: "waiting",
			outcome: { status: "needs_human", summary: question },
		});
		expect(waiting.continuations?.map(({ recordId }) => recordId)).toEqual([
			waitingWorker.id,
		]);
		const initial = j.requests.find(
			({ role }) => role === "researcher",
		)!.context;
		expect(JSON.stringify(initial.messages)).toContain(
			"retention period is undecided",
		);
		expect(JSON.stringify(initial.messages)).not.toContain("72 hours");
		const reported = j.requests.findLast(
			({ role }) => role === "researcher",
		)!.context;
		expect(journeyResult(reported, "missing-retention")).toMatchObject({
			isError: false,
		});
		expect(journeyResultText(reported, "retention-read")).toContain(
			"Retention period: undecided",
		);
		expect(journeyText(f.updates)).toContain(question);
		expect(
			f.updates.filter(
				({ update }) => update.sessionUpdate === "agent_message_chunk",
			),
		).toHaveLength(1);
		expect(j.requests.some(({ role }) => role === "designer")).toBe(false);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		const beforeReload = {
			requests: j.requests.length,
			permissions: j.permissions.length,
			runtimes: j.runtimes.length,
		};
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload.requests);
		expect(j.permissions).toHaveLength(beforeReload.permissions);
		expect(j.runtimes).toHaveLength(beforeReload.runtimes);
		expect(journeyText(resumed.updates)).toContain(question);
		await expect(resumed.prompt(sessionId, answer)).resolves.toEqual({
			stopReason: "end_turn",
		});
		const clarification = j.requests.slice(beforeReload.requests);
		expect(new Set(clarification.map(({ role }) => role))).toEqual(
			new Set(["router", "researcher"]),
		);
		const resumedWorker = clarification.find(
			({ role }) => role === "researcher",
		)!.context;
		expect(JSON.stringify(resumedWorker.messages)).toContain(answer);
		expect(journeyResult(resumedWorker, "missing-retention")).toMatchObject({
			isError: false,
		});
		expect(journeyResult(resumedWorker, "retention-read")).toMatchObject({
			isError: false,
		});
		expect(
			journeyResult(
				clarification.findLast(({ role }) => role === "researcher")!.context,
				"clarified-retention",
			),
		).toMatchObject({ isError: false });
		const clarified = journeyCheckpoint(
			await resumed.checkpoint(sessionId),
		).inner!;
		expect(clarified.engine).toMatchObject({
			status: "waiting",
			pause: { kind: "human" },
		});
		expect(clarified.engine!.records).toContainEqual(sibling);
		expect(
			clarified.engine!.records.find(({ id }) => id === waitingWorker.id),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", summary: researchSummary },
		});
		expect(clarified.continuations ?? []).toEqual([]);
		expect(journeyText(resumed.updates)).toContain(researchSummary);
		await expect(
			readFile(resolve(j.cwd, "expiration.md")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			resumed.prompt(
				sessionId,
				"Draft the local expiration design using the agreed retention limit.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(await readFile(resolve(j.cwd, "expiration.md"), "utf8")).toBe(
			design,
		);
		const designer = j.requests.find(
			({ role }) => role === "designer",
		)!.context;
		for (const fact of [answer, siblingSummary, researchSummary]) {
			expect(JSON.stringify(designer.messages)).toContain(fact);
		}
		const completed = journeyCheckpoint(
			await resumed.checkpoint(sessionId),
		).inner!;
		expect(completed.engine).toMatchObject({ status: "completed" });
		expect(completed.engine!.records).toContainEqual(sibling);
		expect(j.requests.filter(({ role }) => role === "aggregator")).toEqual(
			siblingRequests,
		);
		expect(journeyText(resumed.updates)).toContain(
			"Saved expiration.md with the agreed 72-hour local retention policy.",
		);
		expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	it.each(["fresh report", "missing report"] as const)(
		"settles cancellation after a successful report before delivering a queued correction with %s",
		// oxlint-disable-next-line max-statements -- The two outcomes share the contested post-report cancellation boundary and real write evidence.
		async (reporting) => {
			const original = "Approved queue configuration.\n";
			const external =
				"User annotation added after cancellation; do not overwrite.\n";
			const corrected = "Keep jobs local; deployment remains unapproved.\n";
			const correction =
				"Continue the interrupted implementation. Preserve my queue.txt annotation, inspect it, and write the local-only correction to correction.txt.";
			const oldSummary =
				"Initial queue configuration was written before the correction.";
			const freshSummary =
				"Preserved the user annotation and wrote correction.txt for local-only jobs.";
			const terminalText =
				"Report accepted; terminal model stop is still pending.";
			const atStop = deferred<void>();
			const abortObserved = deferred<void>();
			const settle = deferred<void>();
			const order: string[] = [];
			const checkpoints: unknown[] = [];
			const scripts: JourneyScripts = {
				router: [
					journeyCall(
						"d3r_start_phase",
						{
							phase: "develop",
							mode: "auto",
							brief: {
								goal: "Configure an offline queue.",
								context: "Write queue.txt without deploying or committing.",
								acceptanceCriteria: ["The queue configuration remains local."],
							},
						},
						"initial-develop",
					),
					journeyCall(
						"d3r_continue_phase",
						{ instructions: correction },
						"correct-reported-work",
					),
					journeyPhaseReply(
						"correct-reported-work",
						reporting === "fresh report"
							? "Correction reviewed"
							: "Correction needs a fresh report",
					),
				],
				implementor: [
					journeyCall(
						"write_file",
						{ path: "queue.txt", content: original },
						"approved-queue",
					),
					journeyCall(
						"d3r_report",
						{ status: "completed", summary: oldSummary, allDone: true },
						"pre-cancel-report",
					),
					[{ type: "text", text: terminalText }],
					journeyCall("read_file", { path: "queue.txt" }, "current-queue"),
					journeyCall(
						"write_file",
						{ path: "correction.txt", content: corrected },
						"corrected-queue",
					),
					...(reporting === "fresh report"
						? [
								journeyCall(
									"d3r_report",
									{ status: "completed", summary: freshSummary, allDone: true },
									"fresh-report",
								),
							]
						: []),
					[{ type: "text", text: "The correction file is ready." }],
				],
				...(reporting === "fresh report"
					? {
							reviewer: [
								journeyCall("read_file", { path: "correction.txt" }),
								journeyReport(
									"Approved the corrected local-only queue configuration.",
									{ review: "approved" },
								),
								[
									{
										type: "text" as const,
										text: "Corrected implementation reviewed.",
									},
								],
							],
							auditor: [
								journeyCall("read_file", { path: "queue.txt" }),
								...journeyDone(
									"Audited the correction and preserved user annotation.",
								),
							],
						}
					: {}),
			};
			const j = await open(scripts, {
				routerShortcuts: false,
				streamResponse: (role, content, settings) =>
					journeyStream(content, async (index) => {
						const terminalEventIndex = 2;
						if (
							role !== "implementor" ||
							index !== terminalEventIndex ||
							!content.some(
								(part) => part.type === "text" && part.text === terminalText,
							)
						) {
							return;
						}
						atStop.resolve();
						try {
							await waitForAbort(settings!.signal!);
						} catch (error) {
							order.push("abort observed");
							abortObserved.resolve();
							await settle.promise;
							throw error;
						}
					}),
			});
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const pending = f.prompt(
				sessionId,
				"Configure the offline queue in auto mode; do not deploy or commit.",
			);
			await Promise.race([
				atStop.promise,
				pending.then(() => {
					throw new Error(
						"Turn ended before the post-report cancellation boundary",
					);
				}),
			]);
			const beforeCorrection = j.requests.length;
			// Model the client's queued message: it must not become an ACP prompt until the cancelled turn acknowledges settlement.
			const queued = pending.then(async () => {
				order.push("cancel settled");
				checkpoints.push(await f.checkpoint(sessionId));
				await writeFile(resolve(j.cwd, "queue.txt"), external);
				order.push("correction sent");
				return f.prompt(sessionId, correction);
			});
			try {
				const reported = j.requests.findLast(
					({ role }) => role === "implementor",
				)!.context;
				expect(journeyResult(reported, "approved-queue")).toMatchObject({
					isError: false,
				});
				expect(journeyResult(reported, "pre-cancel-report")).toMatchObject({
					isError: false,
				});
				expect(journeyResultText(reported, "pre-cancel-report")).toMatch(
					/report recorded/i,
				);
				expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(
					original,
				);
				expect(
					j.requests.some(
						({ role }) => role === "reviewer" || role === "auditor",
					),
				).toBe(false);
				await f.peer.agent.notify("session/cancel", { sessionId });
				await abortObserved.promise;
				await f.peer.agent.request("session/list", {});
				expect(order).toEqual(["abort observed"]);
				expect(j.requests).toHaveLength(beforeCorrection);
				expect(journeyText(f.updates)).toBe("");
				settle.resolve();
				await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
				await expect(queued).resolves.toEqual({ stopReason: "end_turn" });
			} finally {
				settle.resolve();
				await f.peer.agent.notify("session/cancel", { sessionId });
				await Promise.allSettled([pending, queued]);
			}
			expect(order).toEqual([
				"abort observed",
				"cancel settled",
				"correction sent",
			]);
			const interrupted = journeyCheckpoint(checkpoints[0]).inner!;
			expect(interrupted).toMatchObject({
				orchestrated: true,
				engine: { status: "interrupted" },
			});
			const interruptedWorker = interrupted.engine!.records.find(
				({ role }) => role === "implementor",
			)!;
			expect(interruptedWorker).toMatchObject({ status: "interrupted" });
			expect(interruptedWorker.outcome).toBeUndefined();
			expect(
				interrupted.continuations?.map(({ recordId }) => recordId),
			).toEqual([interruptedWorker.id]);
			const recovery = j.requests.slice(beforeCorrection);
			const resumedWorker = recovery.find(
				({ role }) => role === "implementor",
			)!.context;
			expect(JSON.stringify(resumedWorker.messages)).toContain(correction);
			expect(journeyResult(resumedWorker, "approved-queue")).toMatchObject({
				isError: false,
			});
			expect(journeyResult(resumedWorker, "pre-cancel-report")).toMatchObject({
				isError: false,
			});
			const finishedWorker = recovery.findLast(
				({ role }) => role === "implementor",
			)!.context;
			expect(journeyResultText(finishedWorker, "current-queue")).toContain(
				external.trim(),
			);
			expect(journeyResult(finishedWorker, "corrected-queue")).toMatchObject({
				isError: false,
			});
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(
				external,
			);
			expect(await readFile(resolve(j.cwd, "correction.txt"), "utf8")).toBe(
				corrected,
			);
			const final = journeyCheckpoint(await f.checkpoint(sessionId)).inner!;
			const worker = final.engine!.records.find(
				({ id }) => id === interruptedWorker.id,
			)!;
			if (reporting === "fresh report") {
				expect(journeyResult(finishedWorker, "fresh-report")).toMatchObject({
					isError: false,
				});
				expect(worker).toMatchObject({
					status: "completed",
					outcome: { summary: freshSummary },
				});
				expect(final.engine).toMatchObject({ status: "completed" });
				expect(new Set(recovery.map(({ role }) => role))).toEqual(
					new Set(["router", "implementor", "reviewer", "auditor"]),
				);
				expect(journeyText(f.updates)).toContain(
					"Approved the corrected local-only queue configuration.",
				);
			} else {
				expect(journeyResult(finishedWorker, "fresh-report")).toBeUndefined();
				expect(worker.status).toBe("blocked");
				expect(worker.outcome).toBeUndefined();
				expect(final.engine).toMatchObject({
					status: "blocked",
					pause: { kind: "failure" },
				});
				expect(journeyText(f.updates)).toMatch(
					/missing or invalid d3r_report/i,
				);
				expect(
					j.requests.some(
						({ role }) => role === "reviewer" || role === "auditor",
					),
				).toBe(false);
			}
			const phaseResult = journeyResultText(
				j.requests.findLast(({ role }) => role === "router")!.context,
				"correct-reported-work",
			);
			expect(phaseResult).toContain(
				`Status: ${reporting === "fresh report" ? "completed" : "blocked"}`,
			);
			expect(phaseResult).not.toContain(oldSummary);
			expect(final.continuations ?? []).toEqual([]);
			expect(final).not.toHaveProperty("summary");
			expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
			expect(
				f.updates.filter(
					({ update }) => update.sessionUpdate === "agent_message_chunk",
				),
			).toHaveLength(1);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			const writes = journeyTools(f.updates).flatMap((row) =>
				row.status === "completed"
					? (row.content?.filter((part) => part.type === "diff") ?? [])
					: [],
			);
			expect(writes).toEqual([
				{
					type: "diff",
					path: resolve(j.cwd, "queue.txt"),
					oldText: null,
					newText: original,
				},
				{
					type: "diff",
					path: resolve(j.cwd, "correction.txt"),
					oldText: null,
					newText: corrected,
				},
			]);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
		},
	);

	// oxlint-disable-next-line max-statements -- Cancellation, durable effects, reload, and correction are one recovery journey.
	it("orchestrates cancellation after an approved write and reloads only the interrupted role with the user's correction", async () => {
		const original = "Approved draft before cancellation.\n";
		const external =
			"User edited the approved draft while the session was closed.\n";
		const corrected =
			"Keep the draft; record the corrected local-only decision here.\n";
		const correction =
			"Continue only the interrupted designer. Preserve my draft edit; write corrected.txt instead of final.txt.";
		const scripts: JourneyScripts = {
			router: [
				journeyCall(
					"d3r_start_phase",
					{
						phase: "design",
						brief: {
							goal: "Design a local queue.",
							context: "Retain the user's approved drafts.",
							acceptanceCriteria: ["Record the chosen local-only design."],
						},
					},
					"design",
				),
				journeyPhaseReply("design", "Confirm the design"),
				journeyCall(
					"d3r_continue_phase",
					{
						instructions:
							"Use a local-only queue; write the draft and final decision.",
					},
					"draft",
				),
			],
			aggregator: journeyDone("Existing local jobs must survive restart."),
			researcher: journeyDone(
				"A local-only queue avoids network dependencies.",
			),
			designer: [
				journeyCall(
					"write_file",
					{ path: "draft.txt", content: original },
					"approved-draft",
				),
				journeyCall(
					"write_file",
					{ path: "final.txt", content: "Superseded decision.\n" },
					"pending-final",
				),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		const asked = deferred<RequestPermissionRequest>();
		const release = deferred<boolean>();
		j.approval.decide = async (permission) => {
			if (JSON.stringify(permission.toolCall.rawInput).includes("final.txt")) {
				asked.resolve(permission);
				return release.promise;
			}
			return true;
		};
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(
			f.prompt(sessionId, "/design Design a local queue"),
		).resolves.toEqual({ stopReason: "end_turn" });
		const completedRecon = journeyCheckpoint(
			await f.checkpoint(sessionId),
		).inner!.engine!.records.filter(
			({ kind, status }) => kind === "agent" && status === "completed",
		);
		expect(completedRecon.map(({ role }) => role).toSorted()).toEqual([
			"aggregator",
			"researcher",
		]);
		const pending = f.prompt(
			sessionId,
			"Use a local-only queue; write the draft and final decision.",
		);
		try {
			const permission = await Promise.race([
				asked.promise,
				pending.then(() => {
					throw new Error("Turn ended before the second write permission");
				}),
			]);
			expect(permission.toolCall.title).toBe("write_file");
			expect(await readFile(resolve(j.cwd, "draft.txt"), "utf8")).toBe(
				original,
			);
			await expect(readFile(resolve(j.cwd, "final.txt"))).rejects.toMatchObject(
				{ code: "ENOENT" },
			);
			const designer = j.requests.findLast(
				({ role }) => role === "designer",
			)!.context;
			expect(journeyResult(designer, "approved-draft")).toMatchObject({
				isError: false,
			});
			await f.peer.agent.notify("session/cancel", { sessionId });
			await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
		} finally {
			release.resolve(false);
			await f.peer.agent.notify("session/cancel", { sessionId });
			await pending;
		}
		const checkpoint = await f.checkpoint(sessionId);
		const interrupted = journeyCheckpoint(checkpoint).inner!;
		expect(interrupted).toMatchObject({
			orchestrated: true,
			engine: { status: "interrupted" },
		});
		const interruptedRoles = interrupted.engine!.records.filter(
			({ status }) => status === "interrupted",
		);
		expect(interruptedRoles.map(({ role }) => role)).toEqual(["designer"]);
		expect(interrupted.continuations?.map(({ recordId }) => recordId)).toEqual(
			interruptedRoles.map(({ id }) => id),
		);
		expect(JSON.stringify(interrupted.continuations)).toContain(
			"approved-draft",
		);
		for (const record of completedRecon) {
			expect(interrupted.engine!.records).toContainEqual(record);
		}
		const beforeReload = {
			requests: j.requests.length,
			permissions: j.permissions.length,
			runtimes: j.runtimes.length,
		};
		await f.close();
		await writeFile(resolve(j.cwd, "draft.txt"), external);
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload.requests);
		expect(j.permissions).toHaveLength(beforeReload.permissions);
		expect(j.runtimes).toHaveLength(beforeReload.runtimes);
		scripts.router = [
			journeyCall(
				"d3r_continue_phase",
				{ instructions: correction },
				"correct",
			),
			journeyPhaseReply("correct", "Corrected design ready"),
		];
		scripts.designer = [
			journeyCall("read_file", { path: "draft.txt" }, "current-draft"),
			journeyCall("write_file", { path: "corrected.txt", content: corrected }),
			...journeyDone(
				"Preserved the user's draft edit and saved corrected.txt with the local-only decision.",
			),
		];
		j.approval.decide = async () => true;
		const start = resumed.updates.length;
		await expect(resumed.prompt(sessionId, correction)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(await readFile(resolve(j.cwd, "draft.txt"), "utf8")).toBe(external);
		expect(await readFile(resolve(j.cwd, "corrected.txt"), "utf8")).toBe(
			corrected,
		);
		await expect(readFile(resolve(j.cwd, "final.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const recovery = j.requests.slice(beforeReload.requests);
		expect(new Set(recovery.map(({ role }) => role))).toEqual(
			new Set(["router", "designer"]),
		);
		const designer = recovery.find(({ role }) => role === "designer")!.context;
		expect(JSON.stringify(designer.messages)).toContain(correction);
		expect(journeyResult(designer, "approved-draft")).toMatchObject({
			isError: false,
		});
		expect(journeyResult(designer, "pending-final")).toMatchObject({
			isError: true,
		});
		expect(
			journeyResultText(
				recovery.findLast(({ role }) => role === "designer")!.context,
				"current-draft",
			),
		).toContain(external.trim());
		expect(
			j.permissions
				.slice(beforeReload.permissions)
				.map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/), "write_file"]);
		const effects = journeyTools(resumed.updates.slice(start)).flatMap((row) =>
			row.status === "completed"
				? (row.content?.filter((part) => part.type === "diff") ?? [])
				: [],
		);
		expect(effects).toEqual([
			{
				type: "diff",
				path: resolve(j.cwd, "corrected.txt"),
				oldText: null,
				newText: corrected,
			},
		]);
		const completed = journeyCheckpoint(
			await resumed.checkpoint(sessionId),
		).inner!;
		expect(completed.engine).toMatchObject({ status: "completed" });
		for (const record of interrupted.engine!.records.filter(
			({ status }) => status === "completed",
		)) {
			expect(completed.engine!.records).toContainEqual(record);
		}
		expect(completed.continuations ?? []).toEqual([]);
		expect(completed).not.toHaveProperty("summary");
		expect(journeyText(resumed.updates.slice(start))).toContain(
			"Preserved the user's draft edit and saved corrected.txt",
		);
		expect(
			resumed.updates
				.slice(start)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	it.each([
		{
			provider: "openai",
			category: "invalid_request",
			httpStatus: 400,
			code: "invalid_function_parameters",
			detail: "invalid_tool_schema",
			error: {
				code: "invalid_function_parameters",
				message: `Invalid schema for function 'write_file': ${JOURNEY_PRIVATE_DIAGNOSTIC}`,
			},
			advice:
				"The provider rejected a tool schema. Check tool definitions against the configured model's supported schema format.",
		},
		{
			provider: "anthropic",
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			error: {
				type: "authentication_error",
				message: JOURNEY_PRIVATE_DIAGNOSTIC,
			},
			advice:
				"Provider authentication failed. Check the configured provider credentials or sign in again.",
		},
	] as const)(
		"reports a $provider planner rejection before tools and replays only its safe cause",
		// oxlint-disable-next-line max-statements -- Rejection, durable replay and safe routing handoff form one acceptance journey.
		async (rejection) => {
			const selected: NativeModel = {
				...JOURNEY_MODEL,
				provider: rejection.provider,
				id: "configured-planner",
			};
			const failure = {
				stage: "model_request",
				category: rejection.category,
				httpStatus: rejection.httpStatus,
				code: rejection.code,
				...("detail" in rejection ? { detail: rejection.detail } : {}),
				provider: rejection.provider,
				model: "configured-planner",
				toolsStarted: false,
			};
			const safeError = `Role planner: Model request failed (provider \`${rejection.provider}\`; model \`configured-planner\`; HTTP ${rejection.httpStatus}; code \`${rejection.code}\`). ${rejection.advice} No tool execution started in this invocation.`;
			const answer =
				"Review the provider configuration before delegating again.";
			const scripts: JourneyScripts = {
				planner: [[]],
				router: [[{ type: "text", text: answer }]],
			};
			const j = await open(scripts, {
				models: [JOURNEY_MODEL, selected],
				streamResponse: (role, content) =>
					role === "planner"
						? journeyFailureStream(
								`${rejection.httpStatus} ${JSON.stringify({ error: rejection.error })}`,
							)
						: journeyStream(content),
			});
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(selected),
			});
			const files = await readdir(j.cwd, { recursive: true });
			const request = "/delegate Plan the durable queue";
			await expect(f.prompt(sessionId, request)).resolves.toEqual({
				stopReason: "end_turn",
			});
			const text = journeyText(f.updates);
			expect(text).toContain(safeError);
			expect(text).toContain("Status: blocked");
			expect(text).toContain("Return control to the user");
			expect(text).not.toMatch(
				/effects may have occurred|may have had effects/,
			);
			expect(j.requests.map(({ role }) => role)).toEqual([
				"router",
				"planner",
				"router",
			]);
			const planner = j.requests.find(({ role }) => role === "planner")!;
			expect(planner.model).toEqual(selected);
			expect(JSON.stringify(planner.context.messages)).toContain(request);
			expect(planner.context.tools).toContainEqual(
				expect.objectContaining({ name: "d3r_report" }),
			);
			expect(
				journeyTools(f.updates)
					.filter((row) => row.sessionUpdate === "tool_call")
					.map(({ title }) => title),
			).toEqual(["d3r_start_phase", "planner"]);
			const failed = journeyTools(f.updates).findLast(
				(row) => row.title === "planner",
			);
			expect(failed).toMatchObject({
				status: "failed",
				rawOutput: { error: safeError, failure },
			});
			expect(failed!.rawOutput).toEqual({ error: safeError, failure });
			expect(
				f.updates.flatMap(({ update }) =>
					update.sessionUpdate === "usage_update" ? [update.used] : [],
				),
			).toEqual([0, 0, 0]);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			const checkpoint = await f.checkpoint(sessionId);
			expect(journeyCheckpoint(checkpoint).inner!.engine).toMatchObject({
				status: "blocked",
				pause: { kind: "failure", message: safeError },
				records: expect.arrayContaining([
					expect.objectContaining({ role: "planner", error: safeError }),
				]),
			});
			const saved = await f.saved(sessionId);
			expect(saved!.records).toContainEqual({
				kind: "update",
				update: expect.objectContaining({
					title: "planner",
					status: "failed",
					rawOutput: { error: safeError, failure },
				}),
			});
			expect(
				JSON.stringify([f.updates, j.permissions, saved, checkpoint]),
			).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
			await expect(readdir(j.cwd, { recursive: true })).resolves.toEqual(files);
			await f.close();
			const resumed = await j.connect();
			await expect(
				resumed.peer.agent.request("session/load", {
					sessionId,
					cwd: j.cwd,
					mcpServers: [],
				}),
				"A failed role must remain loadable with its safe error and parsed failure data",
			).resolves.toBeDefined();
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(journeyText(resumed.updates)).toBe(text);
			expect(
				journeyTools(resumed.updates).findLast((row) => row.title === "planner")
					?.rawOutput,
			).toEqual({ error: safeError, failure });
			expect(j.requests.map(({ role }) => role)).toEqual([
				"router",
				"planner",
				"router",
			]);
			expect(j.permissions).toHaveLength(1);
			await expect(resumed.prompt(sessionId, "abandon")).resolves.toEqual({
				stopReason: "end_turn",
			});
			const routingStart = resumed.updates.length;
			const routingRequests = j.requests.length;
			await expect(
				resumed.prompt(sessionId, "What should I check?"),
			).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(journeyText(resumed.updates.slice(routingStart))).toBe(answer);
			expect(journeyTools(resumed.updates.slice(routingStart))).toEqual([]);
			expect(j.requests.slice(routingRequests).map(({ role }) => role)).toEqual(
				["router"],
			);
			expect(j.requests.filter(({ role }) => role === "planner")).toHaveLength(
				1,
			);
			expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
				safeError,
			);
			expect(
				JSON.stringify([
					resumed.updates,
					await resumed.saved(sessionId),
					j.requests,
				]),
			).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
			await expect(readdir(j.cwd, { recursive: true })).resolves.toEqual(files);
			expect(await readFile(resolve(j.cwd, "AGENTS.md"), "utf8")).toBe(
				"Preserve the offline user's requirements.",
			);
		},
	);

	// oxlint-disable-next-line max-statements -- Prove approved effects, failure evidence, fresh replay and explicit non-repeating recovery together.
	it("retains an approved write after provider failure without replaying it on load or recovery", async () => {
		const artifact =
			"# Queue tasks\n\nKeep completed writes across provider failures.\n";
		const failure = {
			stage: "model_request",
			category: "quota",
			httpStatus: 429,
			code: "insufficient_quota",
			provider: "fixture",
			model: "offline",
			toolsStarted: true,
		};
		const safeError =
			"Role schemer: Model request failed (provider `fixture`; model `offline`; HTTP 429; code `insufficient_quota`). The provider reported an account quota or billing limit. Check usage allowance and billing with the provider. Tools started in this invocation and may have had effects. Review prior tool results before repeating work.";
		const scripts: JourneyScripts = {
			planner: journeyDone(
				"Plan the durable queue without repeating completed writes.",
			),
			schemer: [
				journeyCall("write_file", { path: "tasks.md", content: artifact }),
				[],
			],
			router: [
				[
					{
						type: "text",
						text: "Review the retained file and billing before restarting.",
					},
				],
			],
		};
		const j = await open(scripts, {
			streamResponse: (role, content) =>
				role === "schemer" && content.length === 0
					? journeyFailureStream(
							`429 ${JSON.stringify({
								error: {
									code: "insufficient_quota",
									message: JOURNEY_PRIVATE_DIAGNOSTIC,
								},
							})}`,
						)
					: journeyStream(content),
		});
		const asked = deferred<RequestPermissionRequest>();
		const approval = deferred<boolean>();
		j.approval.decide = async (permission) => {
			if (permission.toolCall.title?.startsWith("Trust workspace")) {
				return true;
			}
			asked.resolve(permission);
			return approval.promise;
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
			"/delegate Save the durable queue tasks",
		);
		try {
			const permission = await Promise.race([
				asked.promise,
				pending.then(() => {
					throw new Error("Turn ended without requesting write permission");
				}),
			]);
			expect(permission.toolCall.title).toBe("write_file");
			expect(journeyToolText(permission.toolCall)).toContain("tasks.md");
			await expect(readFile(resolve(j.cwd, "tasks.md"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			approval.resolve(true);
			await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		} finally {
			approval.resolve(false);
			await pending;
		}
		expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(artifact);
		expect(journeyText(f.updates)).toContain(safeError);
		expect(journeyText(f.updates)).not.toContain("No tool execution started");
		expect(j.requests.map(({ role }) => role)).toEqual([
			"router",
			"planner",
			"planner",
			"schemer",
			"schemer",
			"router",
		]);
		const writeResult = journeyResult(
			j.requests.findLast(({ role }) => role === "schemer")!.context,
			"write_file",
		);
		expect(writeResult).toMatchObject({
			toolName: "write_file",
			isError: false,
		});
		const written = journeyTools(f.updates).findLast(
			(row) => row.title === "write_file",
		);
		expect(written).toMatchObject({
			status: "completed",
			content: expect.arrayContaining([
				{
					type: "diff",
					path: resolve(j.cwd, "tasks.md"),
					oldText: null,
					newText: artifact,
				},
			]),
		});
		expect(
			journeyTools(f.updates).findLast((row) => row.title === "schemer")
				?.rawOutput,
		).toEqual({
			error: safeError,
			failure,
		});
		const checkpoint = await f.checkpoint(sessionId);
		expect(journeyCheckpoint(checkpoint).inner!.engine).toMatchObject({
			status: "blocked",
			pause: { kind: "failure", message: safeError },
		});
		const saved = await f.saved(sessionId);
		expect(saved!.records).toContainEqual({ kind: "update", update: written });
		expect(
			JSON.stringify([f.updates, saved, j.requests, j.permissions]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		const beforeReload = {
			requests: j.requests.length,
			permissions: j.permissions.length,
		};
		// A replayed identical write would erase this external edit even if the final file still existed.
		const external = `${artifact}\nOperator reviewed this file; preserve this edit.\n`;
		await writeFile(resolve(j.cwd, "tasks.md"), external);
		await f.close();
		const resumed = await j.connect();
		await expect(
			resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			}),
			"Loading a failed workflow must preserve both completed tool evidence and the safe cause",
		).resolves.toBeDefined();
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(
			journeyTools(resumed.updates).findLast(
				(row) => row.title === "write_file",
			),
		).toEqual(written);
		expect(
			journeyTools(resumed.updates).findLast((row) => row.title === "schemer")
				?.rawOutput,
		).toEqual({ error: safeError, failure });
		expect(j.requests).toHaveLength(beforeReload.requests);
		expect(j.permissions).toHaveLength(beforeReload.permissions);
		const recoveryStart = resumed.updates.length;
		await expect(resumed.prompt(sessionId, "continue")).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(resumed.updates.slice(recoveryStart))).toContain(
			safeError,
		);
		expect(
			j.requests.slice(beforeReload.requests).map(({ role }) => role),
		).toEqual(["router", "router"]);
		expect(
			journeyResult(j.requests.at(-1)!.context, "d3r_continue_phase"),
		).toMatchObject({ isError: true });
		expect(
			journeyCheckpoint(await resumed.checkpoint(sessionId)).inner!.engine,
		).toEqual(journeyCheckpoint(checkpoint).inner!.engine);
		await expect(resumed.prompt(sessionId, "abandon")).resolves.toEqual({
			stopReason: "end_turn",
		});
		await expect(
			resumed.prompt(sessionId, "What should I review before trying again?"),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(
			j.requests.slice(beforeReload.requests).map(({ role }) => role),
		).toEqual(["router", "router", "router", "router", "router"]);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
			safeError,
		);
		expect(
			journeyTools(resumed.updates.slice(recoveryStart))
				.filter(({ sessionUpdate }) => sessionUpdate === "tool_call")
				.map(({ title }) => title),
		).toEqual(["d3r_continue_phase", "d3r_abandon_phase"]);
		expect(
			j.permissions.filter(({ toolCall }) => toolCall.title === "write_file"),
		).toHaveLength(1);
		expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(external);
		expect(
			JSON.stringify([
				resumed.updates,
				await resumed.saved(sessionId),
				j.requests,
				j.permissions,
			]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- A true pre-stream exception must cross ACP as a request error and recover without implicit retry.
	it("legacy compatibility: reports a synchronous routing network throw as an ACP request error and requires explicit recovery", async () => {
		const greeting = "Ready to discuss the queue.";
		const recovered =
			"The earlier conversation is retained; no work was repeated.";
		const scripts: JourneyScripts = {
			router: [
				[{ type: "text", text: greeting }],
				[],
				[{ type: "text", text: recovered }],
			],
		};
		const j = await open(scripts, {
			streamResponse: (_role, content) => {
				if (content.length === 0) {
					throw Object.assign(
						new Error(`fetch failed: ${JOURNEY_PRIVATE_DIAGNOSTIC}`),
						{
							code: "ECONNRESET",
							cause: { message: JOURNEY_PRIVATE_DIAGNOSTIC },
						},
					);
				}
				return journeyStream(content);
			},
		});
		const f = await j.connect();
		const { sessionId } = await f.legacySession();
		expect(
			journeyCheckpoint(await f.checkpoint(sessionId)).inner,
		).not.toHaveProperty("orchestrated");
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(f.prompt(sessionId, "Hello")).resolves.toEqual({
			stopReason: "end_turn",
		});
		const failedPrompt = "Discuss recovery before making a queue plan";
		const failureStart = f.updates.length;
		const requestError: unknown = await f
			.prompt(sessionId, failedPrompt)
			.catch((error: unknown) => error);
		const safeError =
			"Model request failed (provider `fixture`; model `offline`; code `ECONNRESET`). The provider connection failed. Check network connectivity and provider availability. No tool execution started in this invocation.";
		const failure = {
			stage: "model_request",
			category: "network",
			code: "ECONNRESET",
			provider: "fixture",
			model: "offline",
			toolsStarted: false,
		};
		const internalErrorCode = -32_603;
		expect(requestError).toBeInstanceOf(RequestError);
		expect(requestError).toMatchObject({
			code: internalErrorCode,
			message: `Internal error: ${safeError}`,
			data: { failure },
		});
		expect((requestError as RequestError).data).toEqual({ failure });
		expect(journeyText(f.updates.slice(failureStart))).toBe("");
		expect(journeyTools(f.updates)).toEqual([]);
		expect(j.requests.map(({ role }) => role)).toEqual(["router", "router"]);
		const checkpoint = await f.checkpoint(sessionId);
		expect(journeyCheckpoint(checkpoint).inner).toMatchObject({
			engine: null,
			routingInterrupted: true,
		});
		expect(
			JSON.stringify([
				{
					message: (requestError as RequestError).message,
					data: (requestError as RequestError).data,
				},
				f.updates,
				await f.saved(sessionId),
				j.requests,
				j.permissions,
			]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		const permissionsBefore = j.permissions.length;
		const requestsBefore = j.requests.length;
		await f.close();
		const resumed = await j.connect();
		await expect(
			resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			}),
		).resolves.toBeDefined();
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(requestsBefore);
		expect(j.permissions).toHaveLength(permissionsBefore);
		const recoveryStart = resumed.updates.length;
		await expect(resumed.prompt(sessionId, "continue")).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(journeyText(resumed.updates.slice(recoveryStart))).toMatch(
			/Routing was interrupted[\s\S]*abandon[\s\S]*restart/,
		);
		expect(j.requests).toHaveLength(requestsBefore);
		await expect(resumed.prompt(sessionId, "abandon")).resolves.toEqual({
			stopReason: "end_turn",
		});
		const routingStart = resumed.updates.length;
		await expect(
			resumed.prompt(sessionId, "Continue our earlier discussion"),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(journeyText(resumed.updates.slice(routingStart))).toBe(recovered);
		expect(j.requests.slice(requestsBefore).map(({ role }) => role)).toEqual([
			"router",
		]);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
			greeting,
		);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).not.toContain(
			failedPrompt,
		);
		expect(journeyTools(resumed.updates)).toEqual([]);
		expect(
			JSON.stringify([
				resumed.updates,
				await resumed.saved(sessionId),
				j.requests,
			]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		await expect(readdir(j.cwd)).resolves.toEqual(["AGENTS.md"]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Follow real HTTP evidence, separate grants, persistence and renewed trust in one research journey.
	it("researches /design through native Exa tools with thread-scoped consent and no persisted credentials or grants", async () => {
		const key = "journey-exa-secret+/=";
		const url = "https://sources.example/durable-queues";
		const source =
			"The reference queue fsyncs its journal before acknowledging a job.";
		const report = `${source}\nProvider echo: [REDACTED]\nSource: ${url}\n`;
		const network: {
			url: string;
			headers: Record<string, string>;
			body: unknown;
		}[] = [];
		const unhandled: string[] = [];
		const server = setupServer(
			http.post("https://api.exa.ai/:endpoint", async ({ request, params }) => {
				network.push({
					url: request.url,
					headers: Object.fromEntries(request.headers),
					body: await request.json(),
				});
				return HttpResponse.json({
					results:
						params.endpoint === "search"
							? [
									{
										url,
										highlights: ["Journal durability before acknowledgement"],
									},
								]
							: [{ url, text: `${source}\nProvider echo: ${key}` }],
				});
			}),
		);
		server.events.on("request:unhandled", ({ request }) =>
			unhandled.push(request.url),
		);
		server.listen({ onUnhandledRequest: "error" });
		cleanup.push(async () => server.close());
		const evidence = (context: JourneyContext) => {
			const { docs } = JSON.parse(
				journeyResultText(context, "fetch-again"),
			) as { docs: { url: string; text: string }[] };
			return `${docs[0].text}\nSource: ${docs[0].url}\n`;
		};
		const scripts: JourneyScripts = {
			aggregator: journeyDone("Local requirements collected."),
			researcher: [
				journeyCall(
					"web_search",
					{ query: "durable job queue primary sources", k: 1 },
					"search-first",
				),
				journeyCall(
					"web_search",
					{ query: "journal acknowledgement ordering", k: 1 },
					"search-again",
				),
				(context) => {
					const { hits } = JSON.parse(
						journeyResultText(context, "search-again"),
					) as { hits: { url: string }[] };
					return journeyCall(
						"web_fetch",
						{ urls: hits.map((hit) => hit.url) },
						"fetch-first",
					);
				},
				(context) => {
					const { docs } = JSON.parse(
						journeyResultText(context, "fetch-first"),
					) as { docs: { url: string }[] };
					return journeyCall(
						"web_fetch",
						{ urls: docs.map((doc) => doc.url) },
						"fetch-again",
					);
				},
				(context) =>
					journeyCall("write_file", {
						path: "research.md",
						content: evidence(context),
					}),
				(context) => journeyReport(evidence(context)),
				(context) => [{ type: "text", text: evidence(context) }],
			],
			designer: journeyDone("Design grounded in retrieved research."),
		};
		const j = await open(scripts, {
			getWebConfig: () => ({ providerId: "exa", exaApiKey: key }),
		});
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const request =
			"/design Research durable queues with web_search and web_fetch; save cited findings in research.md, without shell commands.";
		j.approval.decide = async () => false;
		await expect(f.prompt(sessionId, request)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(j.requests).toEqual([]);
		expect(network).toEqual([]);
		const search = deferred<JourneyDecision>();
		const fetch = deferred<JourneyDecision>();
		const mutation = deferred<JourneyDecision>();
		j.approval.decide = async ({ toolCall }) => {
			if (toolCall.title === "web_search") {
				return search.promise;
			}
			if (toolCall.title === "web_fetch") {
				return fetch.promise;
			}
			if (toolCall.title === "write_file") {
				return mutation.promise;
			}
			return true;
		};
		const pending = f.prompt(sessionId, request);
		try {
			await vi.waitFor(() =>
				expect(
					j.permissions.some(({ toolCall }) => toolCall.title === "web_search"),
				).toBe(true),
			);
			expect(network).toEqual([]);
			search.resolve("allow_scope");
			await vi.waitFor(() =>
				expect(
					j.permissions.some(({ toolCall }) => toolCall.title === "web_fetch"),
				).toBe(true),
			);
			expect(network.map((entry) => entry.url)).toEqual([
				"https://api.exa.ai/search",
				"https://api.exa.ai/search",
			]);
			fetch.resolve("allow_scope");
			await vi.waitFor(() =>
				expect(
					j.permissions.some(({ toolCall }) => toolCall.title === "write_file"),
				).toBe(true),
			);
			await expect(
				readFile(resolve(j.cwd, "research.md")),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				j.permissions
					.find(({ toolCall }) => toolCall.title === "write_file")
					?.options.map(({ kind }) => kind),
			).toEqual(["allow_once", "reject_once", "allow_always"]);
			expect(
				j.permissions
					.find(({ toolCall }) => toolCall.title === "write_file")
					?.options.at(-1)?.name,
			).toBe("Allow workspace file writes and edits for this thread");
			mutation.resolve("allow_scope");
			await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		} finally {
			search.resolve(false);
			fetch.resolve(false);
			mutation.resolve(false);
			await f.peer.agent.notify("session/cancel", { sessionId });
			await pending;
		}
		const webPermissions = j.permissions.filter(({ toolCall }) =>
			toolCall.title?.startsWith("web_"),
		);
		expect(webPermissions.map(({ toolCall }) => toolCall.title)).toEqual([
			"web_search",
			"web_fetch",
		]);
		expect(webPermissions.map(({ options }) => options.at(-1))).toEqual([
			{
				optionId: "allow_scope",
				kind: "allow_always",
				name: "Allow web searches via Exa for this thread",
			},
			{
				optionId: "allow_scope",
				kind: "allow_always",
				name: "Allow web fetches via Exa for this thread",
			},
		]);
		expect(
			network.map(({ url: endpoint, body }) => ({ endpoint, body })),
		).toEqual([
			...[
				"durable job queue primary sources",
				"journal acknowledgement ordering",
			].map((query) => ({
				endpoint: "https://api.exa.ai/search",
				body: { query, numResults: 1, contents: { highlights: true } },
			})),
			...Array.from({ length: 2 }, () => ({
				endpoint: "https://api.exa.ai/contents",
				body: { urls: [url], text: { maxCharacters: expect.any(Number) } },
			})),
		]);
		const researcher = j.requests.findLast(
			({ role }) => role === "researcher",
		)!.context;
		j.requests
			.filter(({ role }) => role === "researcher")
			.forEach(({ context }, index) => {
				expect(context.systemPrompt).toContain(`Response ${index + 1} of 50`);
				expect(context.systemPrompt).toContain("Hard cap: 100");
				expect(JSON.stringify(context.messages)).not.toContain(
					"[D3R request budget",
				);
			});
		expect(JSON.parse(journeyResultText(researcher, "search-again"))).toEqual({
			hits: [
				{
					id: url,
					title: url,
					url,
					highlights: ["Journal durability before acknowledgement"],
				},
			],
		});
		expect(JSON.parse(journeyResultText(researcher, "fetch-again"))).toEqual({
			docs: [
				{ url, title: null, text: `${source}\nProvider echo: [REDACTED]` },
			],
		});
		for (const id of [
			"search-first",
			"search-again",
			"fetch-first",
			"fetch-again",
		]) {
			expect(journeyResult(researcher, id)).toMatchObject({
				role: "toolResult",
				isError: false,
			});
		}
		expect(
			researcher.tools?.find(({ name }) => name === "web_search")?.parameters,
		).toMatchObject({
			type: "object",
			required: ["query"],
			additionalProperties: false,
			properties: {
				query: { type: "string" },
				k: { type: "integer", default: 5, maximum: 20 },
			},
		});
		expect(
			researcher.tools?.find(({ name }) => name === "web_fetch")?.parameters,
		).toMatchObject({
			type: "object",
			required: ["urls"],
			additionalProperties: false,
			properties: {
				urls: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: { type: "string", format: "uri" },
				},
			},
		});
		await expect(readFile(resolve(j.cwd, "research.md"), "utf8")).resolves.toBe(
			report,
		);
		const researchCard = journeyTools(f.updates).findLast(
			(update) => update.title === "researcher",
		)!;
		expect(researchCard).toMatchObject({
			status: "completed",
			rawOutput: { status: "completed", summary: report.trim() },
		});
		expect(journeyToolText(researchCard)).toContain(report.trim());
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		j.approval.decide = async () => true;
		await expect(
			f.prompt(
				sessionId,
				"Use the retrieved durability findings in the design.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(
			JSON.stringify(
				j.requests.find(({ role }) => role === "designer")?.context.messages,
			),
		).toContain(source);
		expect(journeyText(f.updates)).toContain(JOURNEY_SUMMARY);

		// oxlint-disable-next-line max-statements -- Reuse the same web and workspace grant probes for retained, new and reloaded sessions.
		const probeScopes = async (
			connection: typeof f,
			id: string,
			reuse = false,
		) => {
			const before = j.requests.length;
			const permissionsBefore = j.permissions.length;
			const networkBefore = network.length;
			const names = ["web_search", "web_fetch"];
			const prompt = "/design Check for new external evidence using web tools.";
			const summary = reuse
				? "Retrieved new evidence using the thread grants."
				: "No new external evidence: web access was declined.";
			scripts.aggregator = journeyDone("Local recon complete.");
			scripts.researcher = [
				journeyCall("web_search", { query: "new evidence" }),
				journeyCall("web_fetch", { urls: [url] }),
				...journeyDone(summary),
			];
			if (!reuse) {
				j.approval.decide = async () => false;
				await expect(connection.prompt(id, prompt)).resolves.toEqual({
					stopReason: "end_turn",
				});
				expect(j.requests).toHaveLength(before);
				expect(network).toHaveLength(networkBefore);
				expect(j.permissions.at(-1)?.toolCall.title).toMatch(
					/^Trust workspace/,
				);
			}
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
			await expect(connection.prompt(id, prompt)).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(
				j.permissions
					.slice(permissionsBefore)
					.map(({ toolCall }) => toolCall.title),
			).toEqual(
				reuse
					? []
					: [
							expect.stringMatching(/^Trust workspace/),
							expect.stringMatching(/^Trust workspace/),
							...names,
						],
			);
			expect(network).toHaveLength(networkBefore + (reuse ? names.length : 0));
			const { context } = j.requests.findLast(
				({ role }) => role === "researcher",
			)!;
			for (const name of names) {
				expect(journeyResult(context, name)).toMatchObject({ isError: !reuse });
				expect(journeyResultText(context, name)).toMatch(
					reuse ? /sources.example/ : /denied/i,
				);
			}
			expect(
				journeyTools(connection.updates).findLast(
					(update) => update.title === "researcher",
				),
			).toMatchObject({ status: "completed", rawOutput: { summary } });
			scripts.designer = journeyDone(
				"Updated design based on available evidence.",
			);
			await expect(
				connection.prompt(id, "Use the available evidence."),
			).resolves.toEqual({ stopReason: "end_turn" });
			const workspacePermissions = j.permissions.length;
			const created = `scope-probe-${workspacePermissions}.md`;
			await writeFile(resolve(j.cwd, "scope-edit.txt"), "Before\n");
			scripts.router = [
				journeyCall("read_file", { path: "scope-edit.txt" }, "scope-read"),
				(observed) =>
					journeyCall(
						"edit_file",
						{
							path: "scope-edit.txt",
							oldText: "Before",
							newText: "After",
							snapshot: /^Snapshot: ([a-f0-9]{64})/m.exec(
								journeyResultText(observed, "scope-read"),
							)?.[1],
						},
						"scope-edit",
					),
				journeyCall(
					"write_file",
					{ path: created, content: "Follow-up report\n" },
					"scope-write",
				),
				[
					{
						type: "text",
						text: "Workspace follow-up finished within the current permissions.",
					},
				],
			];
			await expect(
				connection.prompt(
					id,
					"Update scope-edit.txt and save a follow-up report directly, without starting another phase.",
				),
			).resolves.toEqual({ stopReason: "end_turn" });
			expect(
				j.permissions
					.slice(workspacePermissions)
					.map(({ toolCall }) => toolCall.title),
			).toEqual(reuse ? [] : ["edit_file", "write_file"]);
			const router = j.requests.findLast(
				({ role }) => role === "router",
			)!.context;
			for (const call of ["scope-edit", "scope-write"]) {
				expect(journeyResult(router, call), call).toMatchObject({
					isError: !reuse,
				});
			}
			await expect(
				readFile(resolve(j.cwd, "scope-edit.txt"), "utf8"),
			).resolves.toBe(reuse ? "After\n" : "Before\n");
			await (reuse
				? expect(readFile(resolve(j.cwd, created), "utf8")).resolves.toBe(
						"Follow-up report\n",
					)
				: expect(readFile(resolve(j.cwd, created))).rejects.toMatchObject({
						code: "ENOENT",
					}));
		};
		await probeScopes(f, sessionId, true);
		const fresh = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId: fresh.sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await probeScopes(f, fresh.sessionId);
		const saved = await f.saved(sessionId);
		await f.close();
		const resumed = await j.connect();
		const networkBeforeLoad = network.length;
		const requestsBeforeLoad = j.requests.length;
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		expect(network).toHaveLength(networkBeforeLoad);
		expect(j.requests).toHaveLength(requestsBeforeLoad);
		await probeScopes(resumed, sessionId);
		for (const state of [saved, await resumed.saved(sessionId)]) {
			const text = JSON.stringify(state);
			expect(text).not.toContain("allow_scope");
			expect(text).not.toMatch(
				/exa:web_(search|fetch)|d3r:native:workspace-edits/,
			);
			expect(text).not.toContain(key);
			expect(text).not.toContain(encodeURIComponent(key));
		}
		expect(
			JSON.stringify([j.requests, j.permissions, f.updates, resumed.updates]),
		).not.toContain(key);
		expect(
			JSON.stringify(j.requests.flatMap(({ context }) => context.messages)),
		).not.toContain('"name":"run_command"');
		expect(
			j.permissions.some(
				({ toolCall }) =>
					toolCall.kind === "execute" &&
					!toolCall.title?.startsWith("Trust workspace"),
			),
		).toBe(false);
		for (const { headers, body, url: endpoint } of network) {
			expect(headers["x-api-key"]).toBe(key);
			expect(headers["content-type"]).toBe("application/json");
			expect(
				JSON.stringify([
					endpoint,
					body,
					Object.entries(headers).filter(([name]) => name !== "x-api-key"),
				]),
			).not.toContain(key);
		}
		expect(unhandled).toEqual([]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Independent held grants prove both retained-context completion and a real hard-cap stop.
	it("extends a role at its last request through ACP without extending its sibling or passing the hard cap", async () => {
		const extension = (reason: string) =>
			journeyCall("d3r_request_extension", { reason });
		const read = journeyCall("read_file", { path: "brief.txt" });
		const summary =
			"Research confirms the queue must retain acknowledged jobs.";
		const scripts: JourneyScripts = {
			researcher: [
				read,
				read,
				extension("Save research evidence and synthesize the report"),
				(context) =>
					journeyCall("write_file", {
						path: "research.md",
						content: journeyResultText(context, "read_file"),
					}),
				...journeyDone(summary),
				[{ type: "text", text: "Unbudgeted researcher request" }],
			],
			aggregator: [
				read,
				read,
				extension("Inspect remaining local constraints"),
				read,
				read,
				extension("Must not exceed the hard cap"),
				[{ type: "text", text: "Unbudgeted aggregator request" }],
			],
		};
		const j = await open(scripts, {
			createRuntime: (options) =>
				createEmbeddedRuntime({
					...options,
					...(options.budgetLabel === "workflow summary" ? {} : JOURNEY_BUDGET),
				}),
		});
		await writeFile(
			resolve(j.cwd, "brief.txt"),
			"The queue must retain acknowledged jobs.",
		);
		const grants = {
			researcher: deferred<JourneyDecision>(),
			aggregator: deferred<JourneyDecision>(),
		};
		j.approval.decide = async ({ toolCall }) => {
			if (toolCall.title?.startsWith("Extend request budget (researcher)")) {
				return grants.researcher.promise;
			}
			if (toolCall.title?.startsWith("Extend request budget (aggregator)")) {
				return grants.aggregator.promise;
			}
			return true;
		};
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const request =
			"/design Research brief.txt; request any extra model allowance with d3r_request_extension, then save and report within the approved budget.";
		const pending = f.prompt(sessionId, request);
		const extensions = () =>
			j.permissions.filter(({ toolCall }) =>
				toolCall.title?.startsWith("Extend request budget"),
			);
		const contexts = (role: string) =>
			j.requests
				.filter((entry) => entry.role === role)
				.map(({ context }) => context);
		try {
			await vi.waitFor(() =>
				expect(extensions()).toHaveLength(Object.keys(grants).length),
			);
			for (const role of ["researcher", "aggregator"] as const) {
				expect(contexts(role)).toHaveLength(JOURNEY_BUDGET.maxTurns);
				const permission = extensions().find(({ toolCall }) =>
					toolCall.title?.includes(`(${role})`),
				)!;
				expect(permission.toolCall).toMatchObject({
					title: `Extend request budget (${role}): 3 -> 6 (hard cap 6)`,
					rawInput: {
						reason:
							role === "researcher"
								? "Save research evidence and synthesize the report"
								: "Inspect remaining local constraints",
						additionalRequests: 3,
						currentLimit: 3,
						requestedLimit: 6,
						maxTotalTurns: 6,
					},
				});
				expect(permission.options.map(({ kind }) => kind)).toEqual([
					"allow_once",
					"reject_once",
					"allow_always",
				]);
			}
			await f.peer.agent.request("session/list", {});
			expect(contexts("researcher")).toHaveLength(JOURNEY_BUDGET.maxTurns);
			await expect(
				readFile(resolve(j.cwd, "research.md")),
			).rejects.toMatchObject({ code: "ENOENT" });
			grants.researcher.resolve("allow_scope");
			await vi.waitFor(() =>
				expect(
					journeyTools(f.updates).findLast(
						(update) => update.title === "researcher",
					)?.status,
				).toBe("completed"),
			);
			expect(contexts("researcher")).toHaveLength(JOURNEY_BUDGET.maxTotalTurns);
			expect(contexts("aggregator")).toHaveLength(JOURNEY_BUDGET.maxTurns);
			grants.aggregator.resolve(true);
			await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		} finally {
			grants.researcher.resolve(false);
			grants.aggregator.resolve(false);
			await f.peer.agent.notify("session/cancel", { sessionId });
			await pending;
		}
		const researcher = contexts("researcher");
		const firstExtended = researcher[JOURNEY_BUDGET.maxTurns];
		expect(
			firstExtended.messages.slice(
				0,
				researcher[JOURNEY_BUDGET.maxTurns - 1].messages.length,
			),
		).toEqual(researcher[JOURNEY_BUDGET.maxTurns - 1].messages);
		expect(journeyResultText(firstExtended, "d3r_request_extension")).toMatch(
			/approved.*invocation only/i,
		);
		expect(journeyResult(firstExtended, "d3r_request_extension")).toMatchObject(
			{ isError: false },
		);
		await expect(
			readFile(resolve(j.cwd, "research.md"), "utf8"),
		).resolves.toContain("The queue must retain acknowledged jobs.");
		expect(
			journeyTools(f.updates).findLast(
				(update) => update.title === "researcher",
			),
		).toMatchObject({
			status: "completed",
			rawOutput: { status: "completed", summary },
		});
		expect(
			journeyTools(f.updates).findLast(
				(update) => update.title === "aggregator",
			),
		).toMatchObject({
			status: "failed",
			rawOutput: { error: expect.stringContaining("request_limit") },
		});
		expect(extensions()).toHaveLength(Object.keys(grants).length);
		for (const role of ["researcher", "aggregator"]) {
			expect(contexts(role)).toHaveLength(JOURNEY_BUDGET.maxTotalTurns);
			expect(scripts[role]).toHaveLength(1);
			contexts(role).forEach((context, index) => {
				const limit =
					index < JOURNEY_BUDGET.maxTurns
						? JOURNEY_BUDGET.maxTurns
						: JOURNEY_BUDGET.maxTotalTurns;
				expect(context.systemPrompt).toContain(
					`Response ${index + 1} of ${limit}`,
				);
				expect(context.systemPrompt).toContain(
					`Remaining model requests: ${limit - index}, including this response`,
				);
				expect(context.systemPrompt).toContain("Hard cap: 6");
				expect(
					context.systemPrompt?.match(/\[D3R request budget -/g),
				).toHaveLength(1);
				expect(
					context.messages.filter((message) => message.role === "user"),
				).toHaveLength(1);
				expect(JSON.stringify(context.messages)).toContain(request);
				expect(JSON.stringify(context.messages)).not.toContain(
					"[D3R request budget",
				);
			});
		}
		expect(
			researcher[0].tools?.find(({ name }) => name === "d3r_request_extension")
				?.parameters,
		).toMatchObject({
			type: "object",
			required: ["reason"],
			properties: {
				reason: { type: "string", minLength: 1 },
				additionalRequests: {
					type: "integer",
					exclusiveMinimum: 0,
					maximum: 50,
				},
			},
		});
		expect(JSON.stringify(await f.saved(sessionId))).not.toContain(
			"[D3R request budget",
		);
		expect(
			journeyTools(f.updates)
				.filter((update) => update.title === "d3r_request_extension")
				.map(journeyToolText)
				.join("\n"),
		).toContain("hard-cap headroom");
	});

	// oxlint-disable-next-line max-statements -- Denial and permission-dialog cancellation leave both recon roles enough initial budget to save partial findings.
	it("finalizes partial reports after denied and cancelled extensions without repeated permission prompts", async () => {
		const roles = ["researcher", "aggregator"] as const;
		const scripts: JourneyScripts = Object.fromEntries(
			roles.map((role) => [
				role,
				[
					journeyCall("d3r_request_extension", {
						reason: `Gather more evidence for ${role}`,
						additionalRequests: 3,
					}),
					[
						...journeyCall("d3r_request_extension", {
							reason: "Retry must not prompt",
							additionalRequests: 1,
						}),
						...journeyCall("write_file", {
							path: `${role}-partial.md`,
							content: `Partial ${role} findings: additional research was not authorized.\n`,
						}),
						...journeyReport(
							`Partial ${role} findings; further evidence remains unverified.`,
						),
					],
					[
						{
							type: "text",
							text: `Saved partial ${role} findings within the original allowance.`,
						},
					],
					[{ type: "text", text: "Unapproved extra request" }],
				],
			]),
		);
		const j = await open(scripts, {
			createRuntime: (options) =>
				createEmbeddedRuntime({
					...options,
					...(options.budgetLabel === "workflow summary" ? {} : JOURNEY_BUDGET),
				}),
		});
		j.approval.decide = async ({ toolCall }) => {
			if (toolCall.title?.startsWith("Extend request budget (researcher)")) {
				return false;
			}
			if (toolCall.title?.startsWith("Extend request budget (aggregator)")) {
				return "cancelled";
			}
			return true;
		};
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(
			f.prompt(
				sessionId,
				"/design Gather evidence; use d3r_request_extension if needed, but save partial findings and report limitations if not approved.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const extensions = j.permissions.filter(({ toolCall }) =>
			toolCall.title?.startsWith("Extend request budget"),
		);
		expect(extensions).toHaveLength(roles.length);
		await Promise.all(
			roles.map(async (role) => {
				const contexts = j.requests
					.filter((entry) => entry.role === role)
					.map(({ context }) => context);
				expect(contexts).toHaveLength(JOURNEY_BUDGET.maxTurns);
				expect(scripts[role]).toHaveLength(1);
				expect(
					extensions.filter(({ toolCall }) =>
						toolCall.title?.includes(`(${role})`),
					),
				).toHaveLength(1);
				expect(
					journeyResult(contexts[1], "d3r_request_extension"),
				).toMatchObject({ isError: true });
				expect(
					journeyResultText(contexts[1], "d3r_request_extension"),
				).toContain("Budget unchanged");
				expect(
					journeyResultText(contexts.at(-1)!, "d3r_request_extension"),
				).toContain("already denied");
				contexts.forEach((context, index) => {
					expect(context.systemPrompt).toContain(`Response ${index + 1} of 3`);
					expect(context.systemPrompt).toContain(
						`Remaining model requests: ${JOURNEY_BUDGET.maxTurns - index}`,
					);
					if (index > 0) {
						expect(context.systemPrompt).toContain("No extension is available");
					}
					expect(JSON.stringify(context.messages)).not.toContain(
						"[D3R request budget",
					);
				});
				await expect(
					readFile(resolve(j.cwd, `${role}-partial.md`), "utf8"),
				).resolves.toBe(
					`Partial ${role} findings: additional research was not authorized.\n`,
				);
				const card = journeyTools(f.updates).findLast(
					(update) => update.title === role,
				)!;
				expect(card).toMatchObject({
					status: "completed",
					rawOutput: {
						status: "completed",
						summary: `Partial ${role} findings; further evidence remains unverified.`,
					},
				});
				expect(journeyToolText(card)).toContain(
					`Saved partial ${role} findings within the original allowance.`,
				);
			}),
		);
		expect(
			j.permissions.filter(({ toolCall }) => toolCall.title === "write_file"),
		).toHaveLength(roles.length);
		for (const { options } of j.permissions) {
			expect(options.map(({ kind }) => kind)).toEqual([
				"allow_once",
				"reject_once",
				"allow_always",
			]);
		}
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(JSON.stringify(await f.saved(sessionId))).not.toContain(
			"Request extension approved",
		);
	});

	// oxlint-disable-next-line max-statements -- Prove live overlap, independent context, durable replay and continuation in one real-stack journey.
	it("keeps overlapping role text and thoughts in their cards through reload and continuation", async () => {
		const roles = ["aggregator", "researcher"] as const;
		const started = {
			aggregator: deferred<void>(),
			researcher: deferred<void>(),
		};
		const streamed = {
			aggregator: deferred<void>(),
			researcher: deferred<void>(),
		};
		const release = deferred<void>();
		const finish = deferred<void>();
		const scripts: JourneyScripts = {
			router: [[{ type: "text", text: "Coordinator greeting" }]],
			designer: [
				journeyReport("Designed from both outcomes"),
				[{ type: "text", text: "Designer response" }],
			],
		};
		for (const role of roles) {
			scripts[role] = [
				[
					{ type: "text", text: `${role} opening` },
					{ type: "thinking", thinking: `${role} private thought` },
					{ type: "text", text: `${role} closing` },
					...journeyReport(`${role} structured outcome`),
				],
				[{ type: "text", text: `${role} final response` }],
			];
		}
		const j = await open(scripts, {
			streamResponse: (role, content) =>
				journeyStream(content, async (index) => {
					if (
						(role === "aggregator" || role === "researcher") &&
						content.some((part) => part.type === "thinking")
					) {
						if (index === 1) {
							started[role].resolve();
							await release.promise;
						}
						// Three deltas have passed through the real embedded loop, but neither report has run.
						const doneEventIndex = 4;
						if (index === doneEventIndex) {
							streamed[role].resolve();
							await finish.promise;
						}
					}
				}),
		});
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await f.prompt(sessionId, "Hello coordinator");
		const pending = f.prompt(sessionId, "/design Investigate two approaches");
		try {
			await Promise.all(roles.map((role) => started[role].promise));
			const initial = journeyTools(f.updates).filter(
				(update) =>
					update.sessionUpdate === "tool_call" &&
					roles.some((role) => role === update.title),
			);
			expect(initial.map(({ title }) => title).toSorted()).toEqual([...roles]);
			expect(initial.every(({ status }) => status === "in_progress")).toBe(
				true,
			);
			release.resolve();
			await Promise.all(roles.map((role) => streamed[role].promise));
			await f.peer.agent.request("session/list", {});
			for (const row of initial) {
				const live = journeyTools(f.updates).findLast(
					(update) => update.toolCallId === row.toolCallId,
				)!;
				expect(live.status).toBe("in_progress");
				expect(journeyToolText(live)).toContain(
					`Response\n\n${row.title} opening`,
				);
				expect(journeyToolText(live)).toContain(
					`Response\n\n${row.title} closing`,
				);
				expect(journeyToolText(live)).toContain(
					`Thought\n\n${row.title} private thought`,
				);
			}
			expect(journeyText(f.updates)).toBe("Coordinator greeting");
		} finally {
			release.resolve();
			finish.resolve();
		}
		await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		const completed = roles.map(
			(role) =>
				journeyTools(f.updates).findLast((update) => update.title === role)!,
		);
		for (const [index, role] of roles.entries()) {
			const row = completed[index];
			expect(row).toMatchObject({
				status: "completed",
				rawOutput: {
					status: "completed",
					summary: `${role} structured outcome`,
				},
			});
			expect(journeyToolText(row)).toContain(`${role} final response`);
			const other = role === "aggregator" ? "researcher" : "aggregator";
			expect(journeyToolText(row)).not.toContain(other);
			const ownContext = j.requests.findLast(
				(request) => request.role === role,
			)!;
			expect(JSON.stringify(ownContext.context.messages)).toContain(
				`${role} private thought`,
			);
			expect(JSON.stringify(ownContext.context.messages)).not.toContain(
				`${other} private thought`,
			);
		}
		expect(
			f.updates.every((notification) => notification.sessionId === sessionId),
		).toBe(true);
		expect(
			f.updates.some(
				({ update }) => update.sessionUpdate === "agent_thought_chunk",
			),
		).toBe(false);
		expect(journeyText(f.updates)).not.toMatch(
			/opening|closing|private thought|final response/,
		);
		const beforeReload = j.requests.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		expect(j.requests).toHaveLength(beforeReload);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		for (const row of completed) {
			const replay = journeyTools(resumed.updates).filter(
				(update) => update.toolCallId === row.toolCallId,
			);
			const initialAndLatest = 2;
			expect(replay).toHaveLength(initialAndLatest);
			expect(replay[0].status).toBe("in_progress");
			expect(replay[1]).toEqual(row);
		}
		expect(journeyText(resumed.updates)).not.toMatch(
			/opening|closing|private thought|final response/,
		);
		expect(
			resumed.updates.some(
				({ update }) => update.sessionUpdate === "agent_thought_chunk",
			),
		).toBe(false);
		await expect(
			resumed.prompt(sessionId, "Combine both approaches"),
		).resolves.toEqual({ stopReason: "end_turn" });
		const designer = j.requests
			.slice(beforeReload)
			.find(({ role }) => role === "designer")!;
		for (const role of roles) {
			expect(JSON.stringify(designer.context.messages)).toContain(
				`${role} structured outcome`,
			);
			expect(JSON.stringify(designer.context.messages)).not.toContain(
				`${role} private thought`,
			);
		}
		expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		expect(journeyText(resumed.updates)).not.toContain("Designer response");
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Follow the evidence, buffered response, persisted replay and next routing turn together.
	it("legacy compatibility: synthesizes completed design evidence once with the current model, then replays and routes with the cached Markdown", async () => {
		const selected = {
			...JOURNEY_MODEL,
			id: "synthesis",
			name: "Selected model",
		};
		const prior = "Keep the queue offline; deployment has not been approved.";
		const greeting = "I will keep deployment separate from this design phase.";
		const request = "/design Plan a durable offline queue";
		const answer =
			"Use an append-only log; do not deploy until restart tests pass.";
		const reports = {
			aggregator:
				"Existing jobs must survive restarts; deployment is not approved.",
			researcher:
				"An append-only log avoids a network dependency but needs restart testing.",
			designer:
				"Saved design.md with log recovery and restart tests; no implementation or deployment was performed.",
		};
		const design =
			"# Durable queue\n\nUse an append-only log. Test recovery before deployment.\n";
		const opening =
			"## Design ready\n\nThe [queue design](design.md) records log-based recovery for durable offline jobs.";
		const conclusion =
			"\n\nAn append-only log preserves pending jobs without a network service, following your decision. Implementation and deployment have not started.\n\n**Next:** Review the design, use `/delegate` to plan implementation, and require passing restart tests before approving deployment.";
		const markdown = opening + conclusion;
		const buffered = deferred<void>();
		const release = deferred<void>();
		const scripts: JourneyScripts = {
			router: [
				[{ type: "text", text: greeting }],
				[
					{
						type: "text",
						text: "Review the design before starting `/delegate`.",
					},
				],
			],
			aggregator: journeyDone(reports.aggregator),
			researcher: journeyDone(reports.researcher),
			designer: [
				journeyCall("write_file", { path: "design.md", content: design }),
				...journeyDone(reports.designer),
			],
			summary: [
				[
					{ type: "thinking", thinking: "Private summary deliberation" },
					{ type: "text", text: opening },
					{ type: "text", text: conclusion },
				],
			],
		};
		const attachmentText =
			"Attachment bytes: customer backlog must remain available offline.";
		const resourceReads: string[] = [];
		const j = await open(scripts, {
			models: [JOURNEY_MODEL, selected],
			createRuntime: (options) =>
				createEmbeddedRuntime({
					...options,
					resolveResource: async (resource, context) => {
						resourceReads.push(options.budgetLabel!);
						return options.resolveResource!(resource, context);
					},
				}),
			streamResponse: (role, content) =>
				journeyStream(content, async (index) => {
					// Both text deltas and the thought have entered Pi before its terminal event.
					const doneEventIndex = 4;
					if (role === "summary" && index === doneEventIndex) {
						buffered.resolve();
						await release.promise;
					}
				}),
		});
		const brief = resolve(j.cwd, "brief.txt");
		await writeFile(brief, attachmentText);
		const attachment = {
			type: "resource_link" as const,
			uri: pathToFileURL(brief).href,
			name: "queue brief",
			mimeType: "text/plain",
		};
		const f = await j.connect();
		const { sessionId } = await f.legacySession();
		expect(
			journeyCheckpoint(await f.checkpoint(sessionId)).inner,
		).not.toHaveProperty("orchestrated");
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await f.prompt(sessionId, prior);
		await expect(
			f.peer.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: request }, attachment],
			}),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(j.requests.map(({ role }) => role).toSorted()).toEqual([
			"aggregator",
			"aggregator",
			"researcher",
			"researcher",
			"router",
		]);
		const waiting = journeyCheckpoint(await f.checkpoint(sessionId)).inner!;
		expect(waiting.engine).toMatchObject({
			status: "waiting",
			pause: { kind: "human" },
		});
		expect(waiting).not.toHaveProperty("summary");
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(selected),
		});
		const completionStart = f.updates.length;
		const pending = f.prompt(sessionId, answer);
		try {
			await buffered.promise;
			await f.peer.agent.request("session/list", {});
			expect(journeyText(f.updates.slice(completionStart))).toBe("");
			expect(
				journeyResult(
					j.requests.findLast(({ role }) => role === "designer")!.context,
					"write_file",
				),
			).toMatchObject({ isError: false });
			expect(await readFile(resolve(j.cwd, "design.md"), "utf8")).toBe(design);
			for (const [role, summary] of Object.entries(reports)) {
				expect(
					journeyTools(f.updates).findLast((row) => row.title === role),
				).toMatchObject({
					status: "completed",
					rawOutput: { status: "completed", summary },
				});
			}
		} finally {
			release.resolve();
		}
		await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		const summaries = j.requests.filter(({ role }) => role === "summary");
		expect(summaries).toHaveLength(1);
		const [{ context, model }] = summaries;
		expect(model).toEqual(selected);
		expect(context.systemPrompt).toMatch(
			/^You summarize completed D3R workflows\./,
		);
		expect(context.systemPrompt).toContain("do not concatenate individual");
		expect(context.systemPrompt).not.toContain(
			"Preserve the offline user's requirements.",
		);
		expect(context.tools).toEqual([]);
		expect(context.messages).toHaveLength(1);
		const [message] = context.messages;
		expect(message.role).toBe("user");
		if (message.role !== "user" || typeof message.content === "string") {
			throw new Error("Expected one isolated user evidence message");
		}
		expect(message.content).toHaveLength(1);
		const [part] = message.content;
		if (part.type !== "text") {
			throw new Error("Expected text-only JSON evidence");
		}
		expect(JSON.parse(part.text)).toEqual({
			workflow: {
				command: "design",
				description: "Design phase - produce design.md from a topic",
			},
			operatorInput: [
				request,
				`Referenced resource: queue brief (${attachment.uri})`,
				answer,
			],
			priorContext: [
				`Routing user:\n${prior}`,
				`Routing response:\n${greeting}`,
			],
			results: [
				{
					role: "aggregator",
					status: "completed",
					outcome: { status: "completed", summary: reports.aggregator },
				},
				{
					role: "researcher",
					status: "completed",
					outcome: { status: "completed", summary: reports.researcher },
				},
				{
					status: "completed",
					question: "Discuss design questions before drafting",
					answer,
				},
				{
					role: "designer",
					status: "completed",
					outcome: { status: "completed", summary: reports.designer },
				},
			],
		});
		expect(part.text).not.toContain(attachmentText);
		expect(resourceReads.toSorted()).toEqual([
			"aggregator",
			"designer",
			"researcher",
		]);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"aggregator",
			"researcher",
			"designer",
			"workflow summary",
		]);
		const synthesis = j.runtimes.at(-1)!;
		expect(synthesis.options).toMatchObject({
			tools: [],
			maxTurns: 1,
			maxTotalTurns: 1,
			model: selected,
		});
		expect(new Set(j.runtimes.map(({ input }) => input.sessionId)).size).toBe(
			j.runtimes.length,
		);
		expect(journeyText(f.updates.slice(completionStart))).toBe(markdown);
		expect(
			f.updates
				.slice(completionStart)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		expect(
			f.updates.some(
				({ update }) => update.sessionUpdate === "agent_thought_chunk",
			),
		).toBe(false);
		expect(
			journeyTools(f.updates)
				.filter((row) => row.sessionUpdate === "tool_call")
				.map(({ title }) => title)
				.toSorted(),
		).toEqual([
			"aggregator",
			"d3r_report",
			"d3r_report",
			"d3r_report",
			"designer",
			"researcher",
			"write_file",
		]);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			"write_file",
		]);
		const checkpoint = await f.checkpoint(sessionId);
		const completed = journeyCheckpoint(checkpoint).inner!;
		expect(completed).not.toHaveProperty("topic");
		expect(completed).toMatchObject({
			summary: markdown,
			phase: "routing",
			engine: { status: "completed" },
		});
		expect(completed.engine!.records).toHaveLength(
			Object.keys(reports).length + 1,
		);
		const reconRecords = waiting.engine!.records.filter(
			({ status }) => status === "completed",
		);
		expect(completed.engine!.records.slice(0, reconRecords.length)).toEqual(
			reconRecords,
		);
		expect(
			completed
				.engine!.records.filter(({ role }) => role)
				.map(({ role, outcome, status }) => ({ role, outcome, status })),
		).toEqual(
			Object.entries(reports).map(([role, summary]) => ({
				role,
				outcome: { status: "completed", summary },
				status: "completed",
			})),
		);
		const effects = {
			requests: j.requests.length,
			runtimes: j.runtimes.length,
			permissions: j.permissions.length,
			resourceReads: resourceReads.length,
		};
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(
			resumed.updates.filter(
				({ update }) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text === markdown,
			),
		).toHaveLength(1);
		expect(j.requests).toHaveLength(effects.requests);
		expect(j.runtimes).toHaveLength(effects.runtimes);
		expect(j.permissions).toHaveLength(effects.permissions);
		expect(resourceReads).toHaveLength(effects.resourceReads);
		const routingStart = resumed.updates.length;
		await expect(
			resumed.prompt(sessionId, "What should I do next?"),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(j.requests.slice(effects.requests).map(({ role }) => role)).toEqual([
			"router",
		]);
		const next = j.requests.at(-1)!;
		expect(
			journeyCheckpoint(await resumed.checkpoint(sessionId)).inner,
		).not.toHaveProperty("topic");
		expect(next.model).toEqual(selected);
		expect(JSON.stringify(next.context.messages)).toContain(
			JSON.stringify(`Workflow summary (/design):\n${markdown}`).slice(1, -1),
		);
		expect(journeyText(resumed.updates.slice(routingStart))).toBe(
			"Review the design before starting `/delegate`.",
		);
		expect(journeyTools(resumed.updates.slice(routingStart))).toEqual([]);
		expect(await readFile(resolve(j.cwd, "design.md"), "utf8")).toBe(design);
		expect(
			journeyCheckpoint(await resumed.checkpoint(sessionId)).inner,
		).toMatchObject({
			engine: null,
			history: expect.arrayContaining([
				{ type: "text", text: `Workflow summary (/design):\n${markdown}` },
			]),
		});
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	it.each([
		"provider failure",
		"JSON",
		"fenced JSON",
		"empty",
		"oversized",
		"cancelled",
	] as const)(
		"legacy compatibility: retains completed work across %s synthesis and reload without partial output or reruns",
		// oxlint-disable-next-line max-statements -- Keep final effects, failed synthesis, reload and continuation in one acceptance journey.
		async (failure) => {
			const partial = "Unfinished summary must never be shown";
			const reports = {
				planner: "Planned bounded queue tasks with explicit recovery tests.",
				schemer:
					"Saved tasks.md with the recovery schema; implementation has not started.",
			};
			const artifact =
				"# Queue tasks\n\nImplement recovery, then verify restart behavior.\n";
			const oversizedLength = 8193;
			const output = {
				"provider failure": partial,
				JSON: JSON.stringify({ summary: reports }),
				"fenced JSON": `## Done\n\n\`\`\`json\n${JSON.stringify(reports)}\n\`\`\``,
				empty: " \n ",
				oversized: "x".repeat(oversizedLength),
				cancelled: partial,
			}[failure];
			const fallback =
				"**Workflow /delegate completed.**\n\nSummary unavailable; the completed workflow results have been retained.\n\n**Next:** Review the results, then use `/develop` when ready.";
			const streamed = deferred<void>();
			const scripts: JourneyScripts = {
				planner: journeyDone(reports.planner),
				schemer: [
					journeyCall("write_file", { path: "tasks.md", content: artifact }),
					...journeyDone(reports.schemer),
				],
				summary: [
					[
						{ type: "thinking", thinking: "Private synthesis reasoning" },
						{ type: "text", text: output },
					],
				],
				router: [
					[{ type: "text", text: "The saved task plan is ready for review." }],
				],
			};
			const j = await open(scripts, {
				streamResponse: (role, content, settings) =>
					journeyStream(content, async (index) => {
						const doneEventIndex = 3;
						if (role !== "summary" || index !== doneEventIndex) {
							return;
						}
						streamed.resolve();
						if (failure === "cancelled") {
							await waitForAbort(settings!.signal!);
						}
						if (failure === "provider failure") {
							throw new Error(
								"Private provider failure after partial synthesis",
							);
						}
					}),
			});
			const f = await j.connect();
			const { sessionId } = await f.legacySession();
			expect(
				journeyCheckpoint(await f.checkpoint(sessionId)).inner,
			).not.toHaveProperty("orchestrated");
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const pending = f.prompt(sessionId, "/delegate Plan the durable queue");
			if (failure === "cancelled") {
				try {
					await streamed.promise;
					await f.peer.agent.request("session/list", {});
					expect(journeyText(f.updates)).toBe("");
					expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(
						artifact,
					);
				} finally {
					await f.peer.agent.notify("session/cancel", { sessionId });
				}
			}
			await expect(pending).resolves.toEqual({
				stopReason: failure === "cancelled" ? "cancelled" : "end_turn",
			});
			const expected = failure === "cancelled" ? "" : fallback;
			expect(journeyText(f.updates)).toBe(expected);
			expect(
				f.updates.filter(
					({ update }) => update.sessionUpdate === "agent_message_chunk",
				),
			).toHaveLength(failure === "cancelled" ? 0 : 1);
			expect(
				f.updates.some(
					({ update }) => update.sessionUpdate === "agent_thought_chunk",
				),
			).toBe(false);
			expect(JSON.stringify(f.updates)).not.toMatch(
				/Unfinished summary|Private synthesis reasoning|Private provider failure/,
			);
			const summaries = j.requests.filter(({ role }) => role === "summary");
			expect(summaries).toHaveLength(1);
			expect(summaries[0].context.tools).toEqual([]);
			expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
				"planner",
				"schemer",
				"workflow summary",
			]);
			expect(
				journeyTools(f.updates)
					.filter((row) => row.sessionUpdate === "tool_call")
					.map(({ title }) => title),
			).toEqual([
				"planner",
				"d3r_report",
				"schemer",
				"write_file",
				"d3r_report",
			]);
			const checkpoint = await f.checkpoint(sessionId);
			const completed = journeyCheckpoint(checkpoint).inner!;
			expect(completed).toMatchObject({
				phase: "routing",
				engine: { status: "completed" },
			});
			if (failure === "cancelled") {
				expect(completed).not.toHaveProperty("summary");
			} else {
				expect(completed.summary).toBe(fallback);
			}
			expect(
				completed.engine!.records.map(({ role, status, outcome }) => ({
					role,
					status,
					outcome,
				})),
			).toEqual(
				Object.entries(reports).map(([role, summary]) => ({
					role,
					status: "completed",
					outcome: { status: "completed", summary },
				})),
			);
			const effects = {
				requests: j.requests.length,
				runtimes: j.runtimes.length,
				permissions: j.permissions.length,
			};
			await f.close();
			const resumed = await j.connect();
			await resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			});
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(journeyText(resumed.updates)).toBe(expected);
			expect(j.requests).toHaveLength(effects.requests);
			expect(j.runtimes).toHaveLength(effects.runtimes);
			expect(j.permissions).toHaveLength(effects.permissions);
			const continuation = resumed.updates.length;
			await expect(resumed.prompt(sessionId, "What next?")).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(
				j.requests.slice(effects.requests).map(({ role }) => role),
			).toEqual(["router"]);
			expect(j.requests.filter(({ role }) => role === "summary")).toHaveLength(
				1,
			);
			expect(journeyTools(resumed.updates.slice(continuation))).toEqual([]);
			expect(journeyText(resumed.updates.slice(continuation))).toBe(
				"The saved task plan is ready for review.",
			);
			const routed = journeyCheckpoint(
				await resumed.checkpoint(sessionId),
			).inner!;
			expect(routed.engine).toBeNull();
			for (const report of Object.values(reports)) {
				expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
					report,
				);
			}
			if (failure !== "cancelled") {
				expect(routed.history).toContainEqual({
					type: "text",
					text: `Workflow summary (/delegate):\n${fallback}`,
				});
			}
			expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(artifact);
			expect(
				j.permissions
					.slice(effects.permissions)
					.map(({ toolCall }) => toolCall.title),
			).toEqual([expect.stringMatching(/^Trust workspace/)]);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
		},
	);

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
		).toEqual(new Set(["router", "aggregator", "researcher"]));
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
		expect(journeyText(resumed.updates.slice(conflictStart))).toContain(
			"Cannot replace unfinished work",
		);
		expect(journeyText(resumed.updates.slice(conflictStart))).toMatch(
			/Phase: design[\s\S]*Status: waiting/,
		);
		const retained = journeyCheckpoint(
			await resumed.checkpoint(sessionId),
		).inner!;
		expect(retained.engine).toEqual(
			journeyCheckpoint(checkpoint).inner!.engine,
		);
		expect(retained.input).toEqual(journeyCheckpoint(checkpoint).inner!.input);
		expect(j.requests.slice(beforeReload).map(({ role }) => role)).toEqual([
			"router",
			"router",
		]);
		await expect(resumed.prompt(sessionId, answer)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(await readFile(resolve(j.cwd, "design.md"), "utf8")).toBe(design);
		expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		const continuation = j.requests.slice(beforeReload);
		expect(new Set(continuation.map(({ role }) => role))).toEqual(
			new Set(["router", "designer"]),
		);
		expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
		const { context } = continuation.find(({ role }) => role === "designer")!;
		expect(JSON.stringify(context.messages)).not.toContain(replacement);
		expect(
			JSON.stringify(
				journeyCheckpoint(await resumed.checkpoint(sessionId)).inner!.input,
			),
		).not.toContain(replacement);
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
			new Set(["router", "aggregator", "researcher"]),
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
		const continuation = j.requests.slice(beforeReload);
		expect(new Set(continuation.map(({ role }) => role))).toEqual(
			new Set(["router", "designer"]),
		);
		expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
		const designer = continuation.filter(({ role }) => role === "designer");
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
		expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		for (const { toolCall } of j.permissions) {
			expect(toolCall.title).toMatch(/^Trust workspace/);
			const preview = journeyToolText(toolCall);
			for (const text of [
				JSON.stringify(j.cwd),
				JSON.stringify(vault),
				"not its parent directory",
				"disk IO, not editor buffers",
				"Native vault operations need no additional approval",
				"commands remain separately authorized",
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

	it(
		"initializes a missing vault only after consent, then shares one generated /design topic across parallel writes and reload",
		// oxlint-disable-next-line max-statements -- Consent, parallel publication and fresh-session continuation form one acceptance journey.
		async () => {
			const scripts: JourneyScripts = {};
			const gates = {
				aggregator: journeyToolGate("vault_write"),
				researcher: journeyToolGate("vault_write"),
			};
			const j = await open(scripts, {
				routerShortcuts: false,
				streamResponse: (role, content, settings) =>
					role === "aggregator" || role === "researcher"
						? gates[role].stream(content, settings?.signal)
						: journeyStream(content),
			});
			const cli = fileURLToPath(
				new URL("../../cli/dist/cli.js", import.meta.url),
			);
			await expect(
				readFile(cli),
				"Run pnpm -r build before the CLI initialization journey",
			).resolves.toBeDefined();
			// The real CLI creates its seed commit, but must never use the operator's Git configuration or home.
			cleanup.push(async () => {
				vi.unstubAllEnvs();
			});
			for (const [name, value] of Object.entries({
				HOME: resolve(j.root, "home"),
				USERPROFILE: resolve(j.root, "home"),
				GIT_CONFIG_GLOBAL: resolve(j.root, "home/.gitconfig"),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_COUNT: "0",
				GIT_AUTHOR_NAME: "D3R journey",
				GIT_AUTHOR_EMAIL: "journey@d3r.invalid",
				GIT_COMMITTER_NAME: "D3R journey",
				GIT_COMMITTER_EMAIL: "journey@d3r.invalid",
				GIT_EDITOR: "true",
			})) {
				vi.stubEnv(name, value);
			}
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const vault = journeyCheckpoint(await f.checkpoint(sessionId)).resources
				.vaultRoot;
			expect(vault).toBe(resolve(j.cwd, ".agents/vault"));
			const goal = "Design an offline job queue";
			const correction =
				"Correction: call this durable dispatch, not a job queue; retain pending jobs across restarts. Draft the design now.";
			const init = (context: JourneyContext) => {
				const guidance = journeyUserText(context)
					.split("\n")
					.find((line) => line.startsWith("With user direction,"))!;
				const literal = JSON.parse(guidance.slice(guidance.indexOf("{"))) as {
					command: string;
					args: string[];
					cwd: string;
				};
				return journeyCall("run_command", literal, "init");
			};
			const writeDocument =
				(kind: string, details: string) => (context: JourneyContext) => {
					const topic = journeyTopic(context);
					const heading = journeyPage(context, "template")
						.text.match(/^# .+$/m)![0]
						.replace(/<[^>]+>/g, topic);
					return journeyCall("vault_write", {
						mode: "doc",
						path: `process/designs/${topic}/${kind}.md`,
						kind,
						frontmatter: { created: "2026-09-10", status: "draft" },
						body: `${heading}\n\n${details}\n`,
					});
				};
			scripts.router = [
				[
					{
						type: "text",
						text: "May I run d3r vault init for the pinned vault? This seeds templates and directories and creates a separate Git repository with an initial commit; it does not push.",
					},
				],
				init,
				[
					{
						type: "text",
						text: "Command approval was denied. No vault was initialized and no document work started.",
					},
				],
				init,
				journeyCall(
					"vault_ls",
					{ path: ".misc/templates" },
					"seeded-templates",
				),
				journeyCall("d3r_start_phase", {
					phase: "design",
					brief: {
						goal,
						context: "Jobs must survive restarts without a network service.",
						acceptanceCriteria: [
							"Write remember, research and design documents in the shared topic directory.",
						],
					},
				}),
				journeyPhaseReply("d3r_start_phase", "Recon complete"),
				journeyCall("d3r_continue_phase", { instructions: correction }),
				journeyPhaseReply("d3r_continue_phase", "Design complete"),
			];
			const recon = [
				{
					role: "aggregator",
					kind: "remember",
					evidence: "Jobs must survive restarts.",
				},
				{
					role: "researcher",
					kind: "research",
					evidence:
						"The supplied offline requirement rules out a network-only queue; external prior art was not consulted.",
				},
			];
			for (const { role, kind, evidence } of recon) {
				scripts[role] = [
					journeyCall(
						"vault_read",
						{ path: `.misc/templates/${kind}.md` },
						"template",
					),
					writeDocument(kind, evidence),
					...journeyDone(evidence),
				];
			}
			scripts.designer = [
				(context) =>
					journeyCall(
						"vault_read",
						{ path: `process/designs/${journeyTopic(context)}/remember.md` },
						"remember",
					),
				(context) =>
					journeyCall(
						"vault_read",
						{ path: `process/designs/${journeyTopic(context)}/research.md` },
						"research",
					),
				journeyCall(
					"vault_read",
					{ path: ".misc/templates/design.md" },
					"template",
				),
				(context) =>
					writeDocument(
						"design",
						`## Decision\n\n${correction}\n\n## Evidence\n\n${journeyPage(context, "remember").text}\n${journeyPage(context, "research").text}`,
					)(context),
				...journeyDone(
					"Designed durable dispatch from both shared recon documents.",
				),
			];
			const files = await readdir(j.cwd, { recursive: true });
			await expect(f.prompt(sessionId, `/design ${goal}`)).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(j.requests.map(({ role }) => role)).toEqual(["router"]);
			const first = j.requests[0].context;
			expect(journeyUserText(first)).toContain("Native vault status: missing.");
			expect(journeyUserText(first)).toContain(
				`Pinned vault root: ${JSON.stringify(vault)}`,
			);
			const invocation = {
				command: process.execPath,
				args: [cli, "vault", "init", "--vault-root", vault],
				cwd: j.cwd,
			};
			expect(isAbsolute(invocation.command)).toBe(true);
			expect(isAbsolute(cli)).toBe(true);
			expect(journeyUserText(first)).toContain(JSON.stringify(invocation));
			expect(journeyUserText(first)).toContain(
				"Do not auto-initialize, run mkdir, or use vault_write",
			);
			expect(journeyUserText(first)).toContain(
				"If the user declines or requests no vault artifacts, continue inline",
			);
			expect(first.systemPrompt).toContain(
				"Never ask the user to invent a topic name",
			);
			expect(journeyText(f.updates)).toMatch(
				/May I run d3r vault init[\s\S]*seeds templates[\s\S]*initial commit/,
			);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			expect(
				journeyTools(f.updates).filter(
					({ title }) => !title?.startsWith("Trust workspace"),
				),
			).toEqual([]);
			expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
			expect(
				journeyCheckpoint(await f.checkpoint(sessionId)).inner,
			).toMatchObject({ engine: null });

			j.approval.decide = async () => false;
			await expect(
				f.prompt(
					sessionId,
					"Yes, initialize the pinned vault including its seed commit, then start /design.",
				),
			).resolves.toEqual({ stopReason: "end_turn" });
			const denied = j.requests.at(-1)!.context;
			expect(journeyResult(denied, "init")).toMatchObject({ isError: true });
			expect(journeyResultText(denied, "init")).toMatch(/denied|not granted/i);
			expect(j.requests.every(({ role }) => role === "router")).toBe(true);
			expect(j.permissions.at(-1)!.toolCall.rawInput).toMatchObject(invocation);
			expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
			await expect(readdir(vault)).rejects.toMatchObject({ code: "ENOENT" });

			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true ||
				(toolCall.rawInput as { command?: string } | undefined)?.command ===
					process.execPath;
			const pending = f.prompt(
				sessionId,
				"Retry initialization; I will approve the command, then save recon in the trusted vault.",
			);
			try {
				const writes = await Promise.race([
					Promise.all(
						Object.values(gates).map(({ reached }) => reached.promise),
					),
					pending.then(() => {
						throw new Error("Recon ended before both provider write gates");
					}),
				]);
				const router = j.requests.findLast(
					({ role }) => role === "router",
				)!.context;
				const commands = router.messages.flatMap((message) =>
					message.role === "assistant"
						? message.content.flatMap((part) =>
								part.type === "toolCall" && part.name === "run_command"
									? [part.arguments]
									: [],
							)
						: [],
				);
				expect(commands).toEqual([invocation, invocation]);
				expect(
					j.permissions
						.filter(
							({ toolCall }) =>
								toolCall.kind === "execute" &&
								!toolCall.title?.startsWith("Trust workspace"),
						)
						.map(({ toolCall }) => toolCall.rawInput),
				).toEqual([
					expect.objectContaining(invocation),
					expect.objectContaining(invocation),
				]);
				expect(journeyResult(router, "init")).toMatchObject({ isError: false });
				expect(journeyResultText(router, "init")).toContain("Exit code: 0");
				expect(journeyResult(router, "seeded-templates")).toMatchObject({
					isError: false,
				});
				expect(journeyResultText(router, "seeded-templates")).toContain(
					"remember.md",
				);
				const topic = journeyTopic(
					j.requests.find(({ role }) => role === "aggregator")!.context,
				);
				expect(topic).toMatch(/^design-an-offline-job-queue-[a-z0-9]+$/);
				expect(
					writes
						.flatMap((content) =>
							content.flatMap((part) =>
								part.type === "toolCall" ? [part.arguments.path] : [],
							),
						)
						.toSorted(),
				).toEqual([
					`process/designs/${topic}/remember.md`,
					`process/designs/${topic}/research.md`,
				]);
				// Provider IO holds both roles before publication, not obsolete per-vault approvals.
				await expect(
					readdir(resolve(vault, "process/designs", topic)),
				).rejects.toMatchObject({ code: "ENOENT" });
				const { stdout } = await promisify(execFile)(
					"git",
					["--no-pager", "-C", vault, "log", "--format=%s"],
					{ timeout: 5000 },
				);
				expect(stdout.trim()).toBe("chore: initial vault seed");
			} finally {
				Object.values(gates).forEach(({ release }) => release.resolve());
			}
			await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
			expect(
				j.permissions.some(({ toolCall }) =>
					toolCall.title?.startsWith("vault_"),
				),
			).toBe(false);
			const checkpoint = await f.checkpoint(sessionId);
			const waiting = journeyCheckpoint(checkpoint).inner!;
			const topic = waiting.topic!;
			expect(waiting.engine).toMatchObject({
				status: "waiting",
				pause: { kind: "human" },
			});
			expect(journeyText(f.updates)).toContain(
				"Discuss design questions before drafting",
			);
			await Promise.all(
				recon.map(async ({ role, kind }) => {
					const contexts = j.requests
						.filter((request) => request.role === role)
						.map(({ context }) => context);
					expect(journeyTopic(contexts[0])).toBe(topic);
					expect(journeyPage(contexts.at(-1)!, "template").text).toBe(
						await readFile(
							resolve(SEED_ROOT, `.misc/templates/${kind}.md`),
							"utf8",
						),
					);
					expect(journeyResult(contexts.at(-1)!, "vault_write")).toMatchObject({
						isError: false,
					});
					expect(JSON.stringify(contexts)).not.toContain(
						"Native vault status:",
					);
				}),
			);
			expect(
				JSON.stringify([waiting.input, waiting.routingInput]),
			).not.toContain("Native vault status:");
			expect(await readdir(resolve(vault, "process/designs", topic))).toEqual([
				"remember.md",
				"research.md",
			]);
			const effects = {
				requests: j.requests.length,
				permissions: j.permissions.length,
			};
			await f.peer.agent.request("session/close", { sessionId });
			await f.close();
			const resumed = await j.connect();
			await resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			});
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(j.requests).toHaveLength(effects.requests);
			expect(j.permissions).toHaveLength(effects.permissions);
			await expect(resumed.prompt(sessionId, correction)).resolves.toEqual({
				stopReason: "end_turn",
			});
			const continuation = j.requests.slice(effects.requests);
			expect(new Set(continuation.map(({ role }) => role))).toEqual(
				new Set(["router", "designer"]),
			);
			const router = continuation[0].context;
			expect(journeyUserText(router)).toContain(
				"Native vault status: available.",
			);
			expect(journeyUserText(router)).toContain("Current task topic:");
			expect(journeyTopic(router)).toBe(topic);
			const designer = continuation.findLast(
				({ role }) => role === "designer",
			)!.context;
			expect(journeyTopic(designer)).toBe(topic);
			expect(journeyUserText(designer)).toContain(correction);
			await Promise.all(
				recon.map(async ({ kind }) => {
					expect(journeyPage(designer, kind)).toMatchObject({
						path: `process/designs/${topic}/${kind}.md`,
						text: await readFile(
							resolve(vault, `process/designs/${topic}/${kind}.md`),
							"utf8",
						),
					});
				}),
			);
			expect(journeyPage(designer, "template").text).toBe(
				await readFile(resolve(SEED_ROOT, ".misc/templates/design.md"), "utf8"),
			);
			expect(journeyResult(designer, "vault_write")).toMatchObject({
				isError: false,
			});
			expect(
				await readFile(
					resolve(vault, `process/designs/${topic}/design.md`),
					"utf8",
				),
			).toContain(correction);
			const designs = await readdir(resolve(vault, "process/designs"), {
				withFileTypes: true,
			});
			expect(
				designs.filter((entry) => entry.isDirectory()).map(({ name }) => name),
			).toEqual([topic]);
			expect(await readdir(resolve(vault, "process/designs", topic))).toEqual([
				"design.md",
				"remember.md",
				"research.md",
			]);
			expect(
				journeyCheckpoint(await resumed.checkpoint(sessionId)).inner,
			).toMatchObject({ topic, engine: { status: "completed" } });
			expect(
				journeyResultText(continuation.at(-1)!.context, "d3r_continue_phase"),
			).toContain(
				"Most recent topic; reuse only for follow-on work on the same subject:",
			);
			expect(
				j.permissions
					.slice(effects.permissions)
					.map(({ toolCall }) => toolCall.title),
			).toEqual([expect.stringMatching(/^Trust workspace/)]);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
			await resumed.peer.agent.request("session/close", { sessionId });
		},
		JOURNEY_INIT_TIMEOUT,
	);

	// oxlint-disable-next-line max-statements -- Scripted provider decisions test retained refusal and real effects, not live model judgment.
	it("retains a conversational vault decline across reload and runs only an inline audit while the vault is missing", async () => {
		const decline =
			"No. Do not initialize a vault or create any documents. Keep subsequent work inline.";
		const finding =
			"AGENTS.md requires preserving the offline user's requirements; no changes are needed.";
		const scripts: JourneyScripts = {
			router: [
				[
					{
						type: "text",
						text: "May I run d3r vault init? It seeds templates and creates a separate Git repository with an initial commit.",
					},
				],
				[
					{
						type: "text",
						text: "Understood. I will keep work inline without initializing the vault or creating documents.",
					},
				],
				journeyCall("d3r_run_role", {
					role: "auditor",
					brief: {
						goal: "Audit workspace instructions",
						context: `Read AGENTS.md only. ${decline}`,
						acceptanceCriteria: [
							"Return findings inline without any writes or commands.",
						],
					},
				}),
				journeyPhaseReply("d3r_run_role", "Inline audit"),
			],
			auditor: [
				journeyCall("read_file", { path: "AGENTS.md" }),
				...journeyDone(finding),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const files = await readdir(j.cwd, { recursive: true });
		await expect(
			f.prompt(sessionId, "/design Prepare an offline dispatch design"),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(journeyUserText(j.requests[0].context)).toContain(
			"Native vault status: missing.",
		);
		expect(journeyText(f.updates)).toContain("May I run d3r vault init?");
		await expect(f.prompt(sessionId, decline)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(j.requests.map(({ role }) => role)).toEqual(["router", "router"]);
		const checkpoint = await f.checkpoint(sessionId);
		const pin = journeyCheckpoint(checkpoint);
		expect(pin.inner).toMatchObject({ engine: null });
		expect(JSON.stringify(pin.inner!.history)).toContain(decline);
		await expect(readdir(pin.resources.vaultRoot)).rejects.toMatchObject({
			code: "ENOENT",
		});
		const effects = {
			requests: j.requests.length,
			permissions: j.permissions.length,
		};
		await f.peer.agent.request("session/close", { sessionId });
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(effects.requests);
		expect(j.permissions).toHaveLength(effects.permissions);
		const start = resumed.updates.length;
		await expect(
			resumed.prompt(
				sessionId,
				"Now audit AGENTS.md and explain the findings.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const continuation = j.requests.slice(effects.requests);
		const router = continuation[0].context;
		expect(journeyUserText(router)).toContain("Native vault status: missing.");
		expect(journeyUserText(router)).toContain(
			`Pinned vault root: ${JSON.stringify(pin.resources.vaultRoot)}`,
		);
		expect(JSON.stringify(router.messages)).toContain(decline);
		expect(journeyUserText(router)).toContain("do not repeatedly ask");
		expect(new Set(continuation.map(({ role }) => role))).toEqual(
			new Set(["router", "auditor"]),
		);
		const auditor = continuation.findLast(
			({ role }) => role === "auditor",
		)!.context;
		expect(journeyResult(auditor, "read_file")).toMatchObject({
			isError: false,
		});
		expect(journeyResultText(auditor, "read_file")).toContain(
			"Preserve the offline user's requirements.",
		);
		expect(journeyText(resumed.updates.slice(start))).toContain(finding);
		expect(journeyText(resumed.updates.slice(start))).not.toContain(
			"May I run d3r vault init?",
		);
		expect(
			journeyCheckpoint(await resumed.checkpoint(sessionId)).inner,
		).toMatchObject({
			standaloneRole: "auditor",
			engine: { status: "completed" },
		});
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(
			journeyTools(resumed.updates.slice(start))
				.filter((update) => update.sessionUpdate === "tool_call")
				.map(({ title }) => title)
				.toSorted(),
		).toEqual(["auditor", "d3r_report", "d3r_run_role", "read_file"]);
		expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
		await expect(readdir(pin.resources.vaultRoot)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});

	// oxlint-disable-next-line max-statements -- Existing plans and explicit topic selection keep A -> B -> A document work isolated.
	it("reuses the default plan for /delegate, writes a new topic's research, then returns to the original topic without moving artifacts", async () => {
		const scripts: JourneyScripts = {};
		const j = await open(scripts, { routerShortcuts: false });
		const vault = resolve(j.cwd, ".agents/vault");
		await cp(SEED_ROOT, vault, { recursive: true });
		const goal = "Plan durable dispatch";
		const child = "process/tasks/queue-storage/schema.md";
		const plan = `# Plan: durable dispatch\n\nTask schema: ${child}\n\nPersist queued jobs and verify replay after restart.\n`;
		const amendment =
			"\n## Verification\n\nTest recovery from a truncated journal.\n";
		const research =
			"# Research: release notes\n\nThe supplied brief targets end users rather than API consumers. External prior art remains unverified.\n";
		const brief = {
			goal,
			context: "Retain jobs offline across restarts.",
			acceptanceCriteria: [
				"Use the plan's explicit child-task name for its schema.",
			],
		};
		scripts.router = [
			journeyCall("d3r_run_role", { role: "planner", brief }),
			journeyPhaseReply("d3r_run_role", "Plan ready"),
			(context) =>
				journeyCall("d3r_start_phase", {
					phase: "delegate",
					topic: journeyTopic(context),
					brief,
				}),
			journeyPhaseReply("d3r_start_phase", "Delegation complete"),
			journeyCall("d3r_run_role", {
				role: "researcher",
				brief: {
					goal: "Research unrelated release notes",
					context:
						"Release notes target end users, not API consumers; record the supplied facts without external research.",
					acceptanceCriteria: [
						"Write research.md in the new topic's default directory.",
					],
				},
			}),
			journeyPhaseReply("d3r_run_role", "Release notes research complete"),
			(context) =>
				journeyCall("d3r_run_role", {
					role: "planner",
					topic: /^Return to topic ([a-z0-9]+(?:-[a-z0-9]+)*)\b/m.exec(
						journeyUserText(context),
					)![1],
					brief: {
						...brief,
						context:
							"Update the original plan with the requested truncated-journal recovery test; preserve all artifact paths.",
					},
				}),
			journeyPhaseReply("d3r_run_role", "Original plan updated"),
		];
		scripts.planner = [
			journeyCall(
				"vault_read",
				{ path: ".misc/templates/plan.md" },
				"template",
			),
			(context) =>
				journeyCall("vault_write", {
					mode: "doc",
					path: `process/designs/${journeyTopic(context)}/plan.md`,
					kind: "plan",
					frontmatter: { created: "2026-09-10", status: "draft" },
					body: plan,
				}),
			...journeyDone(
				"Planned durable dispatch with the explicit queue-storage child task.",
			),
			(context) =>
				journeyCall(
					"vault_read",
					{ path: `process/designs/${journeyTopic(context)}/plan.md` },
					"existing-plan",
				),
			...journeyDone(
				"The existing plan already specifies the requested task slice; preserve it.",
			),
			journeyCall(
				"vault_read",
				{ path: ".misc/templates/plan.md" },
				"template",
			),
			(context) =>
				journeyCall(
					"vault_read",
					{ path: `process/designs/${journeyTopic(context)}/plan.md` },
					"original-plan",
				),
			(context) =>
				journeyCall("vault_write", {
					mode: "raw",
					path: `process/designs/${journeyTopic(context)}/plan.md`,
					contents: `${journeyPage(context, "original-plan").text}${amendment}`,
					snapshot: journeyPage(context, "original-plan").snapshot,
				}),
			...journeyDone(
				"Added the recovery test to the original plan without moving artifacts.",
			),
		];
		scripts.schemer = [
			(context) =>
				journeyCall(
					"vault_read",
					{ path: `process/designs/${journeyTopic(context)}/plan.md` },
					"existing-plan",
				),
			journeyCall(
				"vault_read",
				{ path: ".misc/templates/schema.md" },
				"template",
			),
			(context) =>
				journeyCall("vault_write", {
					mode: "raw",
					path: /^Task schema: (.+)$/m.exec(
						journeyPage(context, "existing-plan").text,
					)![1],
					contents:
						"# Queue storage schema\n\nPersist jobs before acknowledging them. Test replay across restarts.\n",
				}),
			...journeyDone(
				"Created the schema at the plan's explicit child-task path.",
			),
		];
		scripts.researcher = [
			journeyCall(
				"vault_read",
				{ path: ".misc/templates/research.md" },
				"template",
			),
			(context) =>
				journeyCall("vault_write", {
					mode: "doc",
					path: `process/designs/${journeyTopic(context)}/research.md`,
					kind: "research",
					frontmatter: { created: "2026-09-10", status: "draft" },
					body: research,
				}),
			...journeyDone(
				"Recorded release-note facts and the unverified external research gap.",
			),
		];
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(
			f.prompt(
				sessionId,
				"Run only the planner for durable dispatch; write its plan with queue-storage as the explicit child task.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const checkpoint = await f.checkpoint(sessionId);
		const planned = journeyCheckpoint(checkpoint).inner!;
		const topic = planned.topic!;
		expect(topic).toMatch(/^plan-durable-dispatch-[a-z0-9]+$/);
		expect(planned).toMatchObject({
			standaloneRole: "planner",
			engine: { status: "completed" },
		});
		const originalPlan = await readFile(
			resolve(vault, `process/designs/${topic}/plan.md`),
			"utf8",
		);
		expect(originalPlan).toContain(plan);
		const planner = j.requests.findLast(
			({ role }) => role === "planner",
		)!.context;
		expect(journeyPage(planner, "template").text).toBe(
			await readFile(resolve(SEED_ROOT, ".misc/templates/plan.md"), "utf8"),
		);
		expect(journeyResult(planner, "vault_write")).toMatchObject({
			isError: false,
		});
		const beforeReload = j.requests.length;
		await f.peer.agent.request("session/close", { sessionId });
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload);
		await expect(
			resumed.prompt(
				sessionId,
				"/delegate Continue the same topic using its existing plan; preserve the plan's task names.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const delegated = j.requests.slice(beforeReload);
		expect(journeyUserText(delegated[0].context)).toContain(
			"Most recent topic; reuse only for follow-on work on the same subject:",
		);
		expect(journeyTopic(delegated[0].context)).toBe(topic);
		const router = delegated.at(-1)!.context;
		expect(
			router.messages.flatMap((message) =>
				message.role === "assistant" ? message.content : [],
			),
		).toContainEqual(
			expect.objectContaining({
				type: "toolCall",
				name: "d3r_start_phase",
				arguments: { phase: "delegate", topic, brief },
			}),
		);
		expect(journeyResult(router, "d3r_start_phase")).toMatchObject({
			isError: false,
		});
		for (const role of ["planner", "schemer"]) {
			const { context } = delegated.findLast(
				(request) => request.role === role,
			)!;
			expect(journeyTopic(context)).toBe(topic);
			expect(journeyPage(context, "existing-plan")).toMatchObject({
				path: `process/designs/${topic}/plan.md`,
				text: originalPlan,
			});
			expect(journeyUserText(context)).toContain(
				`taskDirectory: process/tasks/${topic}`,
			);
			expect(journeyUserText(context)).toContain(
				"Follow the plan's explicit child-task names",
			);
			expect(journeyUserText(context)).toContain(
				"Explicit user paths take precedence without moving existing artifacts.",
			);
			expect(journeyUserText(context)).toContain(
				"do not authorize writes, vault initialization, or commits",
			);
		}
		const schemer = delegated.findLast(
			({ role }) => role === "schemer",
		)!.context;
		expect(journeyResult(schemer, "vault_write")).toMatchObject({
			isError: false,
		});
		expect(await readFile(resolve(vault, child), "utf8")).toContain(
			"Test replay across restarts.",
		);
		await expect(
			readdir(resolve(vault, "process/tasks", topic)),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(
			journeyCheckpoint(await resumed.checkpoint(sessionId)).inner,
		).toMatchObject({
			topic,
			engine: { command: "delegate", status: "completed" },
		});
		const schema = await readFile(resolve(vault, child), "utf8");
		const beforeResearch = j.requests.length;
		await expect(
			resumed.prompt(
				sessionId,
				"Unrelated task: record research for release notes targeting end users, not API consumers. No external research is needed.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const researched = journeyCheckpoint(
			await resumed.checkpoint(sessionId),
		).inner!;
		expect(researched.topic).toMatch(
			/^research-unrelated-release-notes-[a-z0-9]+$/,
		);
		expect(researched.topic).not.toBe(topic);
		expect(researched).toMatchObject({
			standaloneRole: "researcher",
			engine: { status: "completed" },
		});
		const researchRequests = j.requests.slice(beforeResearch);
		expect(new Set(researchRequests.map(({ role }) => role))).toEqual(
			new Set(["router", "researcher"]),
		);
		const researcher = researchRequests.findLast(
			({ role }) => role === "researcher",
		)!.context;
		expect(journeyTopic(researcher)).toBe(researched.topic);
		expect(journeyPage(researcher, "template").text).toBe(
			await readFile(resolve(SEED_ROOT, ".misc/templates/research.md"), "utf8"),
		);
		expect(journeyResult(researcher, "vault_write")).toMatchObject({
			isError: false,
		});
		const researchPath = `process/designs/${researched.topic}/research.md`;
		const savedResearch = await readFile(resolve(vault, researchPath), "utf8");
		expect(savedResearch).toContain(research);
		expect(
			await readFile(
				resolve(vault, `process/designs/${topic}/plan.md`),
				"utf8",
			),
		).toBe(originalPlan);
		const files = await readdir(vault, { recursive: true });
		const beforeReturn = j.requests.length;
		await expect(
			resumed.prompt(
				sessionId,
				`Return to topic ${topic} and have the planner add a truncated-journal recovery test to its existing plan. Do not move any artifacts.`,
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const returned = j.requests.slice(beforeReturn);
		expect(journeyTopic(returned[0].context)).toBe(researched.topic);
		expect(journeyUserText(returned[0].context)).toContain(
			`Return to topic ${topic}`,
		);
		expect(new Set(returned.map(({ role }) => role))).toEqual(
			new Set(["router", "planner"]),
		);
		const returningRouter = returned.at(-1)!.context;
		expect(
			returningRouter.messages
				.flatMap((message) =>
					message.role === "assistant" ? message.content : [],
				)
				.findLast(
					(part) => part.type === "toolCall" && part.name === "d3r_run_role",
				),
		).toMatchObject({ arguments: { role: "planner", topic } });
		expect(journeyResult(returningRouter, "d3r_run_role")).toMatchObject({
			isError: false,
		});
		const returningPlanner = returned.findLast(
			({ role }) => role === "planner",
		)!.context;
		expect(journeyTopic(returningPlanner)).toBe(topic);
		expect(journeyPage(returningPlanner, "original-plan")).toMatchObject({
			path: `process/designs/${topic}/plan.md`,
			text: originalPlan,
		});
		expect(journeyResult(returningPlanner, "vault_write")).toMatchObject({
			isError: false,
		});
		expect(
			journeyCheckpoint(await resumed.checkpoint(sessionId)).inner,
		).toMatchObject({
			topic,
			standaloneRole: "planner",
			engine: { status: "completed" },
		});
		expect(
			await readFile(
				resolve(vault, `process/designs/${topic}/plan.md`),
				"utf8",
			),
		).toBe(`${originalPlan}${amendment}`);
		expect(await readFile(resolve(vault, researchPath), "utf8")).toBe(
			savedResearch,
		);
		expect(await readFile(resolve(vault, child), "utf8")).toBe(schema);
		expect(await readdir(vault, { recursive: true })).toEqual(files);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});

	// oxlint-disable-next-line max-statements -- Vault reads, permissions and reloading form one document journey.
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
		j.approval.decide = async ({ toolCall }) =>
			toolCall.title?.startsWith("Trust workspace") === true;
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expect(
			f.prompt(
				sessionId,
				"/design Read .misc/templates/remember.md with vault_read and save factual recon as process/designs/offline-queue/recon/remember.md in the vault.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
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
		expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		expect(
			j.permissions
				.slice(permissionsBefore)
				.map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		for (const { context } of j.requests.filter(
			({ role }) => role !== "summary",
		)) {
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

	it.each(["failed", "cancelled"] as const)(
		"recovers a %s automatic vault mutation on /develop reload and protects an external edit with real read snapshots",
		// oxlint-disable-next-line max-statements -- Failed execution, cancellation and snapshot-safe recovery share the real workflow.
		async (failure) => {
			const scripts: JourneyScripts = {};
			const publication = journeyToolGate("publish-log");
			const edit = journeyToolGate("stale-edit");
			const j = await open(scripts, {
				workspace: "repo/worktrees/topic",
				streamResponse: (_role, content, settings) =>
					content.some(
						(part) => part.type === "toolCall" && part.id === "stale-edit",
					)
						? edit.stream(content, settings?.signal)
						: publication.stream(content, settings?.signal),
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
			const external = `${original}User added this line after the model read.\n`;
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
				journeyReport("Vault publication failed; preserve the saved note.", {
					status: "blocked",
				}),
				[{ type: "text", text: "No vault mutation was made." }],
			];
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
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
				await Promise.race([
					publication.reached.promise,
					pending.then(() => {
						throw new Error(
							"Develop ended before the publication provider gate",
						);
					}),
				]);
				expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
					expect.stringMatching(/^Trust workspace/),
				]);
				await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(readFile(resolve(vault, artifact))).rejects.toMatchObject({
					code: "ENOENT",
				});
				if (failure === "cancelled") {
					await f.peer.agent.notify("session/cancel", { sessionId });
				} else {
					await writeFile(parent, "A file blocks the artifact directory.\n");
					publication.release.resolve();
				}
				await expect(pending).resolves.toEqual({
					stopReason: failure === "cancelled" ? "cancelled" : "end_turn",
				});
				if (failure === "failed") {
					await expect(readFile(parent, "utf8")).resolves.toBe(
						"A file blocks the artifact directory.\n",
					);
					await rm(parent);
				}
				// A late provider response cannot revive cancelled publication or create its parents.
				publication.release.resolve();
				await f.peer.agent.request("session/list", {});
				await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
					original,
				);
			} finally {
				await f.peer.agent.notify("session/cancel", { sessionId });
				publication.release.resolve();
				await pending;
			}
			const initial = j.requests.findLast(
				({ role }) => role === "implementor",
			)!.context;
			expect(journeyPage(initial, "before-denial").text).toBe(original);
			if (failure === "failed") {
				expect(journeyResult(initial, "publish-log")).toMatchObject({
					isError: true,
				});
				expect(journeyResultText(initial, "publish-log")).toBe(
					"Tool execution failed; effects may have occurred. Do not automatically retry.",
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
			const retained = journeyCheckpoint(await resumed.checkpoint(sessionId))
				.inner!.engine;
			await expect(
				resumed.prompt(sessionId, failure === "failed" ? "continue" : "status"),
			).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(j.requests.slice(beforeReload).map(({ role }) => role)).toEqual([
				"router",
				"router",
			]);
			expect(
				journeyCheckpoint(await resumed.checkpoint(sessionId)).inner!.engine,
			).toEqual(retained);
			expect(
				journeyResult(
					j.requests.at(-1)!.context,
					failure === "failed" ? "d3r_continue_phase" : "d3r_phase_status",
				),
			).toMatchObject({ isError: failure === "failed" });
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
			if (failure === "failed") {
				await expect(resumed.prompt(sessionId, "abandon")).resolves.toEqual({
					stopReason: "end_turn",
				});
				await expect(resumed.prompt(sessionId, request)).resolves.toEqual({
					stopReason: "end_turn",
				});
			}
			const recoveryRequests = j.requests.length;
			const recovery = resumed.prompt(
				sessionId,
				failure === "failed" ? "auto" : "continue",
			);
			try {
				await Promise.race([
					edit.reached.promise,
					recovery.then(() => {
						throw new Error(
							"Recovery ended before the stale edit provider gate",
						);
					}),
				]);
				await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
					original,
				);
				await writeFile(resolve(vault, note), external);
				edit.release.resolve();
				await expect(recovery).resolves.toEqual({ stopReason: "end_turn" });
			} finally {
				await resumed.peer.agent.notify("session/cancel", { sessionId });
				edit.release.resolve();
				await recovery;
			}
			const resumedImplementor = j.requests
				.slice(recoveryRequests)
				.find(({ role }) => role === "implementor")!.context;
			if (failure === "cancelled") {
				expect(journeyPage(resumedImplementor, "before-denial").text).toBe(
					original,
				);
				expect(
					journeyResult(resumedImplementor, "publish-log"),
				).toBeUndefined();
			}
			expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
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
			).toEqual([expect.stringMatching(/^Trust workspace/)]);
			expect(
				j.permissions.some(({ toolCall }) =>
					toolCall.title?.startsWith("vault_"),
				),
			).toBe(false);
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
			expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
			await resumed.peer.agent.request("session/close", { sessionId });
		},
	);

	// oxlint-disable-next-line max-statements -- One thread covers denial, once, queued scope reuse, later work and fresh-session boundaries.
	it("grants all native commands only on always, including queued and later calls, and forgets grants on reload or a new session", async () => {
		const command = (id: string) =>
			journeyCall(
				"run_command",
				{
					command: process.execPath,
					args: [
						"-e",
						"require('node:fs').writeFileSync(process.argv[1], process.argv[2]);",
						`${id}.txt`,
						id,
					],
				},
				id,
			);
		const queued = journeyToolGate("queued-command");
		const scripts: JourneyScripts = {
			aggregator: [
				command("denied-command"),
				command("once-command"),
				command("scope-command"),
				command("later-command"),
				...journeyDone("Checked all authorized local probes."),
			],
			researcher: [
				command("queued-command"),
				...journeyDone("Ran the queued local probe."),
			],
			designer: journeyDone("Verified the local design after recon."),
			router: [
				command("next-turn-command"),
				[{ type: "text", text: "The final local probe completed." }],
			],
		};
		const j = await open(scripts, {
			streamResponse: (_role, content, settings) =>
				queued.stream(content, settings?.signal),
		});
		const asked = deferred<RequestPermissionRequest>();
		const grant = deferred<JourneyDecision>();
		j.approval.decide = async (permission) => {
			if (permission.toolCall.title?.startsWith("Trust workspace")) {
				return true;
			}
			const input = permission.toolCall.rawInput as { args: string[] };
			if (input.args.at(-1) === "once-command") {
				return true;
			}
			if (input.args.at(-1) === "scope-command") {
				asked.resolve(permission);
				return grant.promise;
			}
			return false;
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
			"/design Probe the local queue with native commands, then discuss the design.",
		);
		try {
			const [permission] = await Promise.race([
				Promise.all([asked.promise, queued.reached.promise]),
				pending.then(() => {
					throw new Error("Recon ended before the command scope decision");
				}),
			]);
			expect(permission.options.map(({ kind }) => kind)).toEqual([
				"allow_once",
				"reject_once",
				"allow_always",
			]);
			expect(permission.options.at(-1)?.name).toBe(
				"Allow all command executions (not sandboxed) for this thread",
			);
			await expect(
				readFile(resolve(j.cwd, "denied-command.txt")),
			).rejects.toMatchObject({ code: "ENOENT" });
			await expect(
				readFile(resolve(j.cwd, "once-command.txt"), "utf8"),
			).resolves.toBe("once-command");
			queued.release.resolve();
			await vi.waitFor(() =>
				expect(
					journeyTools(f.updates).some(
						(row) =>
							row.sessionUpdate === "tool_call" &&
							(row.rawInput as { args?: string[] } | undefined)?.args?.at(
								-1,
							) === "queued-command",
					),
				).toBe(true),
			);
			await f.peer.agent.request("session/list", {});
			const commandPermissions = j.permissions.filter(
				({ toolCall }) => !toolCall.title?.startsWith("Trust workspace"),
			);
			expect(
				commandPermissions.map(({ toolCall }) =>
					(toolCall.rawInput as { args: string[] }).args.at(-1),
				),
			).toEqual(["denied-command", "once-command", "scope-command"]);
			await Promise.all(
				["scope-command", "queued-command", "later-command"].map(async (id) => {
					await expect(
						readFile(resolve(j.cwd, `${id}.txt`)),
					).rejects.toMatchObject({ code: "ENOENT" });
				}),
			);
			grant.resolve("allow_scope");
			await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		} finally {
			await f.peer.agent.notify("session/cancel", { sessionId });
			queued.release.resolve();
			grant.resolve(false);
			await pending;
		}
		await expect(
			f.prompt(sessionId, "Finish the design in chat."),
		).resolves.toEqual({ stopReason: "end_turn" });
		await expect(
			f.prompt(
				sessionId,
				"Run one final local probe directly, without starting another phase.",
			),
		).resolves.toEqual({ stopReason: "end_turn" });
		const commands = [
			"once-command",
			"scope-command",
			"queued-command",
			"later-command",
			"next-turn-command",
		];
		await Promise.all(
			commands.map(async (id) => {
				await expect(
					readFile(resolve(j.cwd, `${id}.txt`), "utf8"),
				).resolves.toBe(id);
				const result = j.requests
					.map(({ context }) => journeyResult(context, id))
					.find(Boolean);
				expect(result, id).toMatchObject({ isError: false });
			}),
		);
		expect(j.permissions).toHaveLength(
			["trust", "denied", "once", "scope"].length,
		);
		expect(journeyText(f.updates)).toContain(JOURNEY_SUMMARY);
		const saved = await f.saved(sessionId);
		const beforeLoad = {
			requests: j.requests.length,
			permissions: j.permissions.length,
		};
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		expect(j.requests).toHaveLength(beforeLoad.requests);
		expect(j.permissions).toHaveLength(beforeLoad.permissions);
		const probeFresh = async (id: string, label: string) => {
			const before = j.permissions.length;
			scripts.aggregator = [
				command(label),
				...journeyDone("Denied probe left no effect."),
			];
			scripts.researcher = journeyDone("No other probe needed.");
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
			await expect(
				resumed.prompt(
					id,
					`/design Check ${label}; do not reuse past approvals.`,
				),
			).resolves.toEqual({ stopReason: "end_turn" });
			expect(
				j.permissions.slice(before).map(({ toolCall }) => toolCall.title),
			).toEqual([
				expect.stringMatching(/^Trust workspace/),
				expect.stringContaining("-e"),
			]);
			expect(j.permissions.at(-1)?.options.map(({ kind }) => kind)).toEqual([
				"allow_once",
				"reject_once",
				"allow_always",
			]);
			await expect(
				readFile(resolve(j.cwd, `${label}.txt`)),
			).rejects.toMatchObject({ code: "ENOENT" });
			const { context } = j.requests.findLast(
				({ role }) => role === "aggregator",
			)!;
			expect(journeyResult(context, label)).toMatchObject({ isError: true });
			expect(journeyResultText(context, label)).toMatch(/permission.*denied/i);
		};
		await probeFresh(sessionId, "reloaded-command");
		const fresh = await resumed.newSession(j.cwd);
		await resumed.peer.agent.request("session/set_config_option", {
			sessionId: fresh.sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await probeFresh(fresh.sessionId, "new-session-command");
		for (const state of [
			saved,
			await resumed.saved(sessionId),
			await resumed.saved(fresh.sessionId),
		]) {
			expect(JSON.stringify(state)).not.toMatch(
				/allow_scope|d3r:native:commands/,
			);
		}
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

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
					expect(journeyText(f.updates)).toContain(JOURNEY_SUMMARY);
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

	it.each(["failed", "cancelled"] as const)(
		"recovers a %s automatic /develop write without replay, then implements, reviews and audits through real tools",
		// oxlint-disable-next-line max-statements -- Failure, persisted recovery and successful retry are one acceptance journey.
		async (failure) => {
			const content = "Durable offline jobs\n";
			const write = journeyCall(
				"write_file",
				{ path: "queue.txt", content },
				"publish-queue",
			);
			const scripts: JourneyScripts = {
				implementor: [
					journeyCall("write_file", { path: 42, content }),
					write,
					journeyReport("Write failed; no implementation was made.", {
						status: "blocked",
					}),
					[{ type: "text", text: "A directory obstructed the write." }],
				],
			};
			const publication = journeyToolGate("publish-queue");
			const j = await open(scripts, {
				streamResponse: (_role, response, settings) =>
					publication.stream(response, settings?.signal),
			});
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
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
			expect(j.requests.map(({ role }) => role)).toEqual(["router", "router"]);
			expect(
				journeyCheckpoint(await f.checkpoint(sessionId)).inner,
			).toMatchObject({
				orchestrated: true,
				engine: { status: "waiting", mode: null, pause: { kind: "mode" } },
			});
			const pending = f.prompt(sessionId, "auto");
			try {
				await Promise.race([
					publication.reached.promise,
					pending.then(() => {
						throw new Error(
							"Turn ended before the workspace write provider gate",
						);
					}),
				]);
				expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
					expect.stringMatching(/^Trust workspace/),
				]);
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
					await mkdir(resolve(j.cwd, "queue.txt"));
					publication.release.resolve();
				}
				await expect(pending).resolves.toEqual({
					stopReason: failure === "cancelled" ? "cancelled" : "end_turn",
				});
				if (failure === "failed") {
					const { context } = j.requests.findLast(
						({ role }) => role === "implementor",
					)!;
					expect(journeyResult(context, "publish-queue")).toMatchObject({
						isError: true,
					});
					expect(journeyResultText(context, "publish-queue")).toBe(
						"Tool execution failed; effects may have occurred. Do not automatically retry.",
					);
					await expect(readdir(resolve(j.cwd, "queue.txt"))).resolves.toEqual(
						[],
					);
					await rm(resolve(j.cwd, "queue.txt"), { recursive: true });
				}
			} finally {
				await f.peer.agent.notify("session/cancel", { sessionId });
				publication.release.resolve();
				await pending;
			}
			await expect(readFile(resolve(j.cwd, "queue.txt"))).rejects.toMatchObject(
				{ code: "ENOENT" },
			);
			if (failure === "failed") {
				expect(
					journeyTools(f.updates).map(journeyToolText).join("\n"),
				).toContain("Write failed");
				expect(
					j.requests
						.findLast(({ role }) => role === "implementor")
						?.context.messages.at(-1),
				).toMatchObject({
					toolName: "d3r_report",
					isError: false,
				});
			}
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			const beforeReload = j.requests.length;
			await f.close();
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
			expect(journeyText(resumed.updates.slice(conflictStart))).toContain(
				"Cannot replace unfinished work",
			);
			const retained = journeyCheckpoint(
				await resumed.checkpoint(sessionId),
			).inner!;
			expect(retained.engine).toEqual(
				journeyCheckpoint(checkpoint).inner!.engine,
			);
			expect(retained.input).toEqual(
				journeyCheckpoint(checkpoint).inner!.input,
			);
			await expect(
				resumed.prompt(sessionId, failure === "failed" ? "continue" : "status"),
			).resolves.toEqual({
				stopReason: "end_turn",
			});
			expect(j.requests.slice(beforeReload).map(({ role }) => role)).toEqual([
				"router",
				"router",
				"router",
				"router",
			]);
			expect(
				journeyCheckpoint(await resumed.checkpoint(sessionId)).inner!.engine,
			).toEqual(retained.engine);
			expect(
				journeyResult(
					j.requests.at(-1)!.context,
					failure === "failed" ? "d3r_continue_phase" : "d3r_phase_status",
				),
			).toMatchObject({ isError: failure === "failed" });
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
			if (failure === "failed") {
				await expect(resumed.prompt(sessionId, "abandon")).resolves.toEqual({
					stopReason: "end_turn",
				});
				await expect(resumed.prompt(sessionId, request)).resolves.toEqual({
					stopReason: "end_turn",
				});
			}
			const recoveryRequests = j.requests.length;
			await expect(
				resumed.prompt(sessionId, failure === "failed" ? "auto" : "continue"),
			).resolves.toEqual({ stopReason: "end_turn" });
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(content);
			expect(journeyText(resumed.updates.slice(recoveryUpdates))).toContain(
				JOURNEY_SUMMARY,
			);
			const recovery = j.requests.slice(recoveryRequests);
			expect(recovery.filter(({ role }) => role === "summary")).toEqual([]);

			const progression = recovery
				.filter(({ role }) => role !== "router")
				.map(({ role }) => role)
				.filter(
					(role, index, roles) => index === 0 || role !== roles[index - 1],
				);
			expect(progression).toEqual(["implementor", "reviewer", "auditor"]);
			for (const { role, context } of recovery) {
				expect(JSON.stringify(context.messages)).toContain(request);
				if (failure === "cancelled" && role !== "router") {
					expect(JSON.stringify(context.messages)).not.toContain(replacement);
				}
			}
			const completed = journeyCheckpoint(
				await resumed.checkpoint(sessionId),
			).inner!;
			expect(completed.engine).toMatchObject({ status: "completed" });
			expect(JSON.stringify(completed.input)).not.toContain(replacement);
			for (const record of retained.engine!.records.filter(
				({ status }) => status === "completed",
			)) {
				expect(completed.engine!.records).toContainEqual(record);
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
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
				expect.stringMatching(/^Trust workspace/),
			]);
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
