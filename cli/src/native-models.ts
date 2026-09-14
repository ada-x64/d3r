import {
	defaultThinkingLevel,
	modelConfigOptions,
	modelKey as nativeModelKey,
	thinkingLevels as nativeThoughtLevels,
	type createEmbeddedRuntime,
} from "@d3r/adapter-pi/embedded";
import { type RuntimeConfigOption } from "@d3r/core/runtime";
import { type LoadedModelConfig } from "./model-config.ts";

export {
	defaultThinkingLevel,
	modelKey as nativeModelKey,
	SELECT_MODEL,
	thinkingLevels as nativeThoughtLevels,
} from "@d3r/adapter-pi/embedded";

/** Keep provider-specific types behind the adapter's public boundary. */
export type NativeModel = Parameters<typeof createEmbeddedRuntime>[0]["model"];
/** Model selection is portable metadata, not a provider object. */
export interface NativeSelection {
	readonly model: string | null;
	readonly thinking: string;
}

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
		!nativeThoughtLevels(model).some((level) => level === selection.thinking)
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
		thinking:
			selected.thinkingLevel ??
			defaultThinkingLevel(
				models.find(
					(model) =>
						model.provider === selected.provider && model.id === selected.model,
				),
			),
	};
	validateSelection(models, selection);
	return selection;
};
/** Fresh, credential-free arrays are safe for ACP session metadata. */
export const nativeModelConfig = (
	models: readonly NativeModel[],
	selection: NativeSelection,
): RuntimeConfigOption[] =>
	modelConfigOptions(
		models,
		models.find((model) => nativeModelKey(model) === selection.model),
		selection.thinking,
	);
