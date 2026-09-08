import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const EXIT_FAILURE = 1;
const EXIT_SIGNAL = 128;

/** Complete process plan for the ACP transport. */
export interface AcpLaunchPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

/** Injectable values used to assemble an ACP launch plan. */
export interface AcpLaunchDeps {
	readonly execPath?: string;
	readonly platform?: NodeJS.Platform;
	readonly resolvePiAcp?: () => string;
}

/** Resolve the executable pi-acp module installed with this adapter. */
export const resolvePiAcpEntry = (): string =>
	createRequire(import.meta.url).resolve("pi-acp");

/** Select the npm binary shim pi-acp should use to start D3R's Pi runtime. */
export const d3rPiCommandFor = (hostPlatform: NodeJS.Platform): string =>
	hostPlatform === "win32" ? "d3r-pi.cmd" : "d3r-pi";

/** Assemble the process and environment used by `d3r acp`. */
export const planAcpLaunch = (
	argv: readonly string[] = [],
	deps: AcpLaunchDeps = {},
): AcpLaunchPlan => {
	const hostPlatform = deps.platform ?? process.platform;
	const resolvePiAcp = deps.resolvePiAcp ?? resolvePiAcpEntry;
	return {
		command: deps.execPath ?? process.execPath,
		args: [resolvePiAcp(), ...argv],
		env: { PI_ACP_PI_COMMAND: d3rPiCommandFor(hostPlatform) },
	};
};

/** Run pi-acp over inherited stdio and return its process exit code. */
export const runAcp = (
	plan: AcpLaunchPlan = planAcpLaunch(),
): Promise<number> =>
	new Promise((resolve, reject) => {
		const child = spawn(plan.command, [...plan.args], {
			stdio: "inherit",
			env: { ...process.env, ...plan.env },
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			resolve(code ?? (signal === null ? EXIT_FAILURE : EXIT_SIGNAL));
		});
	});
