// vault_find: scan the resolved vault and filter by any combination of
// glob, body substring, and frontmatter `kind:`. All filters are
// optional; with no filters the full file list is returned. Glob
// matching uses a small in-package translator (`*` and `**` only) to
// avoid pulling in picomatch/minimatch.

import { z } from "zod";

import { type Result } from "../common/result.ts";
import {
	type VaultAccessor,
	type VaultPathError,
} from "../common/vault-root.ts";
import { resolveRoot, walkVault, walkVaultDocs } from "./_lib.ts";

export const VaultFindParams = z.object({
	glob: z.string().optional(),
	query: z.string().optional(),
	kind: z.string().optional(),
});
export type VaultFindParams = z.infer<typeof VaultFindParams>;

export interface VaultFindMatch {
	path: string;
	kind?: string;
	matchedGlob?: boolean;
	matchedQuery?: boolean;
}

export interface VaultFindResult {
	matches: VaultFindMatch[];
}

const escapeRegex = (s: string): string =>
	s.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);

const GLOBSTAR_LEN = 2;

const compileGlob = (glob: string): RegExp => {
	let out = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			out += ".*";
			i += GLOBSTAR_LEN;
			if (glob[i] === "/") {
				i += 1;
			}
		} else if (c === "*") {
			out += "[^/]*";
			i += 1;
		} else if (c === "?") {
			out += "[^/]";
			i += 1;
		} else {
			out += escapeRegex(c);
			i += 1;
		}
	}
	return new RegExp(`^${out}$`);
};

export const vaultFind = async (
	params: VaultFindParams,
	accessor: VaultAccessor,
): Promise<Result<VaultFindResult, VaultPathError>> => {
	const root = await resolveRoot(accessor);
	const globRe = params.glob ? compileGlob(params.glob) : null;

	const needsBody = params.query !== undefined || params.kind !== undefined;
	if (!needsBody) {
		const files = await walkVault(root);
		const candidates = globRe ? files.filter((p) => globRe.test(p)) : files;
		const matches = candidates.map((rel) => ({
			path: rel,
			...(globRe ? { matchedGlob: true } : {}),
		}));
		return { ok: true, value: { matches } };
	}
	const rows = await walkVaultDocs(root, { includeNonMarkdown: true });
	const matches = rows.flatMap<VaultFindMatch>((row) => {
		if (globRe && !globRe.test(row.rel)) {
			return [];
		}
		const kindValue = row.frontmatter?.kind;
		const kind = typeof kindValue === "string" ? kindValue : undefined;
		const kindOk = params.kind === undefined ? true : kind === params.kind;
		const matchedQuery =
			params.query === undefined ? undefined : row.body.includes(params.query);
		const queryOk = params.query === undefined ? true : matchedQuery === true;
		if (!kindOk || !queryOk) {
			return [];
		}
		return [
			{
				path: row.rel,
				...(kind === undefined ? {} : { kind }),
				...(globRe ? { matchedGlob: true } : {}),
				...(matchedQuery === undefined ? {} : { matchedQuery }),
			},
		];
	});
	return { ok: true, value: { matches } };
};
