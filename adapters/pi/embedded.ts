import { randomUUID } from "node:crypto";
import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	cleanupSessionResources,
	type Api,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { type CreateRuntimeSession, type RuntimeTool } from "@d3r/core/runtime";
import { parseCheckpoint } from "./embedded-checkpoint.ts";
import {
	collectModels,
	configOptions,
	modelKey,
	selectModel,
} from "./embedded-config.ts";
import { type ResolveResource } from "./embedded-content.ts";
import { compileTools } from "./embedded-tools.ts";
import { runEmbeddedTurn } from "./embedded-turn.ts";

export { type ResolveResource } from "./embedded-content.ts";

/** Explicit capabilities only; the adapter never discovers providers, auth, or tools. */
export interface EmbeddedRuntimeOptions {
	readonly models: Pick<Models, "streamSimple">;
	readonly model: Model<Api>;
	readonly systemPrompt: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly resolveResource?: ResolveResource;
	readonly tools?: readonly RuntimeTool[];
	readonly modelChoices?: readonly Model<Api>[];
	readonly maxTurns?: number;
}

/** Bound provider requests, including repeated hallucinated tool names. */
const DEFAULT_MAX_TURNS = 20;

/** Build isolated in-memory conversations with injected IO and idle-only checkpoints. */
export const createEmbeddedRuntime = (
	options: EmbeddedRuntimeOptions,
): CreateRuntimeSession => {
	const definitions = compileTools(options.tools);
	const choices = collectModels(options.model, options.modelChoices);
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
		throw new Error("maxTurns must be a positive safe integer");
	}
	if (typeof options.systemPrompt !== "string") {
		throw new Error("systemPrompt must be a string");
	}
	const initial = selectModel(
		choices,
		{ key: modelKey(options.model), thinking: options.thinkingLevel ?? "off" },
		[],
	);
	return (input) => {
		// External IDs may be reused; provider cleanup and tool presentation must not collide.
		const providerSessionId = `d3r:${input.sessionId}:${randomUUID()}`;
		const agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt,
				...initial,
				tools: [],
			},
			streamFn: (model, context, settings) =>
				options.models.streamSimple(model, context, settings),
			sessionId: providerSessionId,
		});
		const lifecycle = { busy: false, disposed: false };
		const assertIdle = (): void => {
			if (lifecycle.disposed || lifecycle.busy) {
				throw new Error("Runtime session is disposed or already running");
			}
		};
		const getConfig = () =>
			configOptions(choices, agent.state.model, agent.state.thinkingLevel);
		return {
			prompt: async (request) => {
				assertIdle();
				if (request.signal.aborted) {
					return "cancelled";
				}
				lifecycle.busy = true;
				try {
					return await runEmbeddedTurn(agent, request, {
						input,
						definitions,
						maxTurns,
						namespace: providerSessionId,
						resolveResource: options.resolveResource,
					});
				} finally {
					lifecycle.busy = false;
				}
			},
			getConfig,
			setConfig: async (id, value) => {
				assertIdle();
				if (id !== "model" && id !== "thought_level") {
					throw new Error("Unknown runtime configuration option");
				}
				const selection = selectModel(
					choices,
					{
						key: id === "model" ? value : modelKey(agent.state.model),
						thinking:
							id === "thought_level" ? value : agent.state.thinkingLevel,
					},
					agent.state.messages,
				);
				Object.assign(agent.state, selection);
				return getConfig();
			},
			snapshot: () => {
				assertIdle();
				return parseCheckpoint({
					version: 1,
					format: "d3r.pi.embedded",
					model: {
						provider: agent.state.model.provider,
						id: agent.state.model.id,
					},
					thinkingLevel: agent.state.thinkingLevel,
					messages: agent.state.messages,
				});
			},
			restore: (checkpoint) => {
				assertIdle();
				const parsed = parseCheckpoint(checkpoint);
				const selection = selectModel(
					choices,
					{ key: modelKey(parsed.model), thinking: parsed.thinkingLevel },
					parsed.messages,
				);
				Object.assign(agent.state, selection);
				agent.state.messages = parsed.messages;
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
};
