// vault_rm: remove a file (or, with `recursive: true`, a directory)
// from the vault. Refuses to descend into a directory unless the
// caller opts in explicitly.

import { rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { z } from "zod";

import type { Result } from "../common/result.ts";
// oxlint-disable-next-line no-duplicate-imports
import { error } from "../common/result.ts";
import type { VaultAccessor, VaultPathError } from "../common/vault-root.ts";
import { acceptRoot } from "./_lib.ts";

export const VaultRmParams = z.object({
	path: z.string(),
	recursive: z.boolean().default(false),
});
export type VaultRmParams = z.infer<typeof VaultRmParams>;

export interface VaultRmResult {
	removed: string;
}

export type VaultRmError =
	| VaultPathError
	| { kind: "is-directory"; path: string }
	| { kind: "missing"; path: string };

const safeStat = async (p: string): Promise<Stats | null> => {
	try {
		return await stat(p);
	} catch {
		return null;
	}
};

export const vaultRm = async (
	params: VaultRmParams,
	accessor: VaultAccessor,
): Promise<Result<VaultRmResult, VaultRmError>> => {
	const resolved = await acceptRoot(accessor, params.path);
	if (!resolved.ok) {
		return resolved;
	}
	const info = await safeStat(resolved.value);
	if (info === null) {
		return error({ kind: "missing", path: params.path });
	}
	if (info.isDirectory() && !params.recursive) {
		return error({ kind: "is-directory", path: params.path });
	}
	await rm(resolved.value, { recursive: params.recursive, force: false });
	return { ok: true, value: { removed: params.path } };
};
