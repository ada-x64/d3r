import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAcp, launchAcp } from "../src/verbs/acp.ts";
import { ALL_VERBS } from "../src/verbs/registry.ts";

const TRANSPORT_FAILURE = 7;

/** Tests for the CLI-to-ACP transport seam. */
describe("acp command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects native by default and never starts legacy", async () => {
		const native = vi.fn().mockResolvedValue(0);
		const legacy = vi.fn();
		await expect(launchAcp([], { native, legacy })).resolves.toBe(0);
		expect(native).toHaveBeenCalledWith(undefined);
		expect(legacy).not.toHaveBeenCalled();
	});

	it("forwards an explicit native preset", async () => {
		const native = vi.fn().mockResolvedValue(0);
		await launchAcp(["--native", "--preset", "careful"], { native });
		expect(native).toHaveBeenCalledWith("careful");
	});

	it("keeps terminal login separate from protocol startup", async () => {
		const login = vi.fn().mockResolvedValue(undefined);
		const native = vi.fn();
		await expect(
			launchAcp(["--terminal-login"], { login, native }),
		).resolves.toBe(0);
		expect(login).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
	});

	it("retains the explicit legacy login path", async () => {
		const legacy = vi.fn().mockResolvedValue(0);
		const login = vi.fn();
		await launchAcp(["--legacy", "--terminal-login"], { legacy, login });
		expect(legacy).toHaveBeenCalledWith(["--terminal-login"]);
		expect(login).not.toHaveBeenCalled();
	});

	it.each([
		["--legacy", "--native"],
		["--legacy", "--preset", "fast"],
	])("refuses incompatible launch options %j", async (...args) => {
		const native = vi.fn();
		const legacy = vi.fn();
		await expect(launchAcp(args, { native, legacy })).rejects.toThrow();
		expect(native).not.toHaveBeenCalled();
		expect(legacy).not.toHaveBeenCalled();
	});

	it("is registered as a top-level verb", () => {
		expect(ALL_VERBS.map((verb) => verb.name)).toContain("acp");
	});

	it("returns silently when the transport exits successfully", async () => {
		const stdout = vi.spyOn(process.stdout, "write");
		await executeAcp([], { runner: async () => 0 });
		expect(stdout).not.toHaveBeenCalled();
	});

	it("forwards terminal authentication to the selected launcher", async () => {
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
