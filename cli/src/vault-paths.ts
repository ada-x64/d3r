/* oxlint-disable no-await-in-loop, no-continue -- Checked ancestors and bounded traversal are intentionally sequential. */
import { createHash } from "node:crypto";
import { lstat, mkdir, opendir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { type RuntimeToolResult } from "@d3r/core/runtime";
import { z } from "zod";
import {
	isMissing,
	isSensitivePath,
	readDiskText,
	ResourceAccessError,
	workspacePath,
	type WorkspaceAccess,
} from "./resource-paths.ts";

/** Fixed budgets apply to discovery, explicit paths, and model-visible output. */
export const VAULT_LIMITS = {
	entries: 5000,
	files: 2000,
	depth: 20,
	path: 1024,
	results: 200,
	bytes: 8_388_608,
	output: 65_536,
	preview: 8192,
	pageCodePoints: 8192,
	glob: 256,
	directoryMode: 0o700,
};

/** Model paths use portable vault-relative names, never roots or filesystem aliases. */
export const vaultPathSchema = z
	.string()
	.min(1)
	.max(VAULT_LIMITS.path)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.includes("\0") &&
			!/[\\:*?<>|]/.test(value) &&
			value.split("/").length <= VAULT_LIMITS.depth &&
			value
				.split("/")
				.every(
					(part) =>
						part === "." ||
						(part !== ".." &&
							!/[ .]$/.test(part) &&
							!/^\.d3r-/i.test(part) &&
							!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
				),
		"Use a '/'-separated relative path within the vault; absolute, drive, UNC, traversal and ambiguous paths are denied",
	);

/** Snapshots are explicit preimages, shared with the native workspace write tools. */
export const vaultSnapshotSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Hash the complete text, not its truncated model preview. */
export const vaultSnapshot = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** Text-only discovery results never ask an editor to open every match. */
export const vaultResult = (value: unknown): RuntimeToolResult => {
	const text = JSON.stringify(value);
	return { text, content: [{ type: "text", text }] };
};

/** Leave room for JSON escaping, metadata, and the complete snapshot token. */
export const vaultPreview = (text: string): string =>
	Buffer.from(text).subarray(0, VAULT_LIMITS.preview).toString("utf8");

/** Slice bounded, validated text by Unicode code points, never splitting UTF-8 or surrogate pairs. */
export const vaultTextPage = (text: string, offset: number, limit: number) => {
	const points = [...text];
	if (offset > points.length) {
		throw new ResourceAccessError(
			"Read offset exceeds the file's Unicode code point length",
		);
	}
	const end = Math.min(offset + limit, points.length);
	const truncated = end < points.length;
	return {
		text: points.slice(offset, end).join(""),
		offset,
		limit,
		truncated,
		...(truncated ? { nextOffset: end } : {}),
	};
};

/** Responses use '/'-separated relative paths that can be passed directly to another vault tool. */
export const vaultRelative = (path: string, access: WorkspaceAccess): string =>
	relative(access.cwd, path).split(sep).join("/") || ".";

/** Internal staging and lock files are not part of the document store. */
const privatePath = (path: string): boolean =>
	isSensitivePath(path) ||
	path.split(/[\\/]/).some((part) => /^\.d3r-/i.test(part));

/** Enforce lexical policy before the shared canonical-root and inode checks. */
export const checkedVaultPath = async (
	path: string,
	access: WorkspaceAccess,
	missing = false,
): Promise<string> => {
	const input = vaultPathSchema.parse(path);
	const absolute = join(access.cwd, input);
	if (privatePath(absolute)) {
		throw new ResourceAccessError(`Sensitive vault path denied: ${input}`);
	}
	return workspacePath(absolute, access, missing);
};

/** Read only bounded disk text; never consult negotiated editor buffers. */
export const readVaultText = async (
	path: string,
	access: WorkspaceAccess,
): Promise<string> => {
	await workspacePath(path, access);
	const text = await readDiskText(path, access.signal);
	await workspacePath(path, access);
	return text;
};

/** Bounded directory rows contain only validated regular files or directories. */
export interface VaultEntry {
	path: string;
	kind: "file" | "dir";
}

/** Lists and scans include .misc, but never descend through sensitive paths or links. */
export const vaultEntries = async (
	path: string,
	access: WorkspaceAccess,
	recursive = false,
): Promise<{ entries: VaultEntry[]; truncated: boolean; skipped: number }> => {
	const entries: VaultEntry[] = [];
	let seen = 0;
	let skipped = 0;
	let truncated = false;
	const visit = async (directory: string, depth: number): Promise<void> => {
		await workspacePath(directory, access);
		const handle = await opendir(directory);
		for await (const entry of handle) {
			access.signal.throwIfAborted();
			if (
				++seen > VAULT_LIMITS.entries ||
				entries.length >= VAULT_LIMITS.files
			) {
				truncated = true;
				break;
			}
			const next = join(directory, entry.name);
			if (
				entry.isSymbolicLink() ||
				privatePath(next) ||
				(!entry.isDirectory() && !entry.isFile())
			) {
				skipped++;
				continue;
			}
			try {
				const rel = vaultRelative(next, access);
				await checkedVaultPath(rel, access);
				const info = await lstat(next);
				if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
					throw new ResourceAccessError("Directory entry changed");
				}
				entries.push({ path: rel, kind: info.isDirectory() ? "dir" : "file" });
				if (recursive && info.isDirectory()) {
					if (depth >= VAULT_LIMITS.depth) {
						truncated = true;
					} else {
						await visit(next, depth + 1);
					}
				}
			} catch (error) {
				if (
					!(error instanceof ResourceAccessError) &&
					!(error instanceof z.ZodError) &&
					!isMissing(error)
				) {
					throw error;
				}
				skipped++;
			}
		}
		await workspacePath(directory, access);
	};
	await visit(path, 1);
	return {
		entries: entries.toSorted((a, b) => a.path.localeCompare(b.path)),
		truncated,
		skipped,
	};
};

/** Trim whole rows rather than returning invalid, sliced JSON. */
export const boundedVaultRows = <T>(
	rows: readonly T[],
): { rows: T[]; truncated: boolean } => {
	const result: T[] = [];
	let bytes = 0;
	for (const row of rows) {
		bytes += Buffer.byteLength(JSON.stringify(row));
		if (
			result.length >= VAULT_LIMITS.results ||
			bytes > VAULT_LIMITS.output - VAULT_LIMITS.preview
		) {
			break;
		}
		result.push(row);
	}
	return { rows: result, truncated: result.length < rows.length };
};

/** Only creation can lack a preimage; reject stale requests before mkdir or lock effects. */
export const vaultPreimage = async (
	path: string,
	snapshot: string | undefined,
	access: WorkspaceAccess,
): Promise<string | null> => {
	const text = await readVaultText(path, access).catch((error: unknown) => {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	});
	if (
		text === null ? snapshot !== undefined : snapshot !== vaultSnapshot(text)
	) {
		throw new Error(
			"Stale or missing snapshot: pass the explicit snapshot from vault_read",
		);
	}
	return text;
};

/** Create ancestors one at a time after approval/preimage checks, never the pinned root. */
export const vaultParents = async (
	path: string,
	access: WorkspaceAccess,
): Promise<void> => {
	await workspacePath(access.cwd, access);
	const parts = relative(access.cwd, dirname(path)).split(sep).filter(Boolean);
	let cursor = access.cwd;
	for (const part of parts) {
		await workspacePath(cursor, access);
		cursor = join(cursor, part);
		await workspacePath(cursor, access, true);
		access.signal.throwIfAborted();
		try {
			await mkdir(cursor, { mode: VAULT_LIMITS.directoryMode });
		} catch (error) {
			if (
				!(
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "EEXIST"
				)
			) {
				throw error;
			}
		}
		await workspacePath(cursor, access);
		const info = await lstat(cursor);
		if (!info.isDirectory()) {
			throw new ResourceAccessError("Vault parent must be a directory");
		}
	}
};
