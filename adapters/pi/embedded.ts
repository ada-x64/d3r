import { randomUUID } from "node:crypto";
import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	cleanupSessionResources,
	type Api,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { type CreateRuntimeSession, type RuntimeTool } from "@d3r/core/runtime";
import {
	beginBudgetedRequest,
	createRequestBudget,
	parseRequestBudgetLimits,
	REQUEST_EXTENSION_TOOL,
	type RequestBudget,
} from "./embedded-budget.ts";
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
export { parseCheckpoint as parseEmbeddedCheckpoint } from "./embedded-checkpoint.ts";
export {
	configOptions as modelConfigOptions,
	defaultThinkingLevel,
	modelKey,
	SELECT_MODEL,
	thinkingLevels,
} from "./embedded-config.ts";

/** Explicit capabilities only; the adapter never discovers providers, auth, or tools. */
export interface EmbeddedRuntimeOptions {
	readonly models: Pick<Models, "streamSimple">;
	readonly model: Model<Api>;
	readonly systemPrompt: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly resolveResource?: ResolveResource;
	readonly tools?: readonly RuntimeTool[];
	readonly modelChoices?: readonly Model<Api>[];
	/** Initial model requests including synthesis (default: 50); null removes the D3R limit. */
	readonly maxTurns?: number | null;
	/** Non-extendable ceiling (default: max(maxTurns, 100)); incompatible with null maxTurns. */
	readonly maxTotalTurns?: number;
	/** Routing or role name shown in resource-extension approval titles. */
	readonly budgetLabel?: string;
}

/** Build isolated in-memory conversations with injected IO and idle-only checkpoints. */
export const createEmbeddedRuntime = (
	options: EmbeddedRuntimeOptions,
): CreateRuntimeSession => {
	const definitions = compileTools(options.tools);
	const choices = collectModels(options.model, options.modelChoices);
	const limits = parseRequestBudgetLimits(options);
	if (definitions.some(({ tool }) => tool.name === REQUEST_EXTENSION_TOOL)) {
		throw new Error(
			`${REQUEST_EXTENSION_TOOL} is reserved for request budget control`,
		);
	}
	if (
		options.budgetLabel !== undefined &&
		typeof options.budgetLabel !== "string"
	) {
		throw new Error("budgetLabel must be a string");
	}
	if (typeof options.systemPrompt !== "string") {
		throw new Error("systemPrompt must be a string");
	}
	const initial = selectModel(
		choices,
		{ key: modelKey(options.model), thinking: options.thinkingLevel },
		[],
	);
	return (input) => {
		// External IDs may be reused; provider cleanup and tool presentation must not collide.
		const providerSessionId = `d3r:${input.sessionId}:${randomUUID()}`;
		const lifecycle: {
			busy: boolean;
			disposed: boolean;
			budget?: RequestBudget | null;
		} = { busy: false, disposed: false };
		const agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt,
				...initial,
				tools: [],
			},
			streamFn: (model, context, settings) => {
				if (lifecycle.budget === undefined) {
					throw new Error("Model request requires an active invocation budget");
				}
				settings?.signal?.throwIfAborted();
				return options.models.streamSimple(
					model,
					lifecycle.budget === null
						? context
						: {
								...context,
								systemPrompt: beginBudgetedRequest(
									lifecycle.budget,
									context.systemPrompt,
								),
							},
					settings,
				);
			},
			sessionId: providerSessionId,
		});

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
				const budget = createRequestBudget(
					limits,
					request.signal,
					definitions.length > 0,
				);
				lifecycle.budget = budget;
				try {
					return await runEmbeddedTurn(agent, request, {
						input,
						definitions,
						budget,
						budgetLabel: options.budgetLabel,
						namespace: providerSessionId,
						resolveResource: options.resolveResource,
					});
				} finally {
					if (budget !== null) {
						budget.active = false;
					}
					lifecycle.budget = undefined;
					lifecycle.busy = false;
				}
			},
			getConfig,
			setConfig: async (id, value) => {
				assertIdle();
				if (id !== "model" && id !== "thought_level") {
					throw new Error("Unknown runtime configuration option");
				}
				const changingModel =
					id === "model" && value !== modelKey(agent.state.model);
				const thinking =
					id === "thought_level" ? value : agent.state.thinkingLevel;
				const selection = selectModel(
					choices,
					{
						key: id === "model" ? value : modelKey(agent.state.model),
						thinking: changingModel ? undefined : thinking,
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
