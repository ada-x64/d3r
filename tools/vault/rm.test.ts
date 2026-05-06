// Pin the missing-file branch of vaultRm. Existence is probed via
// the shared safeStat helper; this test locks in the Result-error
// shape callers depend on when the path is absent.

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultRm } from "./rm.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

const accessor = { vaultRoot: "/vault" };

beforeEach(() => {
	vol.reset();
	vol.fromJSON({ "/vault/.keep": "" }, "/");
});

afterEach(() => {
	vol.reset();
});

describe("vaultRm", () => {
	it("returns a missing-error when the target does not exist", async () => {
		const result = await vaultRm(
			{ path: "ghost.md", recursive: false },
			accessor,
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({ kind: "missing", path: "ghost.md" });
	});
});
