// vault_rm: remove a file (or, with `recursive: true`, a directory)
// from the vault. Refuses to descend into a directory unless the
// caller opts in explicitly.

import { rm } from "node:fs/promises";
import { z } from "zod";

import { fail, type Result } from "@d3r/core/result";
import {
	type VaultAccessor,
	type VaultPathError,
} from "../common/vault-root.ts";
import { acceptRoot, safeStat } from "./_lib.ts";

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
		return fail({ kind: "missing", path: params.path });
	}
	if (info.isDirectory() && !params.recursive) {
		return fail({ kind: "is-directory", path: params.path });
	}
	await rm(resolved.value, { recursive: params.recursive, force: false });
	return { ok: true, value: { removed: params.path } };
};
