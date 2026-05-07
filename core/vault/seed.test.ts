// Cover the seed-resolution helpers. `defaultSeedDir` is pure
// path arithmetic; `assertSeedExists` exercises the ENOENT vs
// success branches against memfs.

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSeedExists, defaultSeedDir } from "./seed.ts";
import { SEED_ROOT } from "./seed-root.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

beforeEach(() => {
	vol.reset();
});

afterEach(() => {
	vol.reset();
});

describe("defaultSeedDir", () => {
	it("returns the same absolute path as SEED_ROOT", () => {
		expect(defaultSeedDir()).toBe(SEED_ROOT);
	});
});

describe("assertSeedExists", () => {
	it("returns ok when the directory exists", async () => {
		vol.fromJSON({ "/seed/AGENTS.md": "x\n" }, "/");
		const r = await assertSeedExists("/seed");
		expect(r.ok).toBe(true);
	});

	it("returns ok when the path is a file (cp will fail later)", async () => {
		vol.fromJSON({ "/somefile": "x" }, "/");
		const r = await assertSeedExists("/somefile");
		expect(r.ok).toBe(true);
	});

	it("returns seed-missing on ENOENT", async () => {
		const r = await assertSeedExists("/no/such/seed");
		expect(r.ok).toBe(false);
		if (r.ok) {
			return;
		}
		expect(r.error).toEqual({ kind: "seed-missing", path: "/no/such/seed" });
	});

	it("returns seed-missing on ENOTDIR (parent is a file)", async () => {
		vol.fromJSON({ "/file": "x" }, "/");
		const r = await assertSeedExists("/file/inner");
		expect(r.ok).toBe(false);
		if (r.ok) {
			return;
		}
		expect(r.error.kind).toBe("seed-missing");
	});
});
