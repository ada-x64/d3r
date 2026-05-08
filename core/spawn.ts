// Generic process-spawning seam. Pure types + a tiny default
// implementation that captures stdout/stderr and resolves with the
// child's close-event tuple. Used by the vault git wrappers in
// `core/vault/git.ts` and any other module that needs an injectable
// subprocess runner.
//
// Lives at the package root (not under `vault/`) because
// process-spawning is not vault-specific; cross-package consumers
// (e.g. `tools/vault/init.ts`) should import from `@d3r/core/spawn`
// rather than reaching into `@d3r/core/vault/git`.

import { spawn } from "node:child_process";

export interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export type Spawn = (
	cmd: string,
	args: readonly string[],
	opts?: { cwd?: string },
) => Promise<SpawnResult>;

/**
 * Default `Spawn` implementation that captures both stdout and
 * stderr and resolves with the child's close-event tuple.
 */
export const defaultSpawn: Spawn = (cmd, args, opts = {}) => {
	const child = spawn(cmd, [...args], {
		cwd: opts.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	child.stdout.on("data", (b: Buffer) => out.push(b));
	child.stderr.on("data", (b: Buffer) => err.push(b));
	return new Promise<SpawnResult>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				exitCode: code,
				signal,
			});
		});
	});
};
