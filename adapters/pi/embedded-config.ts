import {
	type AgentMessage,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	getSupportedThinkingLevels,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import { type RuntimeConfigOption } from "@d3r/core/runtime";

/** The unselected state is metadata only, never an executable model. */
export const SELECT_MODEL = "select-model";

/** Catalog capabilities are the sole source of thinking levels. */
export const thinkingLevels = (model?: Model<Api>): readonly ThinkingLevel[] =>
	model ? getSupportedThinkingLevels(model) : ["off"];

/** Prefer disabled reasoning when supported; otherwise use the model's lowest supported level. */
export const defaultThinkingLevel = (model?: Model<Api>): ThinkingLevel => {
	const levels = thinkingLevels(model);
	const level = levels.includes("off") ? "off" : levels[0];
	if (!level) {
		throw new Error("Selected model has no supported thought levels");
	}
	return level;
};

/** Only identity is exposed or persisted, never provider configuration or headers. */
export const modelKey = (model: {
	readonly provider: string;
	readonly id: string;
}): string =>
	`${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}`;

/** The explicitly injected initial model is always a usable choice. */
export const collectModels = (
	model: Model<Api>,
	choices: readonly Model<Api>[] = [],
): readonly Model<Api>[] => [
	...new Map(
		[...choices, model].map((choice) => [modelKey(choice), choice]),
	).values(),
];

/** Reject incompatible history rather than letting a provider silently drop images. */
export const assertImageSupport = (
	model: Model<Api>,
	messages: readonly AgentMessage[],
): void => {
	if (
		!model.input.includes("image") &&
		messages.some(
			(message) =>
				(message.role === "user" || message.role === "toolResult") &&
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "image"),
		)
	) {
		throw new Error("Selected model does not support images");
	}
};

/** Selection validation is atomic and does not silently clamp the caller's intent. */
export const selectModel = (
	choices: readonly Model<Api>[],
	selection: { readonly key: string; readonly thinking?: string },
	messages: readonly AgentMessage[],
): { readonly model: Model<Api>; readonly thinkingLevel: ThinkingLevel } => {
	const model = choices.find((choice) => modelKey(choice) === selection.key);
	if (!model) {
		throw new Error("Unknown model selection");
	}
	const requested = selection.thinking ?? defaultThinkingLevel(model);
	const thinkingLevel = thinkingLevels(model).find(
		(level) => level === requested,
	);
	if (!thinkingLevel) {
		throw new Error("Unsupported thought level for selected model");
	}
	assertImageSupport(model, messages);
	return { model, thinkingLevel };
};

/** Fresh metadata arrays prevent callers from mutating session configuration. */
export const configOptions = (
	choices: readonly Model<Api>[],
	model: Model<Api> | undefined,
	thinkingLevel: string,
): RuntimeConfigOption[] => [
	{
		id: "model",
		name: "Model",
		category: "model",
		value: model ? modelKey(model) : SELECT_MODEL,
		options: [
			...(model
				? []
				: [
						{ value: SELECT_MODEL, name: "Select a model in Zed (no default)" },
					]),
			...choices.map((choice) => ({
				value: modelKey(choice),
				name: `${choice.name} (${choice.provider})`,
			})),
		],
	},
	{
		id: "thought_level",
		name: "Thought level",
		category: "thought_level",
		value: thinkingLevel,
		options: thinkingLevels(model).map((level) => ({
			value: level,
			name: level,
		})),
	},
];
