// vault_write: single discriminated-union router. The `doc` arm
// assembles frontmatter + body via the shared helper before writing;
// the `raw` arm writes bytes verbatim. Both arms share path
// resolution and the traversal guard.
//
// The doc arm intentionally does not consult per-kind templates yet -
// template-merging waits for the concrete VaultResolver to settle the
// vault/templates layout. Callers that need defaults can merge into
// `frontmatter` themselves.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Result } from "../common/result.ts";
import type { VaultAccessor, VaultPathError } from "../common/vault-root.ts";
import { acceptRoot, assembleDoc } from "./_lib.ts";

const DocArm = z.object({
	mode: z.literal("doc"),
	kind: z.string(),
	path: z.string(),
	frontmatter: z.record(z.string(), z.unknown()).optional(),
	body: z.string(),
});

const RawArm = z.object({
	mode: z.literal("raw"),
	path: z.string(),
	contents: z.string(),
});

export const VaultWriteParams = z.discriminatedUnion("mode", [DocArm, RawArm]);
export type VaultWriteParams = z.infer<typeof VaultWriteParams>;

export interface VaultWriteResult {
	mode: "doc" | "raw";
	path: string;
	bytes: number;
}

export const vaultWrite = async (
	params: VaultWriteParams,
	accessor: VaultAccessor,
): Promise<Result<VaultWriteResult, VaultPathError>> => {
	const resolved = await acceptRoot(accessor, params.path);
	if (!resolved.ok) {
		return resolved;
	}
	const text =
		params.mode === "doc"
			? assembleDoc({
					frontmatter: { ...params.frontmatter, kind: params.kind },
					body: params.body,
				})
			: params.contents;
	await mkdir(path.dirname(resolved.value), { recursive: true });
	await writeFile(resolved.value, text, "utf8");
	return {
		ok: true,
		value: {
			mode: params.mode,
			path: params.path,
			bytes: Buffer.byteLength(text, "utf8"),
		},
	};
};
