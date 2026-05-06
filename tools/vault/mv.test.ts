// Pin the missing-source and existing-target branches of vaultMv.
// Both checks route through the shared safeStat helper; these tests
// lock in the Result-error shapes callers depend on.

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultMv } from "./mv.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

const accessor = { vaultRoot: "/vault" };

beforeEach(() => {
	vol.reset();
	vol.fromJSON({ "/vault/here.md": "hello\n" }, "/");
});

afterEach(() => {
	vol.reset();
});

describe("vaultMv", () => {
	it("returns a missing-error when the source does not exist", async () => {
		const result = await vaultMv(
			{ from: "ghost.md", to: "elsewhere.md", overwrite: false },
			accessor,
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({ kind: "missing", path: "ghost.md" });
	});

	it("returns an exists-error when the target exists and overwrite is false", async () => {
		vol.fromJSON({ "/vault/there.md": "world\n" }, "/");
		const result = await vaultMv(
			{ from: "here.md", to: "there.md", overwrite: false },
			accessor,
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({ kind: "exists", path: "there.md" });
	});
});
