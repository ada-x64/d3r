import { constants } from "node:fs";
import { access as fsAccess, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withResourceDeadline } from "./resource-io.ts";
import {
	checkedWorkspaceRoot,
	isMissing,
	ResourceAccessError,
	workspacePath,
	type WorkspaceAccess,
} from "./resource-paths.ts";

/** Probe only the pinned path; failed trust checks never become initialization advice. */
const probeVault = async (
	vaultRoot: string,
	access: WorkspaceAccess,
): Promise<"missing" | "available"> => {
	const path = await workspacePath(vaultRoot, access, true);
	const before = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	});
	access.signal.throwIfAborted();
	if (!before) {
		return "missing";
	}
	if (before.isSymbolicLink() || !before.isDirectory()) {
		throw new ResourceAccessError("Pinned vault is not a regular directory");
	}
	// Once observed, disappearance or replacement is unavailability, not absence.
	await fsAccess(path, constants.R_OK | constants.X_OK);
	const after = await checkedWorkspaceRoot(path, access.signal);
	if (before.dev !== after.dev || before.ino !== after.ino) {
		throw new ResourceAccessError("Pinned vault directory identity changed");
	}
	return "available";
};

/** Refresh read-only vault guidance for each router turn without discovery or mutation. */
export const nativeVaultContext = async (
	vaultRoot: string,
	access: WorkspaceAccess,
): Promise<string> => {
	const status = await withResourceDeadline(access, (signal) =>
		probeVault(vaultRoot, { ...access, signal }),
	).catch(() => {
		access.signal.throwIfAborted();
		return "unavailable" as const;
	});
	access.signal.throwIfAborted();
	const heading = `Native vault status: ${status}.\nPinned vault root: ${JSON.stringify(vaultRoot)}.`;
	if (status === "available") {
		return `${heading}\nThe existing pinned vault is available. Use the native vault tools for vault documents; keep using this pinned root.`;
	}
	if (status === "unavailable") {
		return `${heading}\nThe pinned vault could not be safely accessed. Inspect permissions, path type, symlinks, and workspace access restrictions. Do not initialize, overwrite, or repoint it. Inline no-document audits and code work without vault artifacts are still allowed.`;
	}
	const command = JSON.stringify({
		command: process.execPath,
		args: [
			fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
			"vault",
			"init",
			"--vault-root",
			vaultRoot,
		],
		cwd: access.cwd,
	});
	return [
		heading,
		"The pinned vault does not exist. Ask the operator whether to run d3r vault init for this exact pinned root, unless they have already declined or requested no vault artifacts.",
		`With user direction, use run_command with these literal arguments (not a shell command): ${command}`,
		"This invokes the installed D3R CLI through the current runtime and an absolute script path, without assuming d3r is on PATH.",
		"This command creates seeded templates and directories plus a separate Git repository and initial commit; it performs no pushes.",
		"Initialization requires explicit user direction and normal command approval. Do not auto-initialize, run mkdir, or use vault_write to create a partial vault structure.",
		"If the user declines or requests no vault artifacts, continue inline no-document audits and code work without a vault; do not repeatedly ask. Only revisit initialization if the user changes that direction.",
		"After user-approved initialization succeeds, recheck with vault_ls before any document phases within this turn. The next router turn refreshes this status. Never discover or switch to another vault.",
	].join("\n");
};
