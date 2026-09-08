import { describe, expect, it } from "vitest";
import { d3rPiCommandFor, planAcpLaunch } from "./runtime.ts";

/** Tests for the D3R-owned pi-acp process boundary. */
describe("ACP runtime", () => {
	it.each([
		["linux", "d3r-pi"],
		["darwin", "d3r-pi"],
		["win32", "d3r-pi.cmd"],
	] as const)("uses the D3R Pi binary shim on %s", (platform, expected) => {
		expect(d3rPiCommandFor(platform)).toBe(expected);
	});

	it("runs the resolved pi-acp entry with a protocol-safe environment", () => {
		const plan = planAcpLaunch(["--terminal-login"], {
			execPath: "/runtime/node",
			platform: "linux",
			resolvePiAcp: () => "/packages/pi-acp/dist/index.js",
		});
		expect(plan).toEqual({
			command: "/runtime/node",
			args: ["/packages/pi-acp/dist/index.js", "--terminal-login"],
			env: { PI_ACP_PI_COMMAND: "d3r-pi" },
		});
	});
});
