/* oxlint-disable no-magic-numbers -- Exercise the exact ancestry budget without filesystem depth limits. */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resourceAncestors } from "./resource-ancestors.ts";

/** Existing resource tests cover caller ordering, validation, and access policy. */
describe("resource ancestors", () => {
	const root = resolve("/");
	const limitError = new RangeError("test ancestry limit");

	it("includes only the canonical path and its parents, nearest-first through root", () => {
		const cwd = join(root, "repo", "worktree");
		expect(resourceAncestors(cwd, limitError)).toEqual([
			cwd,
			join(root, "repo"),
			root,
		]);
		expect(resourceAncestors(root, limitError)).toEqual([root]);
	});

	it("allows exactly 256 ancestors including the starting path and root", () => {
		const cwd = join(root, ...Array<string>(255).fill("x"));
		const ancestors = resourceAncestors(cwd, limitError);
		expect(ancestors).toHaveLength(256);
		expect(ancestors[0]).toBe(cwd);
		expect(ancestors.at(-1)).toBe(root);
	});

	it("throws the caller's error rather than returning truncated ancestry", () => {
		const cwd = join(root, ...Array<string>(256).fill("x"));
		expect(() => resourceAncestors(cwd, limitError)).toThrow(RangeError);
		expect(() => resourceAncestors(cwd, limitError)).toThrow(limitError);
	});
});
