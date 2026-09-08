import { describe, expect, it } from "vitest";
import { planPiLaunch } from "./runtime.ts";

/** Tests for the D3R-owned Pi process boundary. */
describe("Pi runtime", () => {
	it("loads the adapter before forwarding ACP RPC arguments", () => {
		const plan = planPiLaunch(["--mode", "rpc", "--no-themes"], {
			platform: "linux",
			resolveManifest: () => "/packages/adapter-pi/package.json",
		});
		expect(plan).toEqual({
			command: "pi",
			args: [
				"--extension",
				"/packages/adapter-pi",
				"--d3r",
				"--mode",
				"rpc",
				"--no-themes",
			],
			shell: false,
		});
	});

	it("uses the Windows npm shim through a shell", () => {
		const plan = planPiLaunch([], {
			platform: "win32",
			resolveManifest: () => String.raw`C:\packages\adapter-pi\package.json`,
		});
		expect(plan.command).toBe("pi.cmd");
		expect(plan.shell).toBe(true);
	});
});
