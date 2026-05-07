// Pin the dotfile allowlist. The list is one entry today; the test
// fails fast if a contributor extends it without updating consumers.

import { describe, expect, it } from "vitest";

import { DOTFILE_ALLOWLIST } from "./layout.ts";

describe("layout", () => {
	it("admits exactly .git as the sole vault-root dotfile", () => {
		expect(DOTFILE_ALLOWLIST.size).toBe(1);
		expect(DOTFILE_ALLOWLIST.has(".git")).toBe(true);
	});
});
