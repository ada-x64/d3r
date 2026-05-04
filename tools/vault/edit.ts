// vault_edit: literal find/replace inside a vault file. Asserts the
// `find` string occurs exactly `count` times before substituting; on
// mismatch returns a structured refusal rather than partially editing
// or throwing.

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

import { error, type Result } from "../common/result.ts";
import {
	type VaultAccessor,
	type VaultPathError,
} from "../common/vault-root.ts";
import { acceptRoot } from "./_lib.ts";

export const VaultEditParams = z.object({
	path: z.string(),
	find: z.string().min(1),
	replace: z.string(),
	count: z.number().int().positive().default(1),
});
export type VaultEditParams = z.infer<typeof VaultEditParams>;

export interface VaultEditResult {
	path: string;
	replacements: number;
}

export type VaultEditError =
	| VaultPathError
	| { kind: "count-mismatch"; expected: number; actual: number };

const countOccurrences = (haystack: string, needle: string): number => {
	let count = 0;
	let from = 0;
	while (from <= haystack.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) {
			break;
		}
		count += 1;
		from = idx + needle.length;
	}
	return count;
};

export const vaultEdit = async (
	params: VaultEditParams,
	accessor: VaultAccessor,
): Promise<Result<VaultEditResult, VaultEditError>> => {
	const resolved = await acceptRoot(accessor, params.path);
	if (!resolved.ok) {
		return resolved;
	}
	const text = await readFile(resolved.value, "utf8");
	const actual = countOccurrences(text, params.find);
	if (actual !== params.count) {
		return error({ kind: "count-mismatch", expected: params.count, actual });
	}
	const out = text.replaceAll(params.find, params.replace);
	await writeFile(resolved.value, out, "utf8");
	return { ok: true, value: { path: params.path, replacements: actual } };
};
