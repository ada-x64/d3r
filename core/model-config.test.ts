import { ModelConfig, resolveModelConfig } from "@d3r/core/model-config";
import { describe, expect, it } from "vitest";

/** Example identifiers are metadata, not live-provider configuration. */
const PRESET = { id: "fast", provider: "provider-a", model: "model-a" };

/** Pin D3R's versioned portable file shape, including refusal of inline credentials. */
describe("ModelConfig", () => {
	it("supports a default-only overlay and an explicitly cleared default", () => {
		expect(ModelConfig.parse({ version: 1, defaultPreset: "fast" })).toEqual({
			version: 1,
			presets: [],
			defaultPreset: "fast",
		});
		expect(
			ModelConfig.parse({ version: 1, defaultPreset: null }).defaultPreset,
		).toBeNull();
	});

	it("normalizes identifiers but leaves model selection otherwise explicit", () => {
		const config = ModelConfig.parse({
			version: 1,
			presets: [
				{
					id: " fast ",
					provider: " provider-a ",
					model: " model-a ",
					thinkingLevel: "high",
				},
			],
			defaultPreset: " fast ",
		});
		expect(config.presets).toEqual([{ ...PRESET, thinkingLevel: "high" }]);
		expect(config.defaultPreset).toBe("fast");
	});

	it.each([
		["missing version", { presets: [] }],
		["unknown version", { version: 2 }],
		["unknown root field", { version: 1, apiKey: "must-not-be-loaded" }],
		["null collection", { version: 1, presets: null }],
		[
			"duplicate ID",
			{ version: 1, presets: [PRESET, { ...PRESET, model: "different" }] },
		],
		[
			"duplicate normalized ID",
			{ version: 1, presets: [PRESET, { ...PRESET, id: " fast " }] },
		],
		["empty ID", { version: 1, presets: [{ ...PRESET, id: " " }] }],
		["empty provider", { version: 1, presets: [{ ...PRESET, provider: "" }] }],
		["empty model", { version: 1, presets: [{ ...PRESET, model: " " }] }],
		[
			"unsupported thinking level",
			{ version: 1, presets: [{ ...PRESET, thinkingLevel: "arbitrary" }] },
		],
		[
			"inline API key",
			{ version: 1, presets: [{ ...PRESET, apiKey: "must-not-be-loaded" }] },
		],
		[
			"inline token",
			{ version: 1, presets: [{ ...PRESET, token: "must-not-be-loaded" }] },
		],
		[
			"inline headers",
			{
				version: 1,
				presets: [
					{ ...PRESET, headers: { Authorization: "must-not-be-loaded" } },
				],
			},
		],
		[
			"partial preset override",
			{ version: 1, presets: [{ id: "fast", model: "new-model" }] },
		],
	] as const)("refuses %s", (_label, input) => {
		expect(ModelConfig.safeParse(input).success).toBe(false);
	});
});

/** Pure overlay rules are independent of any adapter, filesystem, or provider catalog. */
describe("resolveModelConfig", () => {
	it("does not choose a default implicitly", () => {
		expect(resolveModelConfig([])).toEqual({
			ok: true,
			value: { presets: [], defaultPreset: null },
		});
		expect(
			resolveModelConfig([
				ModelConfig.parse({ version: 1, presets: [PRESET] }),
			]),
		).toEqual({
			ok: true,
			value: { presets: [PRESET], defaultPreset: null },
		});
	});

	it("replaces complete presets by ID while retaining first-seen order", () => {
		const global = ModelConfig.parse({
			version: 1,
			presets: [
				{ ...PRESET, thinkingLevel: "high" },
				{ ...PRESET, id: "deep" },
			],
			defaultPreset: "fast",
		});
		const replacement = { ...PRESET, provider: "provider-b", model: "model-b" };
		const added = { ...PRESET, id: "local" };
		const workspace = ModelConfig.parse({
			version: 1,
			presets: [replacement, added],
		});
		const before = JSON.stringify([global, workspace]);
		Object.freeze(global.presets);
		Object.freeze(workspace.presets);
		expect(resolveModelConfig([global, workspace])).toEqual({
			ok: true,
			value: {
				presets: [replacement, { ...PRESET, id: "deep" }, added],
				defaultPreset: "fast",
			},
		});
		expect(JSON.stringify([global, workspace])).toBe(before);
	});

	it.each([
		[{}, "fast"],
		[{ defaultPreset: "deep" }, "deep"],
		[{ defaultPreset: null }, null],
	] as const)("resolves default overlay %j", (override, expected) => {
		const layers = [
			ModelConfig.parse({
				version: 1,
				presets: [PRESET, { ...PRESET, id: "deep" }],
				defaultPreset: "fast",
			}),
			ModelConfig.parse({ version: 1, ...override }),
		];
		expect(resolveModelConfig(layers)).toMatchObject({
			ok: true,
			value: { defaultPreset: expected },
		});
	});

	it("validates the default against the final overlay, not individual layers", () => {
		const base = ModelConfig.parse({ version: 1, defaultPreset: "fast" });
		expect(resolveModelConfig([base])).toEqual({
			ok: false,
			error: { code: "unknown-default-preset", presetId: "fast" },
		});
		expect(
			resolveModelConfig([
				base,
				ModelConfig.parse({ version: 1, presets: [PRESET] }),
			]),
		).toMatchObject({ ok: true });
	});

	it("treats object-prototype names as ordinary preset IDs", () => {
		const preset = { ...PRESET, id: "__proto__" };
		expect(
			resolveModelConfig([
				ModelConfig.parse({
					version: 1,
					presets: [preset],
					defaultPreset: "__proto__",
				}),
			]),
		).toEqual({
			ok: true,
			value: { presets: [preset], defaultPreset: "__proto__" },
		});
	});
});
