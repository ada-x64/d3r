import { loadModelConfig } from "@d3r/cli/model-config";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Real files are required to exercise no-follow opens and file-type/size checks. */
describe("model configuration path safety", () => {
	let root = "";
	let file = "";
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "d3r-model-paths-"));
		await mkdir(join(root, ".agents"));
		file = join(root, ".agents", "models.json");
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("refuses symlinks rather than following them to arbitrary streams", async () => {
		const target = join(root, "target.json");
		await writeFile(target, JSON.stringify({ version: 1 }));
		await symlink(target, file);
		await expect(loadModelConfig({ home: root, cwd: root })).resolves.toEqual({
			ok: false,
			error: { code: "read-failed", path: file },
		});
	});

	it("refuses oversized regular files before parsing them", async () => {
		const oversized = 1_048_577;
		await writeFile(file, " ".repeat(oversized));
		await expect(loadModelConfig({ home: root, cwd: root })).resolves.toEqual({
			ok: false,
			error: { code: "read-failed", path: file },
		});
	});

	it("propagates setup cancellation instead of reporting missing configuration", async () => {
		await expect(
			loadModelConfig(
				{ home: root, cwd: root },
				{ signal: AbortSignal.abort() },
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
