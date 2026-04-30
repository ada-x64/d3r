// Smoke test for runAndCapture. The intent is to pin d3r's
// spawn wiring: the captured stdout shape and the surfaced exit
// code. The fixture under `../fixtures/bin/echo-stub.mjs` is a
// real Node subprocess; the assertions are about runAndCapture's
// returned record, not about node:child_process or the runtime.

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runAndCapture } from "./spawn-runner.ts";

const stubPath = fileURLToPath(
	new URL("../fixtures/bin/echo-stub.mjs", import.meta.url),
);

describe("runAndCapture", () => {
	it("captures stdout and a zero exit code", async () => {
		const result = await runAndCapture(stubPath, ["hello", "0"]);

		expect(result).toEqual({ stdout: "hello", exitCode: 0, signal: null });
	});

	it("surfaces a non-zero exit code verbatim", async () => {
		const result = await runAndCapture(stubPath, ["bye", "1"]);

		expect(result).toEqual({ stdout: "bye", exitCode: 1, signal: null });
	});

	it("surfaces a terminating signal as `signal`, with a null `exitCode`", async () => {
		const result = await runAndCapture(stubPath, ["interrupted", "SIGTERM"]);

		expect(result).toEqual({
			stdout: "interrupted",
			exitCode: null,
			signal: "SIGTERM",
		});
	});
});
