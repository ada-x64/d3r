/* oxlint-disable no-await-in-loop -- Nearest-first ancestry checks must not skip a hostile candidate. */
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { resourceAncestors } from "./resource-ancestors.ts";
import { withResourceDeadline } from "./resource-io.ts";
import {
	checkedWorkspaceRoot,
	isMissing,
	isSensitivePath,
	ResourceAccessError,
} from "./resource-paths.ts";

/** Candidates are exact lexical ancestors, never aliases, siblings, or descendants. */
const vaultAncestors = (cwd: string): string[] => {
	if (!isAbsolute(cwd) || cwd.includes("\0") || resolve(cwd) !== cwd) {
		throw new ResourceAccessError(
			"Vault discovery requires a canonical workspace path",
		);
	}
	return resourceAncestors(
		cwd,
		new ResourceAccessError("Vault discovery ancestry limit exceeded"),
	);
};

/** Structural checkpoint validation grants no access and performs no filesystem IO. */
export const isAncestorVaultRoot = (cwd: string, vaultRoot: string): boolean =>
	!isSensitivePath(vaultRoot) &&
	vaultAncestors(cwd).some(
		(root) => join(root, ".agents", "vault") === vaultRoot,
	);

/** Inspect only vault containers; inaccessible or substituted directories are not absence. */
const vaultDirectory = async (
	path: string,
	signal: AbortSignal,
): Promise<boolean> => {
	signal.throwIfAborted();
	const before = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	});
	if (!before) {
		return false;
	}
	// Once observed, disappearance or any other validation failure must not select a farther vault.
	await checkedWorkspaceRoot(path, signal);
	if (isSensitivePath(path)) {
		throw new ResourceAccessError(`Sensitive vault path denied: ${path}`);
	}
	await access(path, constants.R_OK | constants.X_OK);
	const after = await checkedWorkspaceRoot(path, signal);
	if (before.dev !== after.dev || before.ino !== after.ino) {
		throw new ResourceAccessError(`Vault directory identity changed: ${path}`);
	}
	return true;
};

/** Discover only the nearest actual vault; an absent vault remains an uncreated cwd candidate. */
export const discoverVaultRoot = (
	cwd: string,
	options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<string> =>
	withResourceDeadline(
		{ ...options, signal: options.signal ?? new AbortController().signal },
		async (signal) => {
			for (const root of vaultAncestors(cwd)) {
				signal.throwIfAborted();
				await checkedWorkspaceRoot(root, signal);
				const agents = join(root, ".agents");
				const vault = join(agents, "vault");
				if (
					(await vaultDirectory(agents, signal)) &&
					(await vaultDirectory(vault, signal))
				) {
					return vault;
				}
			}
			return join(cwd, ".agents", "vault");
		},
	);
