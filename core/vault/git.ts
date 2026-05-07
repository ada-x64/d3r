// Minimal git-subprocess seam for vault initialisation. Exports a
// `Spawn` type + tiny wrappers around `git init` / `git add` /
// `git commit`. The lifecycle work that follows extends this module
// with `gitMove`; the `Spawn` and `GitError` shapes are stable so
// the extension can reuse them as-is.

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

export interface GitError {
	kind: "git-spawn-failed";
	cmd: string;
	args: string[];
	exitCode: number | null;
	stderr: string;
}

export type GitResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: GitError };

const okGit = <T>(value: T): GitResult<T> => ({ ok: true, value });
const failGit = (error: GitError): GitResult<never> => ({ ok: false, error });

/**
 * Default `Spawn` implementation that captures both stdout and
 * stderr and resolves with the child's close-event tuple. Mirrors
 * the test exemplar at `cli/test/exemplars/spawn-runner.ts` but
 * targets arbitrary executables (not just node) so it can run
 * `git`.
 */
export const defaultSpawn: Spawn = (cmd, args, opts = {}) => {
	const child = spawn(cmd, [...args], {
		cwd: opts.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => {
		out.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		err.push(chunk);
	});
	return new Promise((resolve, reject) => {
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

const runGit = async (
	cwd: string,
	args: readonly string[],
	spawnFn: Spawn,
): Promise<GitResult<void>> => {
	const result = await spawnFn("git", ["-C", cwd, ...args]);
	if (result.exitCode !== 0 || result.signal !== null) {
		return failGit({
			kind: "git-spawn-failed",
			cmd: "git",
			args: ["-C", cwd, ...args],
			exitCode: result.exitCode,
			stderr: result.stderr,
		});
	}
	return okGit(undefined);
};

export interface GitDeps {
	spawn: Spawn;
}

/** `git -C <vaultRoot> init`. */
export const gitInit = (
	vaultRoot: string,
	deps: GitDeps,
): Promise<GitResult<void>> => runGit(vaultRoot, ["init"], deps.spawn);

/** `git -C <vaultRoot> add <paths...>`. */
export const gitAdd = (
	vaultRoot: string,
	paths: readonly string[],
	deps: GitDeps,
): Promise<GitResult<void>> => runGit(vaultRoot, ["add", ...paths], deps.spawn);

/** `git -C <vaultRoot> commit -m <message>` followed by
 * `git -C <vaultRoot> rev-parse HEAD` to capture the resulting sha. */
export const gitCommit = async (
	vaultRoot: string,
	message: string,
	deps: GitDeps,
): Promise<GitResult<{ sha: string }>> => {
	const commit = await runGit(vaultRoot, ["commit", "-m", message], deps.spawn);
	if (!commit.ok) {
		return commit;
	}
	const rev = await deps.spawn("git", ["-C", vaultRoot, "rev-parse", "HEAD"]);
	if (rev.exitCode !== 0 || rev.signal !== null) {
		return failGit({
			kind: "git-spawn-failed",
			cmd: "git",
			args: ["-C", vaultRoot, "rev-parse", "HEAD"],
			exitCode: rev.exitCode,
			stderr: rev.stderr,
		});
	}
	return okGit({ sha: rev.stdout.trim() });
};
