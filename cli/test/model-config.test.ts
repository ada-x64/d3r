import { loadModelConfig } from "@d3r/cli/model-config";
import { vol } from "memfs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:fs/promises");

/** Roots are explicit: none of these reads use the operator's actual home directory. */
const ROOTS = {
	home: resolve("model-config-home"),
	cwd: resolve("model-config-workspace"),
};

/** Global and workspace layers are found only at these two locations. */
const GLOBAL = join(ROOTS.home, ".agents", "models.json");
const WORKSPACE = join(ROOTS.cwd, ".agents", "models.json");

/** Model references are opaque here; no provider is contacted during discovery. */
const PRESET = { id: "fast", provider: "provider-a", model: "model-a" };

/** FS-boundary tests also run against the compiled CLI subpath. */
describe("loadModelConfig", () => {
	afterEach(() => {
		vol.reset();
	});

	it("returns empty selection when neither file exists and creates nothing", async () => {
		await expect(loadModelConfig(ROOTS)).resolves.toEqual({
			ok: true,
			value: { config: { presets: [], defaultPreset: null }, sources: [] },
		});
		expect(vol.toJSON()).toEqual({});
	});

	it("loads global presets and lets the workspace select a global default", async () => {
		vol.fromJSON({
			[GLOBAL]: JSON.stringify({ version: 1, presets: [PRESET] }),
			[WORKSPACE]: JSON.stringify({ version: 1, defaultPreset: "fast" }),
		});
		const before = vol.toJSON();
		await expect(loadModelConfig(ROOTS)).resolves.toEqual({
			ok: true,
			value: {
				config: { presets: [PRESET], defaultPreset: "fast" },
				sources: [GLOBAL, WORKSPACE],
			},
		});
		expect(vol.toJSON()).toEqual(before);
	});

	it("replaces matching global entries instead of merging their fields", async () => {
		const local = { ...PRESET, provider: "provider-b", model: "model-b" };
		vol.fromJSON({
			[GLOBAL]: JSON.stringify({
				version: 1,
				presets: [{ ...PRESET, thinkingLevel: "high" }],
				defaultPreset: "fast",
			}),
			[WORKSPACE]: JSON.stringify({ version: 1, presets: [local] }),
		});
		await expect(loadModelConfig(ROOTS)).resolves.toMatchObject({
			ok: true,
			value: { config: { presets: [local], defaultPreset: "fast" } },
		});
	});

	it("supports a workspace-only configuration", async () => {
		vol.fromJSON({
			[WORKSPACE]: JSON.stringify({ version: 1, presets: [PRESET] }),
		});
		await expect(loadModelConfig(ROOTS)).resolves.toEqual({
			ok: true,
			value: {
				config: { presets: [PRESET], defaultPreset: null },
				sources: [WORKSPACE],
			},
		});
	});

	it("loads a shared home/workspace path only once", async () => {
		vol.fromJSON({
			[GLOBAL]: JSON.stringify({ version: 1, presets: [PRESET] }),
		});
		await expect(
			loadModelConfig({ home: ROOTS.home, cwd: ROOTS.home }),
		).resolves.toMatchObject({
			ok: true,
			value: { sources: [GLOBAL] },
		});
	});

	it.each([
		["syntax", "{must-not-appear-in-diagnostics", "invalid-json"],
		[
			"credential field",
			JSON.stringify({
				version: 1,
				presets: [{ ...PRESET, apiKey: "must-not-appear-in-diagnostics" }],
			}),
			"invalid-config",
		],
		["unknown version", JSON.stringify({ version: 2 }), "invalid-config"],
		[
			"duplicate preset",
			JSON.stringify({ version: 1, presets: [PRESET, PRESET] }),
			"invalid-config",
		],
	] as const)(
		"refuses workspace %s errors without falling back or echoing file bytes",
		async (_label, input, code) => {
			vol.fromJSON({
				[GLOBAL]: JSON.stringify({ version: 1, presets: [PRESET] }),
				[WORKSPACE]: input,
			});
			const result = await loadModelConfig(ROOTS);
			expect(result).toEqual({ ok: false, error: { code, path: WORKSPACE } });
			expect(JSON.stringify(result)).not.toContain(
				"must-not-appear-in-diagnostics",
			);
		},
	);

	it("does not conceal a broken global layer behind a valid workspace", async () => {
		vol.fromJSON({
			[GLOBAL]: "broken",
			[WORKSPACE]: JSON.stringify({ version: 1, presets: [PRESET] }),
		});
		await expect(loadModelConfig(ROOTS)).resolves.toEqual({
			ok: false,
			error: { code: "invalid-json", path: GLOBAL },
		});
	});

	it("reports read failures instead of treating them as absent files", async () => {
		vol.mkdirSync(WORKSPACE, { recursive: true });
		await expect(loadModelConfig(ROOTS)).resolves.toEqual({
			ok: false,
			error: { code: "read-failed", path: WORKSPACE },
		});
	});

	it("reports an unresolved default without choosing a different model", async () => {
		vol.fromJSON({
			[WORKSPACE]: JSON.stringify({
				version: 1,
				presets: [PRESET],
				defaultPreset: "missing",
			}),
		});
		await expect(loadModelConfig(ROOTS)).resolves.toEqual({
			ok: false,
			error: { code: "unknown-default-preset", presetId: "missing" },
		});
	});

	it("does not discover ancestor or vendor-specific settings", async () => {
		vol.fromJSON({
			[join(ROOTS.cwd, ".pi", "models.json")]: "broken",
			[join(ROOTS.cwd, "models.json")]: "broken",
			[WORKSPACE]: "broken",
		});
		await expect(
			loadModelConfig({ ...ROOTS, cwd: join(ROOTS.cwd, "nested") }),
		).resolves.toMatchObject({
			ok: true,
			value: { config: { presets: [], defaultPreset: null }, sources: [] },
		});
	});

	it.each(["home", "cwd"] as const)(
		"requires an absolute %s before reading configuration",
		async (root) => {
			await expect(
				loadModelConfig({ ...ROOTS, [root]: "relative" }),
			).resolves.toEqual({
				ok: false,
				error: { code: "invalid-root", root },
			});
		},
	);
});
