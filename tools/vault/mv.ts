// vault_mv: rename or move a file within the vault. Both paths run
// through the traversal guard. Refuses to clobber an existing target
// unless `overwrite` is true.

import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Result } from "../common/result.ts";
// oxlint-disable-next-line no-duplicate-imports
import { error } from "../common/result.ts";
import type { VaultAccessor, VaultPathError } from "../common/vault-root.ts";
import { acceptRoot } from "./_lib.ts";

export const VaultMvParams = z.object({
	from: z.string(),
	to: z.string(),
	overwrite: z.boolean().default(false),
});
export type VaultMvParams = z.infer<typeof VaultMvParams>;

export interface VaultMvResult {
	from: string;
	to: string;
}

export type VaultMvError =
	| VaultPathError
	| { kind: "exists"; path: string }
	| { kind: "missing"; path: string };

const exists = async (p: string): Promise<boolean> => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};

export const vaultMv = async (
	params: VaultMvParams,
	accessor: VaultAccessor,
): Promise<Result<VaultMvResult, VaultMvError>> => {
	const fromRes = await acceptRoot(accessor, params.from);
	if (!fromRes.ok) {
		return fromRes;
	}
	const toRes = await acceptRoot(accessor, params.to);
	if (!toRes.ok) {
		return toRes;
	}
	if (!(await exists(fromRes.value))) {
		return error({ kind: "missing", path: params.from });
	}
	if (!params.overwrite && (await exists(toRes.value))) {
		return error({ kind: "exists", path: params.to });
	}
	await mkdir(path.dirname(toRes.value), { recursive: true });
	await rename(fromRes.value, toRes.value);
	return { ok: true, value: { from: params.from, to: params.to } };
};
