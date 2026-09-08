import { createRequire } from "node:module";
import path from "node:path";

/** Complete process plan for launching Pi with the D3R package loaded. */
export interface PiLaunchPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly shell: boolean;
}

/** Injectable values used to assemble a Pi launch plan. */
export interface PiLaunchDeps {
	readonly platform?: NodeJS.Platform;
	readonly resolveManifest?: () => string;
}

/** Resolve this adapter's package manifest from source or a workspace install. */
export const resolvePiAdapterManifest = (): string =>
	createRequire(import.meta.url).resolve("@d3r/adapter-pi/package.json");

/** Assemble a Pi invocation that always activates the D3R package and mode. */
export const planPiLaunch = (
	argv: readonly string[],
	deps: PiLaunchDeps = {},
): PiLaunchPlan => {
	const hostPlatform = deps.platform ?? process.platform;
	const resolveManifest = deps.resolveManifest ?? resolvePiAdapterManifest;
	const adapterRoot = path.dirname(resolveManifest());
	return {
		command: hostPlatform === "win32" ? "pi.cmd" : "pi",
		args: ["--extension", adapterRoot, "--d3r", ...argv],
		shell: hostPlatform === "win32",
	};
};
