import {
	type SessionNotification,
	type ToolCallUpdate,
	type PromptResponse,
	type StopReason,
} from "@agentclientprotocol/sdk";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect } from "vitest";
import { type Models } from "../../../pi/auth.ts";
import { type NativeModel } from "../../../../cli/src/native-models.ts";
import { parseNativeCheckpoint } from "../../../../cli/src/native-resources.ts";
import { deferred, waitForAbort } from "../../test-support.ts";

/** Provider fixtures use the adapter's public types, without another Pi dependency. */
export type JourneyStream = ReturnType<Models["streamSimple"]>;

/** Capture model-facing context, not executable tool closures. */
export type JourneyContext = Parameters<Models["streamSimple"]>[1];

/** Complete assistant responses enter the real embedded model/tool loop. */
export type JourneyMessage = Awaited<ReturnType<JourneyStream["result"]>>;

/** Each role has its own script so parallel arrival order is irrelevant. */
export type JourneyScripts = Record<
	string,
	(
		| JourneyMessage["content"]
		| ((context: JourneyContext) => JourneyMessage["content"])
	)[]
>;

/** An inert catalog cannot read credentials or discover live providers. */
export const JOURNEY_MODEL: NativeModel = {
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
export const JOURNEY_SUMMARY =
	"## Workflow complete\n\nThe requested phase is complete; its results are retained for the next decision.\n\n**Next:** Review the results before choosing the next phase.";

/** Only provider IO is replaced; messages and tool results still pass through Pi. */
export const journeyStream = (
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
export const journeyToolGate = (id: string) => {
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
export const journeyFailureStream = (errorMessage: string): JourneyStream => {
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
export const JOURNEY_PRIVATE_DIAGNOSTIC =
	"Authorization: Bearer journey-secret-canary; x-api-key: journey-header-canary; https://diagnostic.invalid/private?token=journey-url-canary\nprompt: journey-prompt-canary\n at journey-stack-canary (/private/provider.ts:19:4)";

/** Match individual fields too, so partial diagnostic leaks cannot pass a whole-string check. */
export const JOURNEY_DIAGNOSTIC_LEAK =
	/journey-(?:secret|header|url|prompt|stack)-canary|diagnostic\.invalid|Authorization|x-api-key|diagnostic-provider|diagnostic-model|\/private\/provider\.ts/;

/** Raw provider IDs may be reused across isolated roles and subsequent turns. */
export const journeyCall = (
	name: string,
	args: Record<string, unknown>,
	id = name,
): JourneyMessage["content"] => [
	{ type: "toolCall", id, name, arguments: args },
];

/** Look up observed results by provider call ID, not parallel role arrival order. */
export const journeyResult = (context: JourneyContext, id: string) =>
	context.messages.findLast(
		(message) => message.role === "toolResult" && message.toolCallId === id,
	);

/** Read model-visible tool output without asserting inside the provider callback. */
export const journeyResultText = (context: JourneyContext, id: string) => {
	const result = journeyResult(context, id);
	return result?.role === "toolResult"
		? result.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n")
		: "";
};

/** Read the latest request, not earlier messages with superseded host state. */
export const journeyUserText = (context: JourneyContext): string => {
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
export const journeyTopic = (context: JourneyContext): string => {
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
export const journeyRouterShortcut = (
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
export const journeyPhaseReply =
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
export const JOURNEY_INIT_TIMEOUT = 20_000;

/** Small real invocation limits make boundary journeys independent of production defaults. */
export const JOURNEY_BUDGET = { maxTurns: 3, maxTotalTurns: 6 };

/** Shipped auditor/reviewer capabilities allow report writes, but not editing, web access or delegation. */
export const JOURNEY_INSPECTION_TOOLS = [
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
export type JourneyDecision = boolean | "allow_scope" | "cancelled";

/** Read the public JSON text envelope; fixtures must use actual read snapshots. */
export const journeyPage = (context: JourneyContext, id: string) => {
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
export const journeyReport = (
	summary: string,
	extra: Record<string, unknown> = {},
) => journeyCall("d3r_report", { status: "completed", summary, ...extra });

/** A single provider text response, distinct from a structured completion report. */
export const reply = (text: string): JourneyMessage["content"] => [
	{ type: "text", text },
];

/** A role must submit its report and then finish in a separate real model response. */
export const journeyDone = (
	summary: string,
	extra: Record<string, unknown> = {},
	finalText = summary,
): JourneyMessage["content"][] => [
	journeyReport(summary, extra),
	reply(finalText),
];

/** Derive model tool arguments from observed results without bypassing tool execution. */
export const callWith =
	(
		name: string,
		args: (context: JourneyContext) => Record<string, unknown>,
		id = name,
	) =>
	(context: JourneyContext): JourneyMessage["content"] =>
		journeyCall(name, args(context), id);

/** Snapshot inputs come from successful real reads, never test-side workflow callbacks. */
export const workspaceSnapshot = (
	context: JourneyContext,
	id: string,
): string => {
	const result = journeyResult(context, id);
	const snapshot = /^Snapshot: ([a-f0-9]{64})\n/.exec(
		journeyResultText(context, id),
	)?.[1];
	if (result?.role !== "toolResult" || result.isError || !snapshot) {
		throw new Error(`Missing successful workspace read snapshot: ${id}`);
	}
	return snapshot;
};

/** Select actual provider observations without freezing inter-role arrival order. */
export const roleRequests = <T extends { role: string }>(
	requests: readonly T[],
	role: string,
): T[] => requests.filter((request) => request.role === role);

/** A missing observed request fails at the assertion site rather than fabricating evidence. */
export const lastRequest = <T extends { role: string }>(
	requests: readonly T[],
	role: string,
): T => {
	const request = requests.findLast((entry) => entry.role === role);
	if (!request) {
		throw new Error(`No provider request observed for ${role}`);
	}
	return request;
};

/** Seed real temporary fixture files; writes made by the agent still go through its tools. */
export const writeFiles = async (
	root: string,
	files: Readonly<Record<string, string>>,
): Promise<void> => {
	await Promise.all(
		Object.entries(files).map(async ([name, text]) => {
			const path = resolve(root, name);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, text);
		}),
	);
};

/** Await an actual ACP turn and assert its exact completion envelope outside provider callbacks. */
export const expectStop = async (
	pending: Promise<PromptResponse>,
	stopReason: StopReason = "end_turn",
	message?: string,
): Promise<void> => {
	expect(await pending, message).toEqual({ stopReason });
};

/** Segmentation is not a UX contract; assert the assembled assistant response. */
export const journeyText = (updates: readonly SessionNotification[]) =>
	updates
		.flatMap(({ update }) =>
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text"
				? [update.content.text]
				: [],
		)
		.join("");

/** Inspect the content ACP clients render, rather than rawInput or rawOutput. */
export const journeyToolText = ({ content }: Pick<ToolCallUpdate, "content">) =>
	(content ?? [])
		.flatMap((part) =>
			part.type === "content" && part.content.type === "text"
				? [part.content.text]
				: [],
		)
		.join("\n");

/** ACP owns the outer checkpoint; native state lives inside its runtime field. */
export const journeyCheckpoint = (state: unknown) =>
	parseNativeCheckpoint((state as { runtime: unknown }).runtime);

/** Preserve tool identity so assertions cover pending cards and their later results. */
export const journeyTools = (updates: readonly SessionNotification[]) =>
	updates
		.map(({ update }) => update)
		.filter(
			(update) =>
				update.sessionUpdate === "tool_call" ||
				update.sessionUpdate === "tool_call_update",
		);
