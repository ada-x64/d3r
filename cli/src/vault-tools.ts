import { type Stats } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
	type RuntimeTool,
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import {
	VaultEditParams,
	VaultFindParams,
	VaultLintParams,
	VaultLsParams,
	VaultMvParams,
	VaultReadParams,
	VaultRmParams,
	VaultWriteParams,
} from "@d3r/tools";
import { z } from "zod";
import {
	checkedText,
	isMissing,
	MAX_TEXT_BYTES,
	ResourceAccessError,
	type WorkspaceAccess,
} from "./resource-paths.ts";
import { createWorkspaceTools, withDiskLock } from "./runtime-tools.ts";
import { atomicWorkspaceWrite } from "./resource-atomic.ts";
import {
	boundedVaultRows,
	checkedVaultPath,
	readVaultText,
	VAULT_LIMITS,
	vaultEntries,
	vaultParents,
	vaultPathSchema,
	vaultPreimage,
	vaultPreview,
	vaultRelative,
	vaultResult,
	vaultSnapshot,
	vaultSnapshotSchema,
	vaultTextPage,
} from "./vault-paths.ts";
import { findVault, lintVault, vaultGlobSchema } from "./vault-scan.ts";
import {
	stringifyVaultDocument,
	vaultMetadataSchema,
} from "./vault-frontmatter.ts";

/** File pages use explicit code point bounds; the snapshot still covers the complete saved file. */
const readSchema = VaultReadParams.extend({
	path: vaultPathSchema,
	offset: z
		.number()
		.int()
		.nonnegative()
		.max(MAX_TEXT_BYTES)
		.default(0)
		.describe(
			"Zero-based Unicode code point offset, not UTF-8 bytes or UTF-16 code units; files only",
		),
	limit: z
		.number()
		.int()
		.positive()
		.max(VAULT_LIMITS.pageCodePoints)
		.default(VAULT_LIMITS.pageCodePoints)
		.describe(
			"Maximum Unicode code points to return (1-8192, default 8192); files only",
		),
}).strict();
/** Directory reads and listings are bounded discovery, not recursive mutation manifests. */
const lsSchema = VaultLsParams.extend({
	path: vaultPathSchema.default("."),
}).strict();
/** Bound query and glob inputs as well as the scan itself. */
const findSchema = VaultFindParams.extend({
	glob: vaultGlobSchema.optional(),
	query: z.string().max(VAULT_LIMITS.preview).optional(),
	kind: z.string().max(VAULT_LIMITS.path).optional(),
}).strict();
/** Both document assembly and raw writes require explicit snapshots for overwrites. */
const writeModesSchema = z.discriminatedUnion("mode", [
	VaultWriteParams.options[0]
		.extend({
			path: vaultPathSchema,
			snapshot: vaultSnapshotSchema.optional(),
			frontmatter: vaultMetadataSchema.optional(),
		})
		.strict(),
	VaultWriteParams.options[1]
		.extend({ path: vaultPathSchema, snapshot: vaultSnapshotSchema.optional() })
		.strict(),
]);
/** Providers require an object root; the strict union remains authoritative after input conversion. */
const writeSchema = z
	.object({
		mode: z.enum(["raw", "doc"]),
		path: vaultPathSchema,
		contents: z
			.string()
			.optional()
			.describe("Required in raw mode; forbidden in doc mode"),
		kind: z
			.string()
			.optional()
			.describe("Required in doc mode; forbidden in raw mode"),
		frontmatter: vaultMetadataSchema
			.optional()
			.describe(
				"Optional YAML-compatible metadata in doc mode; forbidden in raw mode",
			),
		body: z
			.string()
			.optional()
			.describe("Required verbatim body in doc mode; forbidden in raw mode"),
		snapshot: vaultSnapshotSchema.optional(),
	})
	.strict()
	.transform((input, context) => {
		const parsed = writeModesSchema.safeParse(input);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				context.addIssue(issue);
			}
			return z.NEVER;
		}
		return parsed.data;
	});

/** Literal edits use the existing vault names and the native exact-match-count safeguards. */
const editSchema = VaultEditParams.extend({
	path: vaultPathSchema,
	count: z.number().int().positive().max(VAULT_LIMITS.results).default(1),
	snapshot: vaultSnapshotSchema,
}).strict();
/** Node cannot atomically rename without replacement; native moves never overwrite. */
const mvSchema = VaultMvParams.extend({
	from: vaultPathSchema,
	to: vaultPathSchema,
	overwrite: z.literal(false).default(false),
	snapshot: vaultSnapshotSchema,
}).strict();
/** Recursive directory deletion is intentionally unavailable at the model boundary. */
const rmSchema = VaultRmParams.extend({
	path: vaultPathSchema,
	recursive: z.literal(false).default(false),
	snapshot: vaultSnapshotSchema,
}).strict();
/** Explicit lint lists cannot turn into an unbounded fan-out. */
const lintSchema = VaultLintParams.extend({
	paths: z.array(vaultPathSchema).max(VAULT_LIMITS.results).optional(),
}).strict();

/** Capture metadata as well as text before a deletion or two-step move. */
interface FilePreimage {
	path: string;
	text: string;
	info: Stats;
}

/** Metadata comparisons catch substitutions even when their text is identical. */
const sameFile = (before: Stats, after: Stats): boolean =>
	after.isFile() &&
	after.nlink === 1 &&
	before.dev === after.dev &&
	before.ino === after.ino &&
	before.mode === after.mode &&
	before.size === after.size &&
	before.mtimeMs === after.mtimeMs &&
	before.ctimeMs === after.ctimeMs;

/** Directory operations are refused without inspecting their potentially private descendants. */
const filePreimage = async (
	path: string,
	snapshot: string,
	access: WorkspaceAccess,
): Promise<FilePreimage> => {
	const info = await lstat(path);
	if (!info.isFile()) {
		throw new ResourceAccessError(
			"Native vault_mv/vault_rm support regular text files only; directory operations are unsupported",
		);
	}
	const text = await vaultPreimage(path, snapshot, access);
	if (text === null || !sameFile(info, await lstat(path))) {
		throw new Error("Stale snapshot: source identity changed");
	}
	return { path, text, info };
};

/** Refuse existing destinations without reading or authorizing their replacement. */
const requireMoveDestination = async (path: string): Promise<void> => {
	const info = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	});
	if (info) {
		throw new Error(
			"Move destination already exists; overwriting moves are unsupported",
		);
	}
};

/** Revalidate the complete preimage immediately before unlink; Node has no unlink CAS. */
const removePreimage = async (
	before: FilePreimage,
	access: WorkspaceAccess,
): Promise<void> => {
	const path = await checkedVaultPath(
		vaultRelative(before.path, access),
		access,
	);
	if (
		(await readVaultText(path, access)) !== before.text ||
		!sameFile(before.info, await lstat(path))
	) {
		throw new Error("Stale snapshot: source changed before removal");
	}
	access.signal.throwIfAborted();
	await unlink(path);
};

/** Directory rows have reusable relative paths and no bulk editor follow locations. */
const listVault = async (
	path: string,
	access: WorkspaceAccess,
): Promise<RuntimeToolResult> => {
	const walk = await vaultEntries(path, access);
	const output = boundedVaultRows(
		walk.entries.map((entry) => ({ ...entry, name: basename(entry.path) })),
	);
	return vaultResult({
		kind: "dir",
		path: vaultRelative(path, access),
		entries: output.rows,
		truncated: walk.truncated || output.truncated,
		skipped: walk.skipped,
	});
};

/** Inert factory: the embedded dispatcher approves mutations before execute performs any effects. */
// oxlint-disable-next-line max-statements -- Tool composition keeps its pinned access context private to this factory.
export const createVaultTools = ({
	vaultRoot,
}: {
	vaultRoot: string;
}): RuntimeTool[] => {
	if (
		!isAbsolute(vaultRoot) ||
		resolve(vaultRoot) !== vaultRoot ||
		vaultRoot.includes("\0")
	) {
		throw new ResourceAccessError(
			"Vault root must be an absolute canonical directory path",
		);
	}
	const workspace = createWorkspaceTools({ cwd: vaultRoot });
	const write = workspace.find((tool) => tool.name === "write_file")!;
	const edit = workspace.find((tool) => tool.name === "edit_file")!;
	const accessFor = (context: RuntimeToolContext): WorkspaceAccess => ({
		cwd: vaultRoot,
		roots: [vaultRoot],
		signal: context.signal,
	});
	// Approval belongs to the outer bridge. Never give vault IO the ACP editor fs,
	// even when this separate document store is physically inside the workspace.
	const diskContext = (context: RuntimeToolContext): RuntimeToolContext => ({
		toolCallId: context.toolCallId,
		cwd: vaultRoot,
		roots: [vaultRoot],
		signal: context.signal,
	});
	const mutationResult = (
		path: string,
		result: RuntimeToolResult,
		access: WorkspaceAccess,
	): RuntimeToolResult => ({
		...result,
		text: result.text.replace(path, vaultRelative(path, access)),
	});
	return [
		{
			name: "vault_read",
			description:
				"Read saved UTF-8 vault text in pages or list a directory. Use '/'-separated relative paths within the pinned vault, independently of session cwd; private paths and links are denied. File offset is zero-based Unicode code points (default 0); limit is 1-8192 code points (default/max 8192), NOT bytes or UTF-16 code units. Returns path, raw text, offset, limit, truncated, and nextOffset when more text remains; continue at nextOffset to read an entire template/doc. Offset at EOF returns an empty final page; beyond EOF is an error. Every page rereads the complete file (maximum 1048576 bytes) and returns its WHOLE-file snapshot: restart pagination if snapshots differ. Explicitly pass that snapshot to every overwrite, edit, move or removal. Pagination is file-only; directory listings remain bounded and are not mutation snapshots. Never reads ACP editor buffers.",
			kind: "read",
			schema: readSchema,
			permission: "none",
			execute: async (args, context) => {
				const input = readSchema.parse(args);
				const access = accessFor(context);
				const path = await checkedVaultPath(input.path, access);
				const info = await lstat(path);
				if (info.isDirectory()) {
					if (
						input.offset !== 0 ||
						input.limit !== VAULT_LIMITS.pageCodePoints
					) {
						throw new ResourceAccessError(
							"Read offset/limit pagination applies only to files",
						);
					}
					return listVault(path, access);
				}
				const text = await readVaultText(path, access);
				return {
					...vaultResult({
						kind: "file",
						path: vaultRelative(path, access),
						...vaultTextPage(text, input.offset, input.limit),
						snapshot: vaultSnapshot(text),
					}),
					locations: [{ path, line: 1 }],
				};
			},
		},
		{
			name: "vault_ls",
			description:
				"List bounded immediate children of a vault-relative directory (default .). Includes .misc/templates and .misc/archive; skips private files and links, reporting skipped/truncated entries. Saved disk only, without bulk follow locations.",
			kind: "read",
			schema: lsSchema,
			permission: "none",
			execute: async (args, context) => {
				const input = lsSchema.parse(args);
				const access = accessFor(context);
				return listVault(await checkedVaultPath(input.path, access), access);
			},
		},
		{
			name: "vault_find",
			description:
				"Bounded saved-disk vault scan, including .misc, returning structured relative-path matches as JSON text without editor follow locations. Optional glob (*, **, ?), case-sensitive body substring query, and frontmatter kind are ANDed. Parses only non-executable YAML frontmatter; skips invalid metadata/unsupported languages as well as private/link/binary/oversized content, reporting skipped and truncated coverage.",
			kind: "search",
			schema: findSchema,
			permission: "none",
			execute: async (args, context) =>
				findVault(findSchema.parse(args), accessFor(context)),
		},
		{
			name: "vault_write",
			description:
				"After approval, create or overwrite a vault-relative UTF-8 file on disk, never an editor buffer. mode raw requires contents and forbids kind/frontmatter/body; mode doc requires kind and body, permits frontmatter, and forbids contents. Metadata is non-executable YAML with bounded JSON-compatible values; body is preserved verbatim without parsing or template merging. Existing files REQUIRE snapshot from vault_read; omit only for creation. Creates checked parent directories, never a missing vault root. Rejects stale snapshots before mkdir. Uses native atomic publication/no-clobber and returns the actual diff plus new snapshot. Empty parents may remain on later failure.",
			kind: "edit",
			schema: writeSchema,
			permission: "ask",
			execute: async (args, context) => {
				const input = writeSchema.parse(args);
				const access = accessFor(context);
				const path = await checkedVaultPath(input.path, access, true);
				const content = checkedText(
					input.mode === "raw"
						? input.contents
						: stringifyVaultDocument(
								{ ...input.frontmatter, kind: input.kind },
								input.body,
							),
				);
				await vaultPreimage(path, input.snapshot, access);
				await vaultParents(path, access);
				return mutationResult(
					path,
					await write.execute(
						{ path, content, snapshot: input.snapshot },
						diskContext(context),
					),
					access,
				);
			},
		},
		{
			name: "vault_edit",
			description:
				"After approval, replace literal find with replace in a vault-relative saved file. Requires the explicit snapshot from vault_read and exactly count non-overlapping matches (default 1). Native checked atomic disk write; preserves literal replacement text and returns actual old/new diff plus new snapshot. Never uses ACP editor filesystem services.",
			kind: "edit",
			schema: editSchema,
			permission: "ask",
			execute: async (args, context) => {
				const input = editSchema.parse(args);
				const access = accessFor(context);
				const path = await checkedVaultPath(input.path, access);
				return mutationResult(
					path,
					await edit.execute(
						{
							path,
							snapshot: input.snapshot,
							oldText: input.find,
							newText: input.replace,
							expectedMatches: input.count,
						},
						diskContext(context),
					),
					access,
				);
			},
		},
		{
			name: "vault_mv",
			description:
				"After approval, move a regular UTF-8 file between vault-relative paths using source snapshot from vault_read. Directories, vault root, and overwrite=true are unsupported. Copies text into a new private-mode destination without clobber, then rechecks/removes source under both writer locks; original metadata is not preserved. This two-step move is NOT atomic or rollback-capable. On removal failure the destination is retained and reported for recovery. Creates checked destination parents; emits actual creation/deletion diffs. Node cannot guarantee CAS against hostile external inode swaps.",
			kind: "move",
			schema: mvSchema,
			permission: "ask",
			execute: async (args, context) => {
				const input = mvSchema.parse(args);
				const access = accessFor(context);
				const from = await checkedVaultPath(input.from, access);
				const to = await checkedVaultPath(input.to, access, true);
				const before = await filePreimage(from, input.snapshot, access);
				await requireMoveDestination(to);
				return withDiskLock(from, access, async () => {
					await filePreimage(from, input.snapshot, access);
					await vaultParents(to, access);
					return withDiskLock(to, access, async () => {
						await atomicWorkspaceWrite(
							{ path: to, oldText: null, newText: before.text },
							access,
						);
						const content: NonNullable<RuntimeToolResult["content"]> = [
							{ type: "diff", path: to, oldText: null, newText: before.text },
						];
						try {
							await vaultPreimage(to, input.snapshot, access);
							await removePreimage(before, access);
						} catch (error) {
							return {
								content,
								isError: true,
								text: `Move incomplete: destination ${vaultRelative(to, access)} was created; source ${vaultRelative(from, access)} was not removed by this tool. Re-read both paths before recovery. Snapshot: ${vaultSnapshot(before.text)}. ${vaultPreview(error instanceof Error ? error.message : String(error))}`,
							};
						}
						return {
							text: `Moved ${vaultRelative(from, access)} to ${vaultRelative(to, access)}\nSnapshot: ${vaultSnapshot(before.text)}`,
							content: [
								...content,
								{ type: "diff", path: from, oldText: before.text, newText: "" },
							],
						};
					});
				});
			},
		},
		{
			name: "vault_rm",
			description:
				"After approval, remove a regular UTF-8 vault-relative file using explicit snapshot from vault_read. Rechecks text and identity under the native writer lock before unlink and returns the actual preimage diff. Vault root, directories and recursive=true are unsupported; no recursive rollback or hostile-writer CAS is promised.",
			kind: "delete",
			schema: rmSchema,
			permission: "ask",
			execute: async (args, context) => {
				const input = rmSchema.parse(args);
				const access = accessFor(context);
				const path = await checkedVaultPath(input.path, access);
				const before = await filePreimage(path, input.snapshot, access);
				await withDiskLock(path, access, () => removePreimage(before, access));
				return {
					text: `Removed ${vaultRelative(path, access)}`,
					content: [{ type: "diff", path, oldText: before.text, newText: "" }],
				};
			},
		},
		{
			name: "vault_lint",
			description:
				"Validate saved vault frontmatter with the existing per-kind schemas. Optional vault-relative paths select files; otherwise scan markdown including .misc. Bounded findings/summary JSON with skipped/truncated coverage; malformed YAML, unsupported languages/tags and invalid metadata are schema-fail findings; parsing never evaluates code. Unsafe explicit paths are errors. No editor reads or bulk follow locations.",
			kind: "read",
			schema: lintSchema,
			permission: "none",
			execute: async (args, context) =>
				lintVault(lintSchema.parse(args).paths, accessFor(context)),
		},
	];
};
