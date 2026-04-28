// Private helpers shared by the vault tool family. Path resolution
// always goes through `acceptRoot` so the traversal guard runs before
// any I/O. `walkVault` is the in-package recursive directory walker;
// we deliberately avoid pulling in fast-glob/picomatch and stick to
// `node:fs/promises` to keep the dep surface flat.

import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Result } from "../common/result.ts";
import type { VaultAccessor, VaultPathError } from "../common/vault-root.ts";
// oxlint-disable-next-line no-duplicate-imports
import { resolveUnderRoot } from "../common/vault-root.ts";
import { stringifyFm } from "../fm/_lib.ts";

export const acceptRoot = async (
	accessor: VaultAccessor,
	relPath: string,
): Promise<Result<string, VaultPathError>> => {
	const root =
		"vaultRoot" in accessor
			? accessor.vaultRoot
			: await accessor.resolver.resolve();
	return resolveUnderRoot(root, relPath);
};

export const resolveRoot = async (accessor: VaultAccessor): Promise<string> =>
	"vaultRoot" in accessor ? accessor.vaultRoot : accessor.resolver.resolve();

export interface AssembleDocArgs {
	frontmatter?: Record<string, unknown>;
	body: string;
}

// v1 is body+frontmatter assembly only. Per-kind template-merging is
// deferred until a concrete VaultResolver lands; callers that need
// template defaults can read+merge themselves and pass the merged
// frontmatter in.
export const assembleDoc = (args: AssembleDocArgs): string =>
	stringifyFm(args.frontmatter ?? {}, args.body);

export interface WalkOptions {
	excludeDirs?: ReadonlySet<string>;
	includeDotfiles?: boolean;
}

const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

// Yields vault-relative POSIX-style paths for every regular file under
// `root`, skipping excluded dirs and (by default) dotfiles. Symlinks
// are not followed.
export const walkVault = async (
	root: string,
	opts: WalkOptions = {},
): Promise<string[]> => {
	const excludes = opts.excludeDirs ?? DEFAULT_EXCLUDES;
	const includeDotfiles = opts.includeDotfiles ?? false;
	const entries = await readdir(root, {
		recursive: true,
		withFileTypes: true,
	});
	const rels = entries.flatMap((entry) => {
		if (!entry.isFile()) {
			return [];
		}
		const parentDir = entry.parentPath ?? entry.path;
		const abs = path.join(parentDir, entry.name);
		const rel = path.relative(root, abs);
		if (rel === "" || rel.startsWith("..")) {
			return [];
		}
		const segments = rel.split(path.sep);
		if (segments.some((seg) => excludes.has(seg))) {
			return [];
		}
		const hidden =
			!includeDotfiles &&
			segments.some((seg) => seg.startsWith(".") && seg !== ".");
		if (hidden) {
			return [];
		}
		return [segments.join("/")];
	});
	return rels;
};
