// Seed-tree resolution helpers. Pure path arithmetic + a single
// stat probe; the actual recursive copy happens in `init.ts` and
// the per-path classifier (a follow-up concern) will live next to
// the verb that needs it. Keeping these helpers in their own
// module lets sibling verbs reuse them without depending on the
// init verb's full surface.
//
// `Result<T, E>` lives in `core/result.ts` (canonical home,
// shared with the tools package). Re-exported here for the
// convenience of sibling vault modules that already import
// `assertSeedExists` / `defaultSeedDir` and would otherwise need
// a second import line.

import { stat } from "node:fs/promises";

import { fail, ok, type Result } from "../result.ts";
import { SEED_ROOT } from "./seed-root.ts";

export { fail, ok, type Result };

/**
 * Absolute path to the canonical seed tree. In the source tier
 * this resolves to `core/seed/`; once the package is built and the
 * postbuild copy has run, the compiled `core/dist/vault/seed.js`
 * resolves to `core/dist/seed/`. The function is pure — it does
 * not read the directory.
 */
export const defaultSeedDir = (): string => SEED_ROOT;

export interface SeedError {
	kind: "seed-missing";
	path: string;
}

/**
 * Probe that the seed directory exists. Returns `ok` on any
 * successful stat — callers do not care whether the entry is a
 * directory at this level (`fs.cp` will fail later if it is not,
 * and the `seed-missing` error stays reserved for the genuine
 * ENOENT case).
 */
export const assertSeedExists = async (
	seedDir: string,
): Promise<Result<void, SeedError>> => {
	try {
		await stat(seedDir);
		return ok(undefined);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return fail({ kind: "seed-missing", path: seedDir });
		}
		throw error;
	}
};
