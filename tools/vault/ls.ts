// vault_ls: list the immediate children of a vault-relative directory.
// Defaults to the vault root when no path is given.

import { readdir } from "node:fs/promises";
import { z } from "zod";

import { type Result } from "@d3r/core/result";
import {
	type VaultAccessor,
	type VaultPathError,
} from "../common/vault-root.ts";
import { acceptRoot } from "./_lib.ts";

export const VaultLsParams = z.object({
	path: z.string().default("."),
});
export type VaultLsParams = z.infer<typeof VaultLsParams>;

export interface VaultLsEntry {
	name: string;
	kind: "file" | "dir";
}

export interface VaultLsResult {
	path: string;
	entries: VaultLsEntry[];
}

export const vaultLs = async (
	params: VaultLsParams,
	accessor: VaultAccessor,
): Promise<Result<VaultLsResult, VaultPathError>> => {
	const resolved = await acceptRoot(accessor, params.path);
	if (!resolved.ok) {
		return resolved;
	}
	const dirents = await readdir(resolved.value, { withFileTypes: true });
	const entries: VaultLsEntry[] = dirents.map((d) => ({
		name: d.name,
		kind: d.isDirectory() ? "dir" : "file",
	}));
	return { ok: true, value: { path: params.path, entries } };
};
