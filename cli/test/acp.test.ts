import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAcp } from "../src/verbs/acp.ts";
import { ALL_VERBS } from "../src/verbs/registry.ts";

const TRANSPORT_FAILURE = 7;

/** Tests for the CLI-to-ACP transport seam. */
describe("acp command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is registered as a top-level verb", () => {
		expect(ALL_VERBS.map((verb) => verb.name)).toContain("acp");
	});

	it("returns silently when the transport exits successfully", async () => {
		const stdout = vi.spyOn(process.stdout, "write");
		await executeAcp([], { runner: async () => 0 });
		expect(stdout).not.toHaveBeenCalled();
	});

	it("forwards terminal authentication to pi-acp", async () => {
		const runner = vi.fn().mockResolvedValue(0);
		await executeAcp(["--terminal-login"], { runner });
		expect(runner).toHaveBeenCalledWith(["--terminal-login"]);
	});

	it("preserves a non-zero transport exit code", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			throw new Error(`exit:${code ?? 0}`);
		}) as never);
		await expect(
			executeAcp([], { runner: async () => TRANSPORT_FAILURE }),
		).rejects.toThrow(`exit:${TRANSPORT_FAILURE}`);
		expect(exit).toHaveBeenCalledWith(TRANSPORT_FAILURE);
	});

	it("reports launch failures on stderr only", async () => {
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const stdout = vi.spyOn(process.stdout, "write");
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit:${code ?? 0}`);
		}) as never);
		await expect(
			executeAcp([], {
				runner: async () => {
					throw new Error("missing pi-acp");
				},
			}),
		).rejects.toThrow("exit:1");
		expect(stderr).toHaveBeenCalledWith(
			"error: failed to start ACP adapter: missing pi-acp\n",
		);
		expect(stdout).not.toHaveBeenCalled();
	});
});
