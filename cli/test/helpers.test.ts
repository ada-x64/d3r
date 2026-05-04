// Unit tests for the small predicates and process wrappers in
// cli/src/utils/helpers.ts. `isEnoent` is exhaustively table-driven
// since it exists to centralise an error-shape check that used to be
// inlined in the install verb. `runNpm` is exercised via a real
// subprocess against `node -e` so the spawn wiring (exit-code surfacing
// and the `error → reject` path) is pinned without mocking
// node:child_process.

import { describe, expect, it } from "vitest";

import { isEnoent, runNpm } from "../src/utils/helpers.ts";

describe("isEnoent", () => {
	it.each([
		["{ code: 'ENOENT' }", { code: "ENOENT" }, true],
		["{ code: 'EACCES' }", { code: "EACCES" }, false],
		["null", null, false],
		["undefined", undefined, false],
		["empty object", {}, false],
		["plain string", "string", false],
	])("returns %s for %s", (_label, input, expected) => {
		expect(isEnoent(input)).toBe(expected);
	});
});

describe("runNpm", () => {
	it("resolves with the subprocess exit code", async () => {
		const EXPECTED_EXIT = 7;
		const code = await runNpm(process.execPath, [
			"-e",
			`process.exit(${EXPECTED_EXIT})`,
		]);
		expect(code).toBe(EXPECTED_EXIT);
	});

	it("rejects when the binary cannot be spawned", async () => {
		await expect(
			runNpm("/definitely/not/a/real/binary-xyz", []),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
