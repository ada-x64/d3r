// Greenfield vault initialisation. Refuses on a non-empty
// destination or a pre-existing `.git/` (typed errors, no
// writes), copies the seed tree, then runs `git init && git add
// . && git commit -m "chore: initial vault seed"` through the
// injectable spawn seam.
//
// The empty-destination check is explicit rather than delegated
// to `fs.cp({ errorOnExist: true })`: Node #58947 documents that
// `errorOnExist` behaves inconsistently between files and
// directories on every Node 20.x and most 22.x releases, so the
// option is unsafe to rely on as the only safety net.

import { cp, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { defaultSpawn, gitAdd, gitCommit, gitInit, type Spawn } from "./git.ts";
import {
	assertSeedExists,
	defaultSeedDir,
	fail,
	ok,
	type Result,
} from "./seed.ts";

export interface InitParams {
	vaultRoot: string;
	/** Internal test seam; not exposed via CLI or agent tool. */
	seedDir?: string;
}

export interface InitReport {
	vaultRoot: string;
	seedDir: string;
	commit: string;
}

export type InitError =
	| { kind: "vault-not-empty"; path: string; entries: string[] }
	| { kind: "git-already-initialized"; path: string }
	| { kind: "seed-missing"; path: string }
	| {
			kind: "git-spawn-failed";
			cmd: string;
			args: string[];
			exitCode: number | null;
			stderr: string;
	  };

const COMMIT_SUBJECT = "chore: initial vault seed";

const safeReaddir = async (dir: string): Promise<string[] | null> => {
	try {
		return await readdir(dir);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return null;
		}
		throw error;
	}
};

const exists = async (target: string): Promise<boolean> => {
	try {
		await stat(target);
		return true;
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return false;
		}
		throw error;
	}
};

export const initVault = async (
	params: InitParams,
	deps?: { spawn?: Spawn },
): Promise<Result<InitReport, InitError>> => {
	const seedDir = params.seedDir ?? defaultSeedDir();
	const seedCheck = await assertSeedExists(seedDir);
	if (!seedCheck.ok) {
		return fail(seedCheck.error);
	}

	// `.git/` precondition wins over the generic non-empty refusal so
	// callers see the more specific message when both apply.
	const gitDir = path.join(params.vaultRoot, ".git");
	if (await exists(gitDir)) {
		return fail({ kind: "git-already-initialized", path: gitDir });
	}

	const entries = await safeReaddir(params.vaultRoot);
	if (entries !== null && entries.length > 0) {
		return fail({
			kind: "vault-not-empty",
			path: params.vaultRoot,
			entries,
		});
	}

	await cp(seedDir, params.vaultRoot, { recursive: true });

	const spawnFn: Spawn = deps?.spawn ?? defaultSpawn;
	const init = await gitInit(params.vaultRoot, { spawn: spawnFn });
	if (!init.ok) {
		return fail(init.error);
	}
	const add = await gitAdd(params.vaultRoot, ["."], { spawn: spawnFn });
	if (!add.ok) {
		return fail(add.error);
	}
	const commit = await gitCommit(params.vaultRoot, COMMIT_SUBJECT, {
		spawn: spawnFn,
	});
	if (!commit.ok) {
		return fail(commit.error);
	}
	return ok({
		vaultRoot: params.vaultRoot,
		seedDir,
		commit: commit.value.sha,
	});
};
