import { randomUUID } from "node:crypto";
import { type Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createRuntimeFailure,
	type RuntimeFailure,
	type RuntimeActivity,
	type RuntimePrompt,
	type RuntimeSessionInput,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import {
	createRequestExtensionTool,
	type RequestBudget,
} from "./embedded-budget.ts";
import { closeToolBatches } from "./embedded-checkpoint.ts";
import { prepareContent, type ResolveResource } from "./embedded-content.ts";
import {
	classifyPiFailure,
	type PiFailureClassification,
} from "./embedded-errors.ts";
import {
	compileTools,
	createToolBridge,
	type EmbeddedTool,
} from "./embedded-tools.ts";

/** A provider output limit interrupts a response, not the unlimited invocation's work. */
const LENGTH_CONTINUATION =
	"The previous response reached the provider output token limit. Continue the same invocation and task using the retained conversation and tool results. Preserve completed work; do not replay settled tool effects or automatically retry errors or permission denials. Tool calls in the truncated response were not executed; issue new, complete calls only for unfinished work. If d3r_report already succeeded in this invocation, do not call it again: finish the remaining response only. Otherwise finish the work and report normally. This continuation grants no new tool permissions.";

/** Mutable observation data belongs to one invocation, never the provider registry. */
interface TurnState {
	messageId: string;
	finalMessage: AssistantMessage | null;
	outputFailed: boolean;
	requestFailure?: PiFailureClassification;
	httpStatus?: number;
}

/** Await delivery without throwing into Pi's parallel tool executor and losing siblings. */
const deliver = async (
	agent: Agent,
	state: TurnState,
	send: () => Promise<void>,
): Promise<void> => {
	if (state.outputFailed) {
		return;
	}
	try {
		await send();
	} catch {
		state.outputFailed = true;
		agent.abort();
	}
};

/** Forward accounting and deltas; each assistant block has one stable message ID. */
const observeMessages = async (
	agent: Agent,
	request: RuntimePrompt,
	{ state, event }: { readonly state: TurnState; readonly event: AgentEvent },
): Promise<void> => {
	if (event.type === "message_start" && event.message.role === "assistant") {
		state.messageId = randomUUID();
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		state.finalMessage = event.message;
		const { usage } = event.message;
		await deliver(agent, state, async () =>
			request.activity?.({
				kind: "usage",
				used: usage.totalTokens,
				size: agent.state.model.contextWindow,
				cost: { amount: usage.cost.total, currency: "USD" },
			}),
		);
	}
	if (event.type !== "message_update" || request.signal.aborted) {
		return;
	}
	const chunk = event.assistantMessageEvent;
	if (chunk.type === "text_delta" || chunk.type === "thinking_delta") {
		await deliver(agent, state, async () =>
			request.emit({
				kind: chunk.type === "text_delta" ? "text" : "thought",
				messageId: `${state.messageId}:${chunk.contentIndex}`,
				text: chunk.delta,
			}),
		);
	}
};

/** Promise settlement alone is not success: Pi encodes failures in the final message. */
const turnOutcome = (
	state: TurnState,
	hasTools: boolean,
	failure: RuntimeFailure,
): RuntimeStopReason => {
	if (state.outputFailed) {
		throw createRuntimeFailure({
			stage: "output",
			category: "unknown",
			provider: failure.provider,
			model: failure.model,
			toolsStarted: failure.toolsStarted,
		});
	}
	const message = state.finalMessage;
	if (!message) {
		throw createRuntimeFailure(failure);
	}
	if (message.stopReason === "error") {
		throw createRuntimeFailure(failure);
	}
	if (message.stopReason === "aborted") {
		return "cancelled";
	}
	const hasCalls = message.content.some((block) => block.type === "toolCall");
	if (hasCalls && !hasTools) {
		throw new Error("Embedded tool execution is not supported yet");
	}
	if (message.stopReason === "length") {
		return "token_limit";
	}
	if (hasCalls) {
		return "request_limit";
	}
	if (message.stopReason === "stop") {
		return "completed";
	}
	throw new Error("Unsupported model completion reason");
};

/** A prompt owns all hooks until Pi and every started tool/output callback have settled. */
// oxlint-disable-next-line max-statements -- Keep invocation hook ownership and history cleanup in one try/finally.
export const runEmbeddedTurn = async (
	agent: Agent,
	request: RuntimePrompt,
	{
		input,
		definitions,
		budget,
		budgetLabel,
		namespace,
		resolveResource,
	}: {
		readonly input: RuntimeSessionInput;
		readonly definitions: readonly EmbeddedTool[];
		readonly budget: RequestBudget | null;
		readonly budgetLabel?: string;
		readonly namespace: string;
		readonly resolveResource?: ResolveResource;
	},
): Promise<RuntimeStopReason> => {
	const previousMessages = [...agent.state.messages];
	const state: TurnState = {
		messageId: "",
		finalMessage: null,
		outputFailed: false,
	};
	const tools =
		definitions.length > 0 && budget !== null
			? [
					...definitions,
					...compileTools([createRequestExtensionTool(budget, budgetLabel)]),
				]
			: definitions;
	const bridge = createToolBridge(tools, input, {
		namespace,
		requestSignal: request.signal,
		activity: async (event: RuntimeActivity) =>
			deliver(agent, state, async () =>
				request.activity?.(structuredClone(event)),
			),
	});
	Object.assign(agent, {
		beforeToolCall: bridge.beforeToolCall,
		afterToolCall: bridge.afterToolCall,
		shouldStopAfterTurn: () =>
			definitions.length === 0 ||
			(budget !== null &&
				(budget.used >= budget.limit || budget.used >= budget.hard)) ||
			state.finalMessage?.stopReason === "length" ||
			request.signal.aborted ||
			state.outputFailed,
	});
	agent.state.tools = bridge.tools;
	const unsubscribe = agent.subscribe(async (event) => {
		await observeMessages(agent, request, { state, event });
		await deliver(agent, state, async () => bridge.observe(event));
	});
	const abort = (): void => agent.abort();
	request.signal.addEventListener("abort", abort, { once: true });
	let keepHistory = false;
	const previousStream = agent.streamFunction;
	// Pi stringifies throws before emitting message_end. Capture safe metadata first,
	// scoped to this invocation and reset for every request (including after tools).
	agent.streamFunction = async (model, context, settings) => {
		state.requestFailure = undefined;
		state.httpStatus = undefined;
		try {
			return await previousStream(model, context, {
				...settings,
				onResponse: async (response, responseModel) => {
					state.httpStatus = classifyPiFailure(response).httpStatus;
					await settings?.onResponse?.(response, responseModel);
				},
			});
		} catch (error) {
			state.requestFailure = classifyPiFailure(error);
			// oxlint-disable-next-line preserve-caught-error -- Pi must never stringify an untrusted cause or getter.
			throw new Error("Model request failed");
		}
	};
	const failureData = (error: unknown): RuntimeFailure => {
		const classified = state.requestFailure ?? classifyPiFailure(error);
		return {
			stage: "model_request",
			...classified,
			category:
				classified.category === "unknown"
					? classifyPiFailure({ status: state.httpStatus }).category
					: classified.category,
			httpStatus: classified.httpStatus ?? state.httpStatus,
			provider: agent.state.model.provider,
			model: agent.state.model.id,
			toolsStarted: bridge.hasStartedTools(),
		};
	};
	try {
		const content = await prepareContent(request, agent.state.model, {
			cwd: input.cwd,
			resolveResource,
		});
		if (request.signal.aborted) {
			return "cancelled";
		}
		let nextContent = content;
		while (true) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- Continuations require Pi and all prior callbacks to settle.
				await agent.prompt({
					role: "user",
					content: nextContent,
					timestamp: Date.now(),
				});
			} catch (error) {
				throw createRuntimeFailure(failureData(error));
			}
			if (request.signal.aborted) {
				return "cancelled";
			}
			const result = turnOutcome(
				state,
				definitions.length > 0,
				failureData(state.finalMessage),
			);
			if (budget !== null || result !== "token_limit") {
				keepHistory ||= result !== "cancelled";
				return result;
			}
			agent.state.messages = closeToolBatches(agent.state.messages);
			// Accepted length output is useful work even without tool effects. Keep it
			// through later continuation failures or cancellation, not just completion.
			keepHistory = true;
			nextContent = [{ type: "text", text: LENGTH_CONTINUATION }];
		}
	} catch (error) {
		if (request.signal.aborted) {
			return "cancelled";
		}
		throw error;
	} finally {
		request.signal.removeEventListener("abort", abort);
		unsubscribe();
		agent.streamFunction = previousStream;
		const terminal = agent.state.messages.at(-1);
		if (
			agent.state.messages.length > previousMessages.length &&
			terminal?.role === "assistant" &&
			terminal.stopReason === "error"
		) {
			// Failed envelopes carry untrusted backend metadata, not historical model provenance.
			agent.state.messages = agent.state.messages.with(-1, {
				role: terminal.role,
				content: terminal.content,
				api: agent.state.model.api,
				provider: agent.state.model.provider,
				model: agent.state.model.id,
				usage: terminal.usage,
				stopReason: terminal.stopReason,
				timestamp: terminal.timestamp,
			});
		}
		// Execution is conservatively an effect even if it throws or observes abort.
		// Never roll it back: resume receives results, not a queue of calls to replay.
		agent.state.messages =
			keepHistory || bridge.hasStartedTools()
				? closeToolBatches(agent.state.messages)
				: previousMessages;
		agent.state.tools = [];
		agent.beforeToolCall = undefined;
		agent.afterToolCall = undefined;
		agent.shouldStopAfterTurn = undefined;
	}
};
