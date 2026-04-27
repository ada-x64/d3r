// vault_read: read a single file as UTF-8 text, or list immediate
// children when the resolved path is a directory. Path is interpreted
// relative to the vault root and runs through the traversal guard.

import { readFile, readdir, stat } from "node:fs/promises";
import { z } from "zod";

import type {
	Result,
	VaultAccessor,
	VaultPathError,
} from "../common/vault-root.ts";
import { acceptRoot } from "./_lib.ts";

export const VaultReadParams = z.object({
	path: z.string(),
});
export type VaultReadParams = z.infer<typeof VaultReadParams>;

export type VaultReadResult =
	| { kind: "file"; path: string; text: string }
	| {
			kind: "dir";
			path: string;
			entries: { name: string; kind: "file" | "dir" }[];
	  };

export const vaultRead = async (
	params: VaultReadParams,
	accessor: VaultAccessor,
): Promise<Result<VaultReadResult, VaultPathError>> => {
	const resolved = await acceptRoot(accessor, params.path);
	if (!resolved.ok) {
		return resolved;
	}
	const abs = resolved.value;
	const info = await stat(abs);
	if (info.isDirectory()) {
		const dirents = await readdir(abs, { withFileTypes: true });
		const entries = dirents.map((d) => ({
			name: d.name,
			kind: d.isDirectory() ? ("dir" as const) : ("file" as const),
		}));
		return { ok: true, value: { kind: "dir", path: params.path, entries } };
	}
	const text = await readFile(abs, "utf8");
	return { ok: true, value: { kind: "file", path: params.path, text } };
};
