// Path-resolution substrate for vault-aware tools.
//
// Every tool that touches the filesystem under a vault root MUST run
// caller-supplied paths through `resolveUnderRoot` first. The guard
// returns a structured `Result.error` on traversal or bad-root rather
// than throwing, so tool entry points can propagate the refusal back to
// the harness without unwinding.

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Result } from "./result.ts";
// oxlint-disable-next-line no-duplicate-imports
import { error, ok } from "./result.ts";

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

// Walks up to the nearest existing ancestor of `target`, realpaths
// it, and re-attaches the not-yet-existing tail. Recursive so the
// per-level await is not flagged as a sequential loop; the depth is
// bounded by the path length.
const realpathOrAncestor = async (
	target: string,
	tail: string,
): Promise<string> => {
	try {
		const real = await realpath(target);
		return tail === "" ? real : path.join(real, tail);
	} catch {
		const parent = path.dirname(target);
		if (parent === target) {
			throw new Error("no existing ancestor");
		}
		const nextTail =
			tail === "" ? path.basename(target) : `${path.basename(target)}/${tail}`;
		return realpathOrAncestor(parent, nextTail);
	}
};

// Two-stage guard. The lexical stage cheaply rejects `..`-style
// escapes against the supplied (possibly symlinked) root. The
// realpath stage then re-checks the resolved path against the
// realpath'd root so that symlinks living *inside* the vault but
// pointing outside it are caught before any I/O dereferences them.
// The resolved path may not yet exist (vault_write creating a new
// file); in that case we walk up to the nearest existing ancestor,
// realpath that, and re-attach the not-yet-existing tail. Tail
// components by definition do not exist and so cannot themselves be
// symlinks at the time of the check.
export const resolveUnderRoot = async (
	root: string,
	relPath: string,
): Promise<Result<string, VaultPathError>> => {
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
	const traversal = (): Result<string, VaultPathError> =>
		error({ kind: "traversal", root, requested: relPath, resolved });
	try {
		const realRoot = await realpath(root);
		const realRootSep = realRoot.endsWith(path.sep)
			? realRoot
			: realRoot + path.sep;
		const realResolved = await realpathOrAncestor(resolved, "");
		if (realResolved !== realRoot && !realResolved.startsWith(realRootSep)) {
			return traversal();
		}
		return ok(resolved);
	} catch {
		return traversal();
	}
};

// Discriminated accessor accepted by vault tools. Callers either pass
// an already-known absolute root or a deferred `VaultResolver` that
// the harness wires up. Vault tools collapse the two and apply the
// traversal guard via `acceptRoot` in `vault/_lib.ts`.
export type VaultAccessor = { vaultRoot: string } | { resolver: VaultResolver };
