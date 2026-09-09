import { randomUUID } from "node:crypto";
import { type Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import {
	type RuntimeActivity,
	type RuntimePrompt,
	type RuntimeSessionInput,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { closeToolBatches } from "./embedded-checkpoint.ts";
import { prepareContent, type ResolveResource } from "./embedded-content.ts";
import { createToolBridge, type EmbeddedTool } from "./embedded-tools.ts";

/** Mutable observation data belongs to one invocation, never the provider registry. */
interface TurnState {
	messageId: string;
	finalMessage: AssistantMessage | null;
	outputFailed: boolean;
	turns: number;
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
		state.turns += 1;
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
): RuntimeStopReason => {
	if (state.outputFailed) {
		throw new Error("Runtime output delivery failed");
	}
	const message = state.finalMessage;
	if (!message) {
		throw new Error("Model response did not complete");
	}
	if (message.stopReason === "error") {
		throw new Error("Model request failed");
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
export const runEmbeddedTurn = async (
	agent: Agent,
	request: RuntimePrompt,
	{
		input,
		definitions,
		maxTurns,
		namespace,
		resolveResource,
	}: {
		readonly input: RuntimeSessionInput;
		readonly definitions: readonly EmbeddedTool[];
		readonly maxTurns: number;
		readonly namespace: string;
		readonly resolveResource?: ResolveResource;
	},
): Promise<RuntimeStopReason> => {
	const previousMessages = [...agent.state.messages];
	const state: TurnState = {
		messageId: "",
		finalMessage: null,
		outputFailed: false,
		turns: 0,
	};
	const activity = async (event: RuntimeActivity) =>
		deliver(agent, state, async () =>
			request.activity?.(structuredClone(event)),
		);
	const bridge = createToolBridge(definitions, input, {
		namespace,
		requestSignal: request.signal,
		activity,
	});
	Object.assign(agent, {
		beforeToolCall: bridge.beforeToolCall,
		afterToolCall: bridge.afterToolCall,
		shouldStopAfterTurn: () =>
			definitions.length === 0 ||
			state.turns >= maxTurns ||
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
	try {
		const content = await prepareContent(request, agent.state.model, {
			cwd: input.cwd,
			resolveResource,
		});
		if (request.signal.aborted) {
			return "cancelled";
		}
		await agent.prompt({ role: "user", content, timestamp: Date.now() });
		if (request.signal.aborted) {
			return "cancelled";
		}
		const result = turnOutcome(state, definitions.length > 0);
		keepHistory = result !== "cancelled";
		return result;
	} catch (error) {
		if (request.signal.aborted) {
			return "cancelled";
		}
		throw error;
	} finally {
		request.signal.removeEventListener("abort", abort);
		unsubscribe();
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
