/* oxlint-disable no-await-in-loop, no-continue -- One sequential scan owns the aggregate disk budget. */
import { join } from "node:path";
import {
	lintRow,
	type VaultFindMatch,
	type VaultFindParams,
	type VaultLintFinding,
} from "@d3r/tools";
import { type RuntimeToolResult } from "@d3r/core/runtime";
import { z } from "zod";
import {
	parseVaultFrontmatter,
	VaultFrontmatterError,
} from "./vault-frontmatter.ts";
import {
	isSensitivePath,
	MAX_TEXT_BYTES,
	ResourceAccessError,
	type WorkspaceAccess,
} from "./resource-paths.ts";
import {
	boundedVaultRows,
	checkedVaultPath,
	readVaultText,
	VAULT_LIMITS,
	vaultEntries,
	vaultPreview,
	vaultRelative,
	vaultResult,
} from "./vault-paths.ts";

/** Match the legacy *, **[/], ? vocabulary without regex backtracking on model input. */
export const vaultGlob = (glob: string, path: string): boolean => {
	const tokens = glob.match(/\*\*\/?|\*|\?|[^*?]/g) ?? [];
	let previous = new Uint8Array(path.length + 1);
	previous[0] = 1;
	for (const token of tokens) {
		const current = new Uint8Array(path.length + 1);
		const star = token.startsWith("*");
		current[0] = star ? previous[0] : 0;
		for (let index = 1; index <= path.length; index++) {
			const accepts =
				token.startsWith("**") ||
				(token === "*" || token === "?"
					? path[index - 1] !== "/"
					: path[index - 1] === token);
			current[index] = star
				? Number(Boolean(previous[index] || (accepts && current[index - 1])))
				: Number(Boolean(accepts && previous[index - 1]));
		}
		previous = current;
	}
	return previous[path.length] === 1;
};

/** Glob syntax stays relative even though wildcards are permitted in this field. */
export const vaultGlobSchema = z
	.string()
	.max(VAULT_LIMITS.glob)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.includes("\0") &&
			!/[\\:]/.test(value) &&
			!value.split("/").includes("..") &&
			!isSensitivePath(value) &&
			!value.split("/").some((part) => part.startsWith(".d3r-")),
		"Glob must be vault-relative, without drive, UNC or traversal components",
	);

/** Find matches retain the existing body-only, case-sensitive substring/kind semantics. */
// oxlint-disable-next-line max-statements -- Keep scan accounting and filter decisions together.
export const findVault = async (
	input: VaultFindParams,
	access: WorkspaceAccess,
): Promise<RuntimeToolResult> => {
	const root = await checkedVaultPath(".", access);
	const walk = await vaultEntries(root, access, true);
	const matches: VaultFindMatch[] = [];
	let bytes = 0;
	let { truncated, skipped } = walk;
	for (const entry of walk.entries) {
		access.signal.throwIfAborted();
		if (
			entry.kind !== "file" ||
			(input.glob && !vaultGlob(input.glob, entry.path))
		) {
			continue;
		}
		if (matches.length >= VAULT_LIMITS.results || bytes >= VAULT_LIMITS.bytes) {
			truncated = true;
			break;
		}
		let kind: string | undefined = undefined;
		if (input.query !== undefined || input.kind !== undefined) {
			try {
				const raw = await readVaultText(join(access.cwd, entry.path), access);
				bytes += Buffer.byteLength(raw);
				if (bytes > VAULT_LIMITS.bytes) {
					truncated = true;
					break;
				}
				const doc = entry.path.endsWith(".md")
					? parseVaultFrontmatter(raw)
					: { body: raw, data: {} };
				kind = typeof doc.data.kind === "string" ? doc.data.kind : undefined;
				if (
					(input.kind !== undefined && input.kind !== kind) ||
					(input.query !== undefined && !doc.body.includes(input.query))
				) {
					continue;
				}
			} catch (error) {
				access.signal.throwIfAborted();
				if (
					!(error instanceof ResourceAccessError) &&
					!(error instanceof TypeError) &&
					!(error instanceof VaultFrontmatterError)
				) {
					throw error;
				}
				// Failed decoding/parsing may still have consumed a full bounded read.
				bytes += MAX_TEXT_BYTES;
				skipped++;
				continue;
			}
		}
		matches.push({
			path: entry.path,
			...(kind === undefined ? {} : { kind }),
			...(input.glob ? { matchedGlob: true } : {}),
			...(input.query === undefined ? {} : { matchedQuery: true }),
		});
	}
	const output = boundedVaultRows(matches);
	return vaultResult({
		matches: output.rows,
		truncated: truncated || output.truncated,
		skipped,
	});
};

/** Malformed frontmatter is a finding, not a successful lint or an unhandled parser error. */
const lintText = (path: string, text: string): VaultLintFinding => {
	try {
		return lintRow({
			rel: path,
			frontmatter: parseVaultFrontmatter(text).data,
		});
	} catch (error) {
		return {
			path,
			ok: false,
			reason: "schema-fail",
			errors: [
				{
					code: "custom",
					path: [],
					message: vaultPreview(
						error instanceof Error ? error.message : String(error),
					),
				},
			],
		};
	}
};

/** Explicit lint paths fail closed; discovery skips unreadable text and reports incomplete coverage. */
export const lintVault = async (
	paths: string[] | undefined,
	access: WorkspaceAccess,
): Promise<RuntimeToolResult> => {
	const root = await checkedVaultPath(".", access);
	const walk =
		paths === undefined ? await vaultEntries(root, access, true) : undefined;
	const candidates =
		paths === undefined
			? walk!.entries
					.filter(
						(entry) => entry.kind === "file" && entry.path.endsWith(".md"),
					)
					.map((entry) => join(root, entry.path))
			: await Promise.all(paths.map((path) => checkedVaultPath(path, access)));
	const findings: VaultLintFinding[] = [];
	let bytes = 0;
	let truncated = walk?.truncated ?? false;
	let skipped = walk?.skipped ?? 0;
	for (const path of candidates) {
		if (
			bytes >= VAULT_LIMITS.bytes ||
			findings.length >= VAULT_LIMITS.results
		) {
			truncated = true;
			break;
		}
		try {
			const raw = await readVaultText(path, access);
			bytes += Buffer.byteLength(raw);
			if (bytes > VAULT_LIMITS.bytes) {
				truncated = true;
				break;
			}
			findings.push(lintText(vaultRelative(path, access), raw));
		} catch (error) {
			access.signal.throwIfAborted();
			if (
				paths !== undefined ||
				(!(error instanceof ResourceAccessError) &&
					!(error instanceof TypeError))
			) {
				throw error;
			}
			bytes += MAX_TEXT_BYTES;
			skipped++;
		}
	}
	const output = boundedVaultRows(findings);
	const ok = output.rows.filter((finding) => finding.ok).length;
	return vaultResult({
		findings: output.rows,
		summary: { total: output.rows.length, ok, failed: output.rows.length - ok },
		truncated: truncated || output.truncated,
		skipped,
	});
};
