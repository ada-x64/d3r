import { randomUUID } from "node:crypto";
import {
	Agent,
	type AgentEvent,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	cleanupSessionResources,
	type Api,
	type AssistantMessage,
	type Model,
	type Models,
	type TextContent,
} from "@earendil-works/pi-ai";
import {
	type CreateRuntimeSession,
	type RuntimeContent,
	type RuntimePrompt,
	type RuntimeStopReason,
} from "@d3r/core/runtime";

/** Resource access stays with the caller's workspace and permission policy. */
export type ResolveResource = (
	resource: Extract<RuntimeContent, { type: "resource_link" }>,
	context: { readonly cwd: string; readonly signal: AbortSignal },
) => Promise<string>;

/** Explicit model configuration; this adapter never discovers user configuration. */
export interface EmbeddedRuntimeOptions {
	readonly models: Pick<Models, "streamSimple">;
	readonly model: Model<Api>;
	readonly systemPrompt: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly resolveResource?: ResolveResource;
}

/** Mutable observation data belongs to one invocation, never the provider registry. */
interface TurnState {
	messageId: string;
	finalMessage: AssistantMessage | null;
	outputFailed: boolean;
}

/** Expand links only through the injected resolver, preserving input block order. */
const prepareContent = async (
	request: RuntimePrompt,
	cwd: string,
	resolveResource: ResolveResource | undefined,
): Promise<TextContent[]> => {
	const controller = new AbortController();
	const signal = AbortSignal.any([request.signal, controller.signal]);
	const results = await Promise.allSettled(
		request.content.map(async (block): Promise<TextContent> => {
			try {
				signal.throwIfAborted();
				if (block.type === "text") {
					return { type: "text", text: block.text };
				}
				if (!resolveResource) {
					throw new Error("Resource links require a configured resolver");
				}
				const text = await resolveResource(block, { cwd, signal });
				return {
					type: "text",
					text: `Resource: ${block.name}\nURI: ${block.uri}\n\n${text}`,
				};
			} catch (error) {
				controller.abort(error);
				throw error;
			}
		}),
	);
	// Sibling resource cleanup must finish before the session can be reused/disposed.
	return results.map((result) => {
		if (result.status === "rejected") {
			throw result.reason;
		}
		return result.value;
	});
};

/** Await output delivery; Pi otherwise converts subscriber failures into messages. */
const observeTurn =
	(agent: Agent, request: RuntimePrompt, state: TurnState) =>
	async (event: AgentEvent): Promise<void> => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			state.messageId = randomUUID();
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			state.finalMessage = event.message;
		}
		if (
			event.type !== "message_update" ||
			state.outputFailed ||
			request.signal.aborted
		) {
			return;
		}
		const chunk = event.assistantMessageEvent;
		if (chunk.type !== "text_delta" && chunk.type !== "thinking_delta") {
			return;
		}
		try {
			await request.emit({
				kind: chunk.type === "text_delta" ? "text" : "thought",
				messageId: `${state.messageId}:${chunk.contentIndex}`,
				text: chunk.delta,
			});
		} catch {
			state.outputFailed = true;
			agent.abort();
		}
	};

/** Promise settlement alone is not success: Pi encodes failures in the final message. */
const turnOutcome = (state: TurnState): RuntimeStopReason => {
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
	if (message.content.some((block) => block.type === "toolCall")) {
		throw new Error("Embedded tool execution is not supported yet");
	}
	switch (message.stopReason) {
		case "stop": {
			return "completed";
		}
		case "length": {
			return "token_limit";
		}
		default: {
			throw new Error("Unsupported model completion reason");
		}
	}
};

/** Build isolated in-memory conversations with no Pi process, extensions, or tools. */
export const createEmbeddedRuntime =
	(options: EmbeddedRuntimeOptions): CreateRuntimeSession =>
	({ sessionId, cwd }) => {
		// Keep provider resource cleanup isolated even if callers reuse a session ID.
		const providerSessionId = `d3r:${sessionId}:${randomUUID()}`;
		const agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt,
				model: options.model,
				thinkingLevel: options.thinkingLevel ?? "off",
				tools: [],
			},
			streamFn: (model, context, settings) =>
				options.models.streamSimple(model, context, settings),
			sessionId: providerSessionId,
			// Unknown tool calls still trigger retries in Pi, even when tools is empty.
			shouldStopAfterTurn: () => true,
		});
		const lifecycle = { busy: false, disposed: false };
		return {
			prompt: async (request) => {
				if (lifecycle.disposed || lifecycle.busy) {
					throw new Error("Runtime session is disposed or already running");
				}
				if (request.signal.aborted) {
					return "cancelled";
				}
				lifecycle.busy = true;
				const previousMessages = [...agent.state.messages];
				const state: TurnState = {
					messageId: "",
					finalMessage: null,
					outputFailed: false,
				};
				const unsubscribe = agent.subscribe(observeTurn(agent, request, state));
				const abort = (): void => agent.abort();
				request.signal.addEventListener("abort", abort, { once: true });
				let keepHistory = false;
				try {
					const content = await prepareContent(
						request,
						cwd,
						options.resolveResource,
					);
					if (request.signal.aborted) {
						return "cancelled";
					}
					await agent.prompt({ role: "user", content, timestamp: Date.now() });
					if (request.signal.aborted) {
						return "cancelled";
					}
					const result = turnOutcome(state);
					keepHistory = result === "completed" || result === "token_limit";
					return result;
				} catch (error) {
					if (request.signal.aborted) {
						return "cancelled";
					}
					throw error;
				} finally {
					request.signal.removeEventListener("abort", abort);
					unsubscribe();
					if (!keepHistory) {
						agent.state.messages = previousMessages;
					}
					lifecycle.busy = false;
				}
			},
			dispose: async () => {
				if (lifecycle.disposed) {
					return;
				}
				if (lifecycle.busy) {
					throw new Error("Cannot dispose an active runtime session");
				}
				lifecycle.disposed = true;
				agent.reset();
				cleanupSessionResources(providerSessionId);
			},
		};
	};
