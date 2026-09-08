import { z } from "zod";
import { fail, ok, type Result } from "./result.ts";

/** Trim identifiers before matching defaults and detecting duplicate presets. */
const Identifier = z.string().trim().min(1);

/** Portable model selection only; unknown fields, including credentials, are refused. */
export const ModelPreset = z
	.object({
		id: Identifier,
		provider: Identifier,
		model: Identifier,
		thinkingLevel: z
			.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
			.optional(),
	})
	.strict();

/** A model preset never grants access to the provider it names. */
export type ModelPreset = z.infer<typeof ModelPreset>;

/** One D3R models.json layer; null explicitly clears an inherited default. */
export const ModelConfig = z
	.object({
		version: z.literal(1),
		presets: z.array(ModelPreset).default([]),
		defaultPreset: Identifier.nullable().optional(),
	})
	.strict()
	.superRefine((config, ctx) => {
		const ids = new Set<string>();
		config.presets.forEach((preset, index) => {
			if (ids.has(preset.id)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["presets", index, "id"],
					message: "Duplicate preset ID",
				});
			}
			ids.add(preset.id);
		});
	});

/** Typed configuration after parsing one file at the shell boundary. */
export type ModelConfig = z.infer<typeof ModelConfig>;

/** Effective selection data, not a live provider catalog or credential store. */
export interface ResolvedModelConfig {
	readonly presets: readonly ModelPreset[];
	readonly defaultPreset: string | null;
}

/** A default must resolve after all layers have been combined. */
export interface ModelConfigError {
	readonly code: "unknown-default-preset";
	readonly presetId: string;
}

/** Later layers replace whole presets by ID, retaining first-seen display order. */
export const resolveModelConfig = (
	layers: readonly ModelConfig[],
): Result<ResolvedModelConfig, ModelConfigError> => {
	const presets = new Map<string, ModelPreset>();
	let defaultPreset: string | null = null;
	for (const { presets: entries, defaultPreset: selection } of layers) {
		for (const preset of entries) {
			presets.set(preset.id, preset);
		}
		if (selection !== undefined) {
			defaultPreset = selection;
		}
	}
	if (defaultPreset !== null && !presets.has(defaultPreset)) {
		return fail({ code: "unknown-default-preset", presetId: defaultPreset });
	}
	return ok({ presets: [...presets.values()], defaultPreset });
};
