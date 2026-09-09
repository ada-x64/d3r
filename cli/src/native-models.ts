import { type createEmbeddedRuntime } from "@d3r/adapter-pi/embedded";
import { type RuntimeConfigOption } from "@d3r/core/runtime";
import { type LoadedModelConfig } from "./model-config.ts";

/** Keep provider-specific types behind the adapter's public boundary. */
export type NativeModel = Parameters<typeof createEmbeddedRuntime>[0]["model"];
/** Model selection is portable metadata, not a provider object. */
export interface NativeSelection {
	readonly model: string | null;
	readonly thinking: string;
}
/** The picker sentinel never identifies an executable model. */
export const SELECT_MODEL = "select-model";
/** Stable identity shared with the embedded adapter's model picker. */
export const nativeModelKey = (
	model: Pick<NativeModel, "provider" | "id">,
): string =>
	`${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}`;
/** Portable thought levels; extended levels require explicit model support. */
export const THOUGHT_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
/** Menu construction reads catalog metadata only; it never resolves credentials. */
export const nativeThoughtLevels = (model?: NativeModel): readonly string[] =>
	!model?.reasoning
		? ["off"]
		: THOUGHT_LEVELS.filter((level) => {
				const mapped = model.thinkingLevelMap?.[level];
				return (
					mapped !== null &&
					(!["xhigh", "max"].includes(level) || mapped !== undefined)
				);
			});
/** Reject unavailable identities and unsupported levels without silently substituting a model. */
export const validateSelection = (
	models: readonly NativeModel[],
	selection: NativeSelection,
): void => {
	const model = models.find(
		(entry) => nativeModelKey(entry) === selection.model,
	);
	if (
		(selection.model !== null && !model) ||
		!nativeThoughtLevels(model).includes(selection.thinking)
	) {
		throw new Error(
			"Unavailable model or unsupported thought level; select a usable model and thought level in Zed",
		);
	}
};
/** A configured default or explicit preset is consent to that selection, never to a fallback. */
export const initialSelection = (
	models: readonly NativeModel[],
	loaded: LoadedModelConfig,
	preset?: string,
): NativeSelection => {
	const id = preset ?? loaded.config.defaultPreset;
	if (id === null || id === undefined) {
		return { model: null, thinking: "off" };
	}
	const selected = loaded.config.presets.find((entry) => entry.id === id);
	if (!selected) {
		throw new Error(
			"Unknown model preset; configure it in .agents/models.json or select a model in Zed",
		);
	}
	const selection = {
		model: nativeModelKey({ provider: selected.provider, id: selected.model }),
		thinking: selected.thinkingLevel ?? "off",
	};
	validateSelection(models, selection);
	return selection;
};
/** Fresh, credential-free arrays are safe for ACP session metadata. */
export const nativeModelConfig = (
	models: readonly NativeModel[],
	selection: NativeSelection,
): RuntimeConfigOption[] => [
	{
		id: "model",
		name: "Model",
		category: "model",
		value: selection.model ?? SELECT_MODEL,
		options: [
			...(selection.model === null
				? [{ value: SELECT_MODEL, name: "Select a model in Zed (no default)" }]
				: []),
			...models.map((model) => ({
				value: nativeModelKey(model),
				name: `${model.name} (${model.provider})`,
			})),
		],
	},
	{
		id: "thought_level",
		name: "Thought level",
		category: "thought_level",
		value: selection.thinking,
		options: nativeThoughtLevels(
			models.find((model) => nativeModelKey(model) === selection.model),
		).map((level) => ({ value: level, name: level })),
	},
];
