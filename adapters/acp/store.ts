import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	RequestError,
	type SessionInfo,
	type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import { contentBlock } from "./params.ts";

/** A durable intent prevents restoring stale state while an effectful mutation is unsettled. */
export type SessionMutation = "prompt" | "config" | "restore";
/** Checkpoints are runtime-owned JSON, not provider instances or connection configuration. */
export type SessionRecord =
	| { readonly kind: "intent"; readonly operation: SessionMutation }
	| { readonly kind: "update"; readonly update: SessionUpdate }
	| { readonly kind: "checkpoint"; readonly state: unknown };
/** Only this allowlisted envelope is ever serialized. MCP launch data is deliberately absent. */
export interface StoredSession {
	readonly version: 1;
	readonly sessionId: string;
	readonly cwd: string;
	readonly additionalDirectories: readonly string[];
	readonly updatedAt: string;
	readonly records: readonly SessionRecord[];
}
/** Leases prevent simultaneous backends and delete/write resurrection, including across processes. */
export interface SessionStore {
	readonly acquire: (id: string) => Promise<() => Promise<void>>;
	/** Only complete checkpoints may be returned for restoration. */
	readonly get: (id: string) => Promise<StoredSession | null>;
	/** Accept a final checkpoint or a write-ahead intent, never an unmarked partial transcript. */
	readonly save: (session: StoredSession) => Promise<void>;
	readonly delete: (id: string) => Promise<boolean>;
	readonly list: (params: {
		cwd?: string | null;
		cursor?: string | null;
	}) => Promise<{ sessions: SessionInfo[]; nextCursor?: string }>;
}
/** UUID-only basenames exclude traversal, separators, devices, and reserved filenames. */
const idSchema = z.string().uuid();
/** Validate the full retained update rather than letting the SDK drop corrupt history. */
const toolFields = {
	toolCallId: z.string(),
	title: z.string().optional(),
	kind: z
		.enum([
			"read",
			"edit",
			"delete",
			"move",
			"search",
			"execute",
			"think",
			"fetch",
			"other",
		])
		.optional(),
	status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
	content: z
		.array(
			z.discriminatedUnion("type", [
				z.object({ type: z.literal("content"), content: contentBlock }),
				z.object({
					type: z.literal("diff"),
					path: z.string().refine(isAbsolute),
					oldText: z.string().nullish(),
					newText: z.string(),
				}),
			]),
		)
		.optional(),
	locations: z
		.array(
			z.object({
				path: z.string().refine(isAbsolute),
				line: z.number().int().positive().optional(),
			}),
		)
		.optional(),
	rawInput: z.unknown(),
	rawOutput: z.unknown(),
};
/** Checkpoints never replay transient terminals; their captured output is ordinary text. */
const updateSchema = z.discriminatedUnion("sessionUpdate", [
	z.object({
		sessionUpdate: z.literal("user_message_chunk"),
		messageId: z.string().optional(),
		content: contentBlock,
	}),
	z.object({
		sessionUpdate: z.literal("agent_message_chunk"),
		messageId: z.string().optional(),
		content: contentBlock,
	}),
	z.object({
		sessionUpdate: z.literal("agent_thought_chunk"),
		messageId: z.string().optional(),
		content: contentBlock,
	}),
	z.object({
		sessionUpdate: z.literal("tool_call"),
		...toolFields,
		title: z.string(),
	}),
	z.object({ sessionUpdate: z.literal("tool_call_update"), ...toolFields }),
	z.object({
		sessionUpdate: z.literal("plan"),
		entries: z.array(
			z.object({
				content: z.string(),
				status: z.enum(["pending", "in_progress", "completed"]),
				priority: z.enum(["high", "medium", "low"]),
			}),
		),
	}),
	z.object({
		sessionUpdate: z.literal("usage_update"),
		used: z.number().finite().nonnegative(),
		size: z.number().finite().nonnegative(),
		cost: z
			.object({
				amount: z.number().finite().nonnegative(),
				currency: z.string(),
			})
			.optional(),
	}),
	z.object({
		sessionUpdate: z.literal("config_option_update"),
		configOptions: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				category: z.string().optional(),
				type: z.literal("select"),
				currentValue: z.string(),
				options: z.array(z.object({ value: z.string(), name: z.string() })),
			}),
		),
	}),
	z.object({
		sessionUpdate: z.literal("available_commands_update"),
		availableCommands: z.array(
			z.object({
				name: z.string(),
				description: z.string(),
				input: z.object({ hint: z.string() }).optional(),
			}),
		),
	}),
]);
/** Validate the version and ownership before handing opaque checkpoints to a backend. */
const storedSchema = z.object({
	version: z.literal(1),
	sessionId: idSchema,
	cwd: z.string().refine(isAbsolute),
	additionalDirectories: z.array(z.string().refine(isAbsolute)),
	updatedAt: z.string().datetime(),
	records: z.array(
		z.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("intent"),
				operation: z.enum(["prompt", "config", "restore"]),
			}),
			z.object({ kind: z.literal("update"), update: updateSchema }),
			z.object({
				kind: z.literal("checkpoint"),
				state: z.unknown().refine((value) => value !== undefined),
			}),
		]),
	),
});
/** Never expose filesystem paths or OS error details through protocol errors. */
const hasCode = (error: unknown, code: string): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === code;
/** Credential-bearing fields are not valid checkpoint state; defense in depth for injected runtimes. */
const secretKey =
	/^(?:mcpServers|headers|env|credentials?|authorization|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;
/** Copy JSON data while removing credential fields and known transient MCP secrets. */
export const redactSessionData = <T>(
	value: T,
	secrets: readonly string[] = [],
): T =>
	JSON.parse(
		JSON.stringify(value, (key, item: unknown) => {
			if (secretKey.test(key)) {
				return undefined;
			}
			if (typeof item !== "string") {
				return item;
			}
			return secrets.reduce(
				(text, secret) =>
					secret ? text.split(secret).join("[redacted]") : text,
				item,
			);
		}),
	) as T;
/** Persistent files are private even when the process umask is permissive. */
const FILE_MODE = 0o600;
/** Keep directory scans and cursor pages separate from the session filename convention. */
const FILE_SUFFIX = ".json";
/** Bound each response while allowing small pages in embedders and tests. */
const PAGE_SIZE = { default: 50, maximum: 1000 };
/** Sync the replacement's directory entry where Node supports directory fsync. */
const syncDirectory = async (dir: string): Promise<void> => {
	if (process.platform === "win32") {
		return;
	}
	const directory = await open(dir, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
};
/** Private, atomic files with exclusive session leases; callers must release leases on shutdown.
 * The directory is trusted host configuration. After an ungraceful process death, stale
 * .lock files require operator removal after confirming no process owns the session.
 */
export const createSessionStore = (
	dir: string,
	options: { pageSize?: number } = {},
): SessionStore => {
	const root = resolve(dir);
	const pageSize = options.pageSize ?? PAGE_SIZE.default;
	if (
		!Number.isInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > PAGE_SIZE.maximum
	) {
		throw new Error("Invalid session page size");
	}
	const ready = () => mkdir(root, { recursive: true, mode: 0o700 });
	const pathFor = (id: string, suffix = FILE_SUFFIX) => {
		if (!idSchema.safeParse(id).success) {
			throw RequestError.invalidParams(undefined, "Unknown session");
		}
		return join(root, `${id}${suffix}`);
	};
	const read = async (id: string): Promise<StoredSession | null> => {
		const path = pathFor(id);
		try {
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			const text = await (async () => {
				try {
					const info = await file.stat();
					if (!info.isFile() || info.nlink !== 1) {
						throw new Error("Invalid session file");
					}
					return await file.readFile("utf8");
				} finally {
					await file.close();
				}
			})();
			const parsed = storedSchema.safeParse(JSON.parse(text));
			if (
				!parsed.success ||
				parsed.data.sessionId !== id ||
				!["checkpoint", "intent"].includes(
					parsed.data.records.at(-1)?.kind ?? "",
				)
			) {
				throw new Error("Invalid session file");
			}
			return parsed.data as StoredSession;
		} catch (error) {
			if (hasCode(error, "ENOENT")) {
				return null;
			}
			throw RequestError.internalError(
				undefined,
				"Could not read stored session",
			);
		}
	};
	return {
		acquire: async (id) => {
			const path = pathFor(id, ".lock");
			await ready();
			try {
				const file = await open(path, "wx", FILE_MODE);
				await file.close();
			} catch (error) {
				if (hasCode(error, "EEXIST")) {
					throw RequestError.invalidRequest(
						undefined,
						"Session is already open or locked",
					);
				}
				throw RequestError.internalError(undefined, "Could not lock session");
			}
			let released = false;
			return async () => {
				if (released) {
					return;
				}
				released = true;
				await unlink(path).catch((error: unknown) => {
					if (!hasCode(error, "ENOENT")) {
						throw new Error("Could not unlock session");
					}
				});
			};
		},
		get: async (id) => {
			const stored = await read(id);
			if (stored && stored.records.at(-1)?.kind !== "checkpoint") {
				throw RequestError.internalError(
					undefined,
					"Stored session has an incomplete mutation; automatic recovery is unsafe",
				);
			}
			return stored;
		},
		save: async (session) => {
			const path = pathFor(session.sessionId);
			const temporary = pathFor(session.sessionId, `.${randomUUID()}.tmp`);
			await ready();
			try {
				const safe = redactSessionData({
					version: session.version,
					sessionId: session.sessionId,
					cwd: session.cwd,
					additionalDirectories: session.additionalDirectories,
					updatedAt: session.updatedAt,
					records: session.records,
				});
				if (
					!storedSchema.safeParse(safe).success ||
					!["checkpoint", "intent"].includes(safe.records.at(-1)?.kind ?? "")
				) {
					throw new Error("Invalid session");
				}
				const file = await open(temporary, "wx", FILE_MODE);
				try {
					await file.writeFile(JSON.stringify(safe));
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, path);
				await syncDirectory(root);
			} catch {
				throw RequestError.internalError(undefined, "Could not save session");
			} finally {
				await unlink(temporary).catch(() => {});
			}
		},
		delete: async (id) => {
			const path = pathFor(id);
			try {
				await unlink(path);
				return true;
			} catch (error) {
				if (hasCode(error, "ENOENT")) {
					return false;
				}
				throw RequestError.internalError(undefined, "Could not delete session");
			}
		},
		list: async ({ cwd, cursor }) => {
			await ready();
			let after = "";
			if (cursor) {
				try {
					const parsed = z
						.object({ after: idSchema, cwd: z.string().nullable() })
						.strict()
						.parse(
							JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
						);
					if (parsed.cwd !== (cwd ?? null)) {
						throw new Error("Cursor filter mismatch");
					}
					({ after } = parsed);
				} catch {
					throw RequestError.invalidParams(undefined, "Invalid session cursor");
				}
			}
			const entries = await readdir(root, { withFileTypes: true });
			const names = entries
				.filter(
					(entry) =>
						entry.isFile() &&
						entry.name.endsWith(FILE_SUFFIX) &&
						idSchema.safeParse(entry.name.slice(0, -FILE_SUFFIX.length))
							.success,
				)
				.map((entry) => entry.name.slice(0, -FILE_SUFFIX.length))
				.filter((id) => id > after)
				.toSorted();
			const stored = await Promise.all(names.map(read));
			const rows = stored.filter(
				(row): row is StoredSession =>
					row !== null && (!cwd || row.cwd === cwd),
			);
			const page = rows.slice(0, pageSize);
			return {
				sessions: page.map((row) => ({
					sessionId: row.sessionId,
					cwd: row.cwd,
					additionalDirectories: [...row.additionalDirectories],
					updatedAt: row.updatedAt,
				})),
				...(rows.length > pageSize
					? {
							nextCursor: Buffer.from(
								JSON.stringify({
									after: page.at(-1)!.sessionId,
									cwd: cwd ?? null,
								}),
							).toString("base64url"),
						}
					: {}),
			};
		},
	};
};
