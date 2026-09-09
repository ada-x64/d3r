/* oxlint-disable no-await-in-loop, no-continue -- Bounded traversal is sequential; denied entries are skipped before IO. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { lstat, open, opendir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	type RuntimeCommand,
	type RuntimeCommandResult,
	type RuntimeTool,
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { z } from "zod";
import {
	checkedText,
	isMissing,
	isSensitivePath,
	readDiskText,
	readWorkspaceText,
	ResourceAccessError,
	workspacePath,
	type WorkspaceAccess,
} from "./resource-paths.ts";
import { atomicWorkspaceWrite } from "./resource-atomic.ts";

/** Fixed ceilings bound filesystem traversal and subprocess output. */
const LIMITS = {
	output: 65_536,
	entries: 5000,
	files: 2000,
	depth: 20,
	searchBytes: 8_388_608,
	results: 200,
	timeout: 30_000,
	maxTimeout: 120_000,
	fileMode: 0o600,
};

/** Common paths remain relative to the session cwd, not the process cwd. */
const pathSchema = z
	.string()
	.min(1)
	.refine((value) => !value.includes("\0"), "NUL is not allowed");

/** Reads return a fingerprint of the entire buffer, even when showing a slice. */
const readSchema = z
	.object({
		path: pathSchema,
		startLine: z.number().int().positive().default(1),
		endLine: z.number().int().positive().optional(),
	})
	.strict();

/** Only creation may omit snapshot; existing-file writes must carry their own token. */
const writeSchema = z
	.object({
		path: pathSchema,
		content: z.string(),
		snapshot: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	})
	.strict();

/** Exact replacement counts prevent accidental broad or ambiguous edits. */
const editSchema = z
	.object({
		path: pathSchema,
		oldText: z.string().min(1),
		newText: z.string(),
		expectedMatches: z.number().int().positive().max(LIMITS.results).default(1),
		snapshot: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

/** Literal search avoids user-controlled regular-expression backtracking. */
const searchSchema = z
	.object({
		path: pathSchema.default("."),
		query: z.string().min(1).max(LIMITS.output),
		caseSensitive: z.boolean().default(false),
		maxResults: z
			.number()
			.int()
			.positive()
			.max(LIMITS.results)
			.default(LIMITS.results),
	})
	.strict();

/** Shells must be explicitly named as executables; argv is otherwise literal. */
const commandSchema = z
	.object({
		command: pathSchema,
		args: z
			.array(
				z
					.string()
					.refine((value) => !value.includes("\0"), "NUL is not allowed"),
			)
			.max(LIMITS.entries)
			.default([]),
		cwd: pathSchema.optional(),
		timeoutMs: z
			.number()
			.int()
			.positive()
			.max(LIMITS.maxTimeout)
			.default(LIMITS.timeout),
	})
	.strict();

/** Fingerprints bind an edit to the version the model actually read. */
const fingerprint = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** Byte-based truncation applies to client terminals as well as local ones. */
const capOutput = (text: string): string =>
	Buffer.byteLength(text) <= LIMITS.output
		? text
		: `${new TextDecoder().decode(Buffer.from(text).subarray(0, LIMITS.output))}\n[Output truncated]`;

/** Plain text remains available to model providers without structured rendering. */
const textResult = (
	text: string,
	locations?: RuntimeToolResult["locations"],
): RuntimeToolResult => ({
	text,
	content: [{ type: "text", text }],
	...(locations ? { locations } : {}),
});

/** Mutations expose the exact editor/disk preimage rather than a guessed diff. */
const mutationResult = (
	path: string,
	oldText: string | null,
	newText: string,
): RuntimeToolResult => ({
	text: `Updated ${path}\nSnapshot: ${fingerprint(newText)}`,
	content: [{ type: "diff", path, oldText, newText }],
	locations: [{ path, line: 1 }],
});

/** No implicit shell mode: Windows batch files use a deliberately restricted argv. */
export const localCommandInvocation = (
	command: RuntimeCommand,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } => {
	if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command.command)) {
		return { command: command.command, args: [...command.args] };
	}
	const tokens = [command.command, ...command.args];
	if (
		tokens.some((token) => token.includes("\0") || /[\r\n"%!^&|<>]/.test(token))
	) {
		throw new Error(
			"Unsafe Windows batch argument; invoke an executable directly or explicitly approve cmd.exe with a shell script",
		);
	}
	return {
		command: process.env.ComSpec ?? "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			`"${tokens.map((token) => `"${token}"`).join(" ")}"`,
		],
		windowsVerbatimArguments: true,
	};
};

/** POSIX process groups prevent ordinary grandchildren surviving timeout/cancel. */
const runLocalCommand = (
	command: RuntimeCommand,
	signal: AbortSignal,
): Promise<RuntimeCommandResult> =>
	new Promise((fulfill, reject) => {
		signal.throwIfAborted();
		const invocation = localCommandInvocation(command);
		const child = spawn(invocation.command, invocation.args, {
			cwd: command.cwd,
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments: invocation.windowsVerbatimArguments,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let truncated = false;
		let settled = false;
		const finish = (error?: unknown, exitCode: number | null = null) => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener("abort", abort);
			if (error) {
				reject(error);
			} else {
				fulfill({
					output:
						Buffer.concat(chunks).toString("utf8") +
						(truncated ? "\n[Output truncated]" : ""),
					exitCode,
				});
			}
		};
		const abort = () => {
			if (child.pid && process.platform !== "win32") {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			} else if (child.pid) {
				// taskkill /T is needed because killing cmd.exe alone leaves its children alive.
				const killer = spawn(
					"taskkill.exe",
					["/pid", String(child.pid), "/T", "/F"],
					{ shell: false, windowsHide: true, stdio: "ignore" },
				);
				killer.on("error", () => child.kill("SIGKILL"));
				killer.unref();
			}
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			finish(signal.reason ?? new Error("Command aborted"));
		};
		const capture = (chunk: Buffer) => {
			const remaining = LIMITS.output - bytes;
			if (chunk.length > remaining) {
				truncated = true;
			}
			if (remaining > 0) {
				chunks.push(chunk.subarray(0, remaining));
				bytes += Math.min(remaining, chunk.length);
			}
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		child.on("error", (error) => finish(error));
		child.on("close", (code) => finish(undefined, code));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			abort();
		}
	});

/** Bound clients that do not promptly honor the negotiated abort signal. */
const withCommandTimeout = async <T>(
	signal: AbortSignal,
	timeoutMs: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.throwIfAborted();
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error(`Command timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	let rejectAbort: (() => void) | undefined = undefined;
	try {
		return await Promise.race([
			run(controller.signal),
			new Promise<never>((_, reject) => {
				rejectAbort = () => reject(controller.signal.reason);
				controller.signal.addEventListener("abort", rejectAbort, {
					once: true,
				});
				if (controller.signal.aborted) {
					rejectAbort();
				}
			}),
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		if (rejectAbort) {
			controller.signal.removeEventListener("abort", rejectAbort);
		}
	}
};

/** Traversal never follows links and has global entry, file, and depth limits. */
const walkFiles = async (
	path: string,
	access: WorkspaceAccess,
): Promise<{ files: string[]; truncated: boolean }> => {
	const files: string[] = [];
	let entries = 0;
	let truncated = false;
	const visit = async (candidate: string, depth: number): Promise<void> => {
		access.signal.throwIfAborted();
		if (
			entries >= LIMITS.entries ||
			files.length >= LIMITS.files ||
			depth > LIMITS.depth
		) {
			truncated = true;
			return;
		}
		const canonical = await workspacePath(candidate, access);
		const info = await lstat(canonical);
		if (info.isFile()) {
			files.push(canonical);
			return;
		}
		const directory = await opendir(canonical);
		for await (const entry of directory) {
			if (++entries > LIMITS.entries || files.length >= LIMITS.files) {
				truncated = true;
				break;
			}
			const next = join(canonical, entry.name);
			if (
				entry.isSymbolicLink() ||
				isSensitivePath(next) ||
				["node_modules", "dist", "build", ".cache"].includes(entry.name)
			) {
				continue;
			}
			try {
				await visit(next, depth + 1);
			} catch (error) {
				if (!(error instanceof ResourceAccessError)) {
					throw error;
				}
			}
		}
	};
	await visit(path, 0);
	return { files, truncated };
};

/** Lock files coordinate independent tool factories without mutable global state. */
const withDiskLock = async <T>(
	path: string,
	access: WorkspaceAccess,
	operation: () => Promise<T>,
): Promise<T> => {
	await workspacePath(dirname(path), access);
	const lockPath = join(dirname(path), `.d3r-${fingerprint(path)}.lock`);
	access.signal.throwIfAborted();
	const lock = await open(lockPath, "wx", LIMITS.fileMode);
	try {
		access.signal.throwIfAborted();
		return await operation();
	} finally {
		await lock.close();
		await unlink(lockPath);
	}
};

/** A client cannot turn an unreadable existing disk file into an apparent new file. */
const readMutationText = async (
	path: string,
	access: WorkspaceAccess,
): Promise<string | null> => {
	try {
		const { text } = await readWorkspaceText(path, access);
		return text;
	} catch (error) {
		if (!isMissing(error)) {
			throw error;
		}
		const info = await lstat(path).catch((statError: unknown) => {
			if (isMissing(statError)) {
				return null;
			}
			throw statError;
		});
		if (info) {
			throw error;
		}
		return null;
	}
};

/** A factory creates no subprocesses or effects; the dispatcher must enforce permission. */
export const createWorkspaceTools = ({
	cwd,
	additionalDirectories = [],
}: {
	cwd: string;
	additionalDirectories?: readonly string[];
}): RuntimeTool[] => {
	const roots = [
		resolve(cwd),
		...additionalDirectories.map((path) => resolve(cwd, path)),
	];

	// The dispatcher approves parsed input; pin cwd before approval, not at execution time.
	const scopedCommandSchema = commandSchema.transform((input) => ({
		...input,
		cwd: resolve(cwd, input.cwd ?? "."),
	}));
	const writing = new Set<string>();
	const accessFor = (context: RuntimeToolContext): WorkspaceAccess => ({
		cwd: context.cwd,
		roots,
		signal: context.signal,
		client: context.client,
	});
	const scopedPath = async (
		path: string,
		context: RuntimeToolContext,
		missing = false,
	) => {
		const access = accessFor(context);
		const canonical = await workspacePath(path, access, missing);
		if (context.roots.length) {
			await workspacePath(
				canonical,
				{ ...access, roots: context.roots },
				missing,
			);
		}
		return canonical;
	};
	// oxlint-disable-next-line max-statements -- Snapshot, client-buffer, lock and abort checks form one mutation transaction.
	const mutate = async (
		{ path, snapshot }: { path: string; snapshot?: string },
		context: RuntimeToolContext,
		transform: (oldText: string | null) => string,
	): Promise<RuntimeToolResult> => {
		const canonical = await scopedPath(path, context, true);
		if (writing.has(canonical)) {
			throw new Error(`Concurrent mutation refused: ${canonical}`);
		}
		writing.add(canonical);
		const access = accessFor(context);
		try {
			if (
				Boolean(context.client?.readTextFile) !==
				Boolean(context.client?.writeTextFile)
			) {
				throw new Error(
					"Client mutations require both readTextFile and writeTextFile to preserve unsaved buffers",
				);
			}
			const oldText = await readMutationText(canonical, access);
			const expected = snapshot;
			if (
				oldText !== null &&
				(!expected || expected !== fingerprint(oldText))
			) {
				throw new Error(
					"Stale or missing snapshot: pass the explicit snapshot token from your read_file result",
				);
			}
			if (oldText === null && expected) {
				throw new Error("Stale snapshot: the file was removed");
			}
			const newText = checkedText(transform(oldText));
			await scopedPath(canonical, context, oldText === null);
			context.signal.throwIfAborted();
			if (context.client?.writeTextFile) {
				const current = await readMutationText(canonical, access);
				if (current !== oldText) {
					throw new Error("Stale snapshot: editor buffer changed before write");
				}
				context.signal.throwIfAborted();
				await context.client.writeTextFile(canonical, newText, context.signal);
			} else {
				await withDiskLock(canonical, access, () =>
					atomicWorkspaceWrite({ path: canonical, oldText, newText }, access),
				);
			}

			return mutationResult(canonical, oldText, newText);
		} finally {
			writing.delete(canonical);
		}
	};
	return [
		{
			name: "read_file",
			description:
				"Read UTF-8 text within workspace roots, preferring unsaved editor buffers. Returns a snapshot token that must be explicitly passed in every edit or overwrite. Sensitive files and symlinks are denied.",
			kind: "read",
			schema: readSchema,
			permission: "none",
			execute: async (args, context) => {
				const input = readSchema.parse(args);
				if (input.endLine !== undefined && input.endLine < input.startLine) {
					throw new Error("endLine must be at least startLine");
				}
				const path = await scopedPath(
					input.path,
					context,
					Boolean(context.client?.readTextFile),
				);
				const file = await readWorkspaceText(path, accessFor(context));
				const snapshot = fingerprint(file.text);

				const lines = file.text
					.split("\n")
					.slice(input.startLine - 1, input.endLine)
					.map((line, index) => `${input.startLine + index}: ${line}`)
					.join("\n");
				return textResult(`Snapshot: ${snapshot}\n${capOutput(lines)}`, [
					{ path, line: input.startLine },
				]);
			},
		},
		{
			name: "write_file",
			description:
				"Create or overwrite a UTF-8 file after approval. Existing files REQUIRE the explicit snapshot token from your own read_file result; a prior read alone is not sufficient. Parent directory must exist. Emits the actual old/new diff.",
			kind: "edit",
			schema: writeSchema,
			permission: "ask",
			execute: async (args, context) => {
				const input = writeSchema.parse(args);
				return mutate(input, context, () => input.content);
			},
		},
		{
			name: "edit_file",
			description:
				"Replace exact text after approval. Requires the explicit snapshot token from your own read_file result (never inferred from another call); rejects stale files and unexpected non-overlapping match counts. Emits the actual old/new diff.",
			kind: "edit",
			schema: editSchema,
			permission: "ask",
			execute: async (args, context) => {
				const input = editSchema.parse(args);
				return mutate(input, context, (oldText) => {
					if (oldText === null) {
						throw new Error("Cannot edit a missing file");
					}
					const parts = oldText.split(input.oldText);
					if (parts.length - 1 !== input.expectedMatches) {
						throw new Error(
							`Expected ${input.expectedMatches} exact matches; found ${parts.length - 1}`,
						);
					}
					return parts.join(input.newText);
				});
			},
		},
		{
			name: "list_directory",
			description:
				"List one workspace directory, excluding sensitive stores and symlinks. Output and entry counts are bounded.",
			kind: "read",
			schema: z.object({ path: pathSchema.default(".") }).strict(),
			permission: "none",
			execute: async (args, context) => {
				const input = z
					.object({ path: pathSchema.default(".") })
					.strict()
					.parse(args);
				const path = await scopedPath(input.path, context);
				const entries: string[] = [];
				let seen = 0;
				const directory = await opendir(path);
				for await (const entry of directory) {
					context.signal.throwIfAborted();
					if (++seen > LIMITS.entries) {
						entries.push("[Entries truncated]");
						break;
					}
					if (
						entry.isSymbolicLink() ||
						isSensitivePath(join(path, entry.name))
					) {
						continue;
					}
					entries.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
				}
				return textResult(capOutput(entries.toSorted().join("\n")), [{ path }]);
			},
		},
		{
			name: "search",
			description:
				"Bounded literal UTF-8 search of saved files on disk within workspace roots; does not search unsaved editor buffers. Returns path:line matches as text without opening editor files or emitting follow locations. Skips private paths, symlinks, binary/oversized files and generated directories; reports truncation.",
			kind: "search",
			schema: searchSchema,
			permission: "none",
			// oxlint-disable-next-line max-statements -- One bounded search owns its aggregate byte/result budget.
			execute: async (args, context) => {
				const input = searchSchema.parse(args);
				const path = await scopedPath(input.path, context);
				const access = accessFor(context);
				const walk = await walkFiles(path, access);
				const matches: string[] = [];
				const needle = input.caseSensitive
					? input.query
					: input.query.toLowerCase();
				let bytes = 0;
				let { truncated } = walk;
				for (const candidate of walk.files) {
					if (
						matches.length >= input.maxResults ||
						bytes >= LIMITS.searchBytes
					) {
						truncated = true;
						break;
					}
					await scopedPath(candidate, context);
					let text = "";
					try {
						text = await readDiskText(candidate, context.signal);
						await scopedPath(candidate, context);
					} catch (error) {
						if (
							error instanceof ResourceAccessError ||
							error instanceof TypeError
						) {
							continue;
						}
						throw error;
					}
					bytes += Buffer.byteLength(text);
					const lines = text.split("\n");
					for (const [index, line] of lines.entries()) {
						if (
							!(input.caseSensitive ? line : line.toLowerCase()).includes(
								needle,
							)
						) {
							continue;
						}
						if (matches.length >= input.maxResults) {
							truncated = true;
							break;
						}
						matches.push(`${candidate}:${index + 1}: ${line}`);
					}
				}
				return textResult(
					capOutput(
						`${matches.join("\n")}${truncated ? "\n[Search truncated]" : ""}`,
					),
				);
			},
		},
		{
			name: "run_command",
			description:
				"APPROVAL REQUIRED. Execute a program with literal argv, or an explicitly requested shell. NOT A SANDBOX: commands can access files/network outside workspace roots. Execution has a bounded timeout and captured output cap; no automatic execution.",
			kind: "execute",
			schema: scopedCommandSchema,
			permission: "ask",
			execute: async (args, context) => {
				const input = scopedCommandSchema.parse(args);
				const path = await scopedPath(input.cwd, context);
				const info = await lstat(path);
				if (!info.isDirectory()) {
					throw new Error("Command cwd must be a directory");
				}
				context.signal.throwIfAborted();
				const command: RuntimeCommand = {
					command: input.command,
					args: input.args,
					cwd: path,
				};
				const result = await withCommandTimeout(
					context.signal,
					input.timeoutMs,
					(signal) =>
						context.client?.runCommand
							? context.client.runCommand(command, signal)
							: runLocalCommand(command, signal),
				);
				const text = `${capOutput(result.output)}\nExit code: ${result.exitCode ?? "unknown"}`;
				return {
					...textResult(text),
					isError: result.exitCode !== 0,
					content: [
						{ type: "text", text },
						...(result.terminalId
							? [{ type: "terminal" as const, terminalId: result.terminalId }]
							: []),
					],
				};
			},
		},
	];
};
