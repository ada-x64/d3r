// Path-resolution substrate for vault-aware tools.
//
// Every tool that touches the filesystem under a vault root MUST run
// caller-supplied paths through `resolveUnderRoot` first. The guard
// returns a structured `Result.error` on traversal or bad-root rather
// than throwing, so tool entry points can propagate the refusal back to
// the harness without unwinding.

import path from "node:path";
import type { Result } from "./result.ts";
// oxlint-disable-next-line no-duplicate-imports
import { error, ok } from "./result.ts";

export type { Result };

// Implementations are owned by harness adapters or higher-level
// orchestration. The tools package only consumes the interface so the
// vault location stays a runtime concern.
export interface VaultResolver {
	resolve: () => Promise<string>;
}

export interface VaultPathError {
	kind: "traversal" | "not-absolute-root";
	root: string;
	requested: string;
	resolved: string;
}

export const resolveUnderRoot = (
	root: string,
	relPath: string,
): Result<string, VaultPathError> => {
	if (!path.isAbsolute(root)) {
		return error({
			kind: "not-absolute-root",
			root,
			requested: relPath,
			resolved: "",
		});
	}
	const resolved = path.resolve(root, relPath);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(rootWithSep)) {
		return error({ kind: "traversal", root, requested: relPath, resolved });
	}
	return ok(resolved);
};

// Discriminated accessor accepted by vault tools. Callers either pass an
// already-known absolute root or a deferred `VaultResolver` that the
// harness wires up. `acceptVaultPath` collapses the two and applies the
// traversal guard in a single hop.
export type VaultAccessor = { vaultRoot: string } | { resolver: VaultResolver };

export const acceptVaultPath = async (
	accessor: VaultAccessor,
	relPath: string,
): Promise<Result<string, VaultPathError>> => {
	const root =
		"vaultRoot" in accessor
			? accessor.vaultRoot
			: await accessor.resolver.resolve();
	return resolveUnderRoot(root, relPath);
};

export const resolveAccessorRoot = async (
	accessor: VaultAccessor,
): Promise<string> =>
	"vaultRoot" in accessor ? accessor.vaultRoot : accessor.resolver.resolve();
