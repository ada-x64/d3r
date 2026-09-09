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
	selection: { readonly key: string; readonly thinking: string },
	messages: readonly AgentMessage[],
): { readonly model: Model<Api>; readonly thinkingLevel: ThinkingLevel } => {
	const model = choices.find((choice) => modelKey(choice) === selection.key);
	if (!model) {
		throw new Error("Unknown model selection");
	}
	const thinkingLevel = getSupportedThinkingLevels(model).find(
		(level) => level === selection.thinking,
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
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
): readonly RuntimeConfigOption[] => [
	{
		id: "model",
		name: "Model",
		category: "model",
		value: modelKey(model),
		options: choices.map((choice) => ({
			value: modelKey(choice),
			name: `${choice.name} (${choice.provider})`,
		})),
	},
	{
		id: "thought_level",
		name: "Thought level",
		category: "thought_level",
		value: thinkingLevel,
		options: getSupportedThinkingLevels(model).map((level) => ({
			value: level,
			name: level,
		})),
	},
];
