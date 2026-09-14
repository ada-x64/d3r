import {
	type RuntimeConfigOption,
	type RuntimeSession,
} from "@d3r/core/runtime";
import { type SessionConfigOption } from "@agentclientprotocol/sdk";
import { z } from "zod";

/** Validate nonmutating configuration reads before allowing restoration to change state. */
const runtimeConfigSchema = z
	.array(
		z
			.object({
				id: z.string().min(1),
				name: z.string(),
				category: z.enum(["model", "thought_level", "mode", "_d3r"]),
				value: z.string(),
				options: z
					.array(z.object({ value: z.string(), name: z.string() }))
					.min(1),
			})
			.refine(
				(option) =>
					option.options.some((row) => row.value === option.value) &&
					new Set(option.options.map((row) => row.value)).size ===
						option.options.length,
			),
	)
	.refine(
		(options) =>
			new Set(options.map((option) => option.id)).size === options.length,
	);
/** Missing config hooks remain unsupported rather than becoming synthetic selectors. */
export const readRuntimeConfig = (
	runtime: RuntimeSession,
): readonly RuntimeConfigOption[] | undefined =>
	runtime.getConfig
		? runtimeConfigSchema.parse(runtime.getConfig())
		: undefined;
/** Backend preflight owns dependent values; validate those against the restored state, not fresh menus. */
export const validateRestoreConfig = (
	runtime: RuntimeSession,
	saved: readonly { readonly id: string; readonly value: string }[],
	check: "selectors" | "available" | "selected" = "available",
): void => {
	if (new Set(saved.map((option) => option.id)).size !== saved.length) {
		throw new Error("Duplicate stored configuration selector");
	}
	const current = readRuntimeConfig(runtime) ?? [];
	for (const option of saved) {
		const selector = current.find((row) => row.id === option.id);
		if (
			!selector ||
			(check === "available" &&
				!selector.options.some((row) => row.value === option.value))
		) {
			throw new Error("Stored configuration option or value is unavailable");
		}
		if (check === "selected" && selector.value !== option.value) {
			throw new Error("Stored configuration was not restored");
		}
	}
};
/** Runtime selectors map to ACP select options, never synthetic models or modes. */
export const configOptions = (
	config: readonly RuntimeConfigOption[],
): SessionConfigOption[] =>
	config
		// Keep fixed values in persisted runtime metadata, not as meaningless UI controls.
		.filter(
			(option) =>
				option.category !== "thought_level" || option.options.length > 1,
		)
		.map((option) => ({
			id: option.id,
			name: option.name,
			category: option.category,
			type: "select",
			currentValue: option.value,
			options: option.options.map((value) => ({ ...value })),
		}));
