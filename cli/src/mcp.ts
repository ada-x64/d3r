/* oxlint-disable no-await-in-loop -- Connection rollback and cursor pagination require sequential requests. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	type RuntimeMcpServer,
	type RuntimeTool,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import {
	createMcpHttpTransport,
	createMcpStdioTransport,
} from "./mcp-transport.ts";
export { loadMcpConfig, type McpConfigOptions } from "./resource-mcp.ts";

/** Preserve the original schema for model tool registration; Zod validates execution. */
export interface McpRuntimeTool extends RuntimeTool {
	readonly inputSchema: Record<string, unknown>;
}

/** Injection isolates protocol/transport tests from external processes and networks. */
export interface McpConnection {
	readonly listTools: (
		cursor: string | undefined,
		signal: AbortSignal,
	) => Promise<unknown>;
	readonly callTool: (
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	) => Promise<unknown>;
	readonly close: () => Promise<void>;
}

/** Connection setup, requests and disposal are bounded independently. */
export interface McpOptions {
	readonly cwd?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly createConnection?: (
		server: RuntimeMcpServer,
		options: { cwd: string; signal: AbortSignal; timeoutMs: number },
	) => Promise<McpConnection>;
}

/** Protocol data must be JSON, including values nested under unknown schema keys. */
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** JSON-only parsing rejects NaN, functions and undefined instead of coercing them. */
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(jsonValue),
		z.record(jsonValue),
	]),
);

/** Ceilings keep hostile discovery/results from creating unbounded model input. */
const MCP_LIMITS = {
	bytes: 2_097_152,
	output: 65_536,
	tools: 1000,
	pages: 100,
	timeout: 30_000,
	maxTimeout: 120_000,
	depth: 64,
	nodes: 100_000,
	slug: 18,
	hash: 20,
	name: 256,
};

/** Validate shape before selecting a transport; unknown keys are not silently ignored. */
const serverSchema = z.union([
	z
		.object({
			name: z.string().min(1).max(MCP_LIMITS.name),
			command: z
				.string()
				.min(1)
				.refine((value) => !value.includes("\0")),
			args: z.array(z.string().refine((value) => !value.includes("\0"))),
			env: z.array(
				z
					.object({
						name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
						value: z.string().refine((value) => !value.includes("\0")),
					})
					.strict(),
			),
		})
		.strict(),
	z
		.object({
			type: z.enum(["http", "sse"]),
			name: z.string().min(1).max(MCP_LIMITS.name),
			url: z.string().url(),
			headers: z.array(
				z
					.object({
						name: z.string().regex(/^[!#$%&'*+.^_`|~\w-]+$/),
						value: z
							.string()
							.refine(
								(value) => !value.includes("\0") && !/[\r\n]/.test(value),
							),
					})
					.strict(),
			),
		})
		.strict(),
]);

/** Resource content stays text-only; links are described, never fetched implicitly. */
const resultContent = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
	z
		.object({
			type: z.literal("image"),
			data: z.string(),
			mimeType: z.string(),
		})
		.passthrough(),
	z
		.object({
			type: z.literal("audio"),
			data: z.string(),
			mimeType: z.string(),
		})
		.passthrough(),
	z
		.object({
			type: z.literal("resource_link"),
			uri: z.string(),
			name: z.string(),
		})
		.passthrough(),
	z
		.object({
			type: z.literal("resource"),
			resource: z.union([
				z.object({ uri: z.string(), text: z.string() }).passthrough(),
				z.object({ uri: z.string(), blob: z.string() }).passthrough(),
			]),
		})
		.passthrough(),
]);

/** Tool metadata is parsed, but annotations are never trusted as authorization. */
const toolSchema = z
	.object({
		name: z.string().min(1).max(MCP_LIMITS.name),
		description: z.string().max(MCP_LIMITS.output).optional(),
		inputSchema: z.object({ type: z.literal("object") }).catchall(jsonValue),
	})
	.passthrough();

/** Bound nesting before recursive Zod parsing; reject cycles and non-plain objects. */
const parseJsonBoundary = (value: unknown): JsonValue => {
	let nodes = 0;
	const active = new Set<object>();
	const visit = (item: unknown, depth: number): void => {
		if (++nodes > MCP_LIMITS.nodes || depth > MCP_LIMITS.depth) {
			throw new Error("MCP JSON nesting/size limit exceeded");
		}
		if (item === null || typeof item !== "object") {
			return;
		}
		if (active.has(item)) {
			throw new Error("Cyclic MCP JSON is not supported");
		}
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		) {
			throw new Error("MCP JSON must contain plain objects");
		}
		if (Object.hasOwn(item, "__proto__")) {
			throw new Error("Reserved MCP JSON key: __proto__");
		}
		active.add(item);
		for (const child of Object.values(item)) {
			visit(child, depth + 1);
		}
		active.delete(item);
	};
	visit(value, 0);
	const parsed = jsonValue.parse(value);
	if (Buffer.byteLength(JSON.stringify(parsed)) > MCP_LIMITS.bytes) {
		throw new Error("MCP JSON byte limit exceeded");
	}
	return parsed;
};

/** Stable names are independent of connection/discovery order and slug collisions. */
export const mcpToolName = (server: string, tool: string): string => {
	const slug = (value: string) =>
		value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MCP_LIMITS.slug) || "tool";
	const hash = createHash("sha256")
		.update(JSON.stringify([server, tool]))
		.digest("hex")
		.slice(0, MCP_LIMITS.hash);
	return `mcp_${slug(server)}_${slug(tool)}_${hash}`;
};

/** No remote schema loading, defaults, coercion or removal of user-supplied fields. */
const compileInput = (schema: Record<string, unknown>): ValidateFunction => {
	const options = {
		allErrors: true,
		strict: false,
		ownProperties: true,
		validateFormats: false,
	};
	const dialect = schema.$schema;
	if (dialect !== undefined && typeof dialect !== "string") {
		throw new Error("Invalid MCP JSON Schema dialect");
	}
	if (
		typeof dialect === "string" &&
		!/^https?:\/\/json-schema.org\/(?:draft-07\/schema#?|draft\/2019-09\/schema#?|draft\/2020-12\/schema#?)$/.test(
			dialect,
		)
	) {
		throw new Error(`Unsupported MCP JSON Schema dialect: ${dialect}`);
	}
	if (schema.$async) {
		throw new Error("Asynchronous MCP input schemas are not supported");
	}
	if (typeof dialect === "string" && dialect.includes("2020-12")) {
		return new Ajv2020(options).compile(schema);
	}
	if (typeof dialect === "string" && dialect.includes("2019-09")) {
		return new Ajv2019(options).compile(schema);
	}
	return new Ajv(options).compile(schema);
};

/** A timeout races non-cooperating injected clients while forwarding cancellation. */
const bounded = async <T>(
	signal: AbortSignal,
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
	signal.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() =>
			controller.abort(
				new Error(`MCP operation timed out after ${timeoutMs}ms`),
			),
		timeoutMs,
	);
	let onAbort: (() => void) | undefined = undefined;
	try {
		return await Promise.race([
			operation(controller.signal),
			new Promise<never>((_, reject) => {
				onAbort = () => reject(controller.signal.reason);
				controller.signal.addEventListener("abort", onAbort, { once: true });
				if (controller.signal.aborted) {
					onAbort();
				}
			}),
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		if (onAbort) {
			controller.signal.removeEventListener("abort", onAbort);
		}
	}
};

/** SDK protocol over owned transports; an injected transport keeps lifecycle tests offline. */
export const createMcpConnection = async (
	server: RuntimeMcpServer,
	options: { cwd: string; signal: AbortSignal; timeoutMs: number },
	transportOverride?: Transport,
): Promise<McpConnection> => {
	const client = new Client(
		{ name: "d3r", version: "0.0.0" },
		{ capabilities: {} },
	);
	const transport =
		transportOverride ??
		("type" in server
			? createMcpHttpTransport(server)
			: createMcpStdioTransport(server, options));
	const abort = () => {
		void client.close().catch(() => undefined);
	};
	options.signal.addEventListener("abort", abort, { once: true });
	try {
		options.signal.throwIfAborted();
		await client.connect(transport, {
			signal: options.signal,
			timeout: options.timeoutMs,
		});
		options.signal.throwIfAborted();
	} catch (error) {
		await transport.close();
		throw error;
	} finally {
		options.signal.removeEventListener("abort", abort);
	}
	return {
		listTools: (cursor, signal) =>
			client.listTools(cursor ? { cursor } : {}, {
				signal,
				timeout: options.timeoutMs,
			}),
		callTool: (name, args, signal) =>
			client.callTool({ name, arguments: args }, undefined, {
				signal,
				timeout: options.timeoutMs,
			}),
		close: () => client.close(),
	};
};

/** Refuse invalid/ambiguous transport settings before starting any server. */
const parseServers = (
	servers: readonly RuntimeMcpServer[],
): RuntimeMcpServer[] => {
	const parsed = z
		.array(serverSchema)
		.max(MCP_LIMITS.tools)
		.parse(parseJsonBoundary(servers));
	const names = new Set<string>();
	for (const server of parsed) {
		if (names.has(server.name)) {
			throw new Error(`Duplicate MCP server name: ${server.name}`);
		}
		names.add(server.name);
		const keys =
			"type" in server
				? server.headers.map(({ name }) => name.toLowerCase())
				: server.env.map(({ name }) =>
						process.platform === "win32" ? name.toLowerCase() : name,
					);
		if (new Set(keys).size !== keys.length) {
			throw new Error(`Duplicate MCP header/environment key: ${server.name}`);
		}
		if ("type" in server) {
			if (server.type === "sse") {
				throw new Error(
					`MCP SSE transport is not supported: ${server.name}; use streamable HTTP`,
				);
			}
			const url = new URL(server.url);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.hash
			) {
				throw new Error(`Invalid MCP HTTP URL: ${server.name}`);
			}
		}
	}
	return parsed;
};

/** Results are validated and converted without executing embedded resources. */
const toolResult = (value: unknown): RuntimeToolResult => {
	const result = z
		.object({
			content: z.array(resultContent).optional(),
			structuredContent: z.record(jsonValue).optional(),
			isError: z.boolean().optional(),
		})
		.passthrough()
		.parse(parseJsonBoundary(value));
	if (!result.content && !result.structuredContent) {
		throw new Error(
			"MCP tool result has neither content nor structuredContent",
		);
	}
	const chunks = (result.content ?? []).map((content) => {
		switch (content.type) {
			case "text": {
				return content.text;
			}
			case "resource_link": {
				return `[Resource: ${content.name}] ${content.uri}`;
			}
			case "resource": {
				return "text" in content.resource
					? content.resource.text
					: `[Binary resource omitted: ${content.resource.uri}]`;
			}
			default: {
				return `[${content.type} content omitted: ${content.mimeType}]`;
			}
		}
	});
	if (result.structuredContent) {
		chunks.push(JSON.stringify(result.structuredContent));
	}
	const raw = chunks.join("\n");
	const text =
		Buffer.byteLength(raw) > MCP_LIMITS.output
			? `${Buffer.from(raw).subarray(0, MCP_LIMITS.output).toString("utf8")}\n[MCP output truncated]`
			: raw;
	return {
		text,
		isError: result.isError ?? false,
		content: [{ type: "text", text }],
	};
};

/** Connect only explicitly supplied servers; every discovered tool requires approval. */
// oxlint-disable-next-line max-statements -- Keep transport rollback and discovery ownership in one shell.
export const connectMcpTools = async (
	servers: readonly RuntimeMcpServer[],
	{
		cwd = process.cwd(),
		signal = new AbortController().signal,
		timeoutMs = MCP_LIMITS.timeout,
		createConnection = createMcpConnection,
	}: McpOptions = {},
): Promise<{ tools: McpRuntimeTool[]; dispose: () => Promise<void> }> => {
	const parsed = parseServers(servers);
	z.number().int().positive().max(MCP_LIMITS.maxTimeout).parse(timeoutMs);
	signal.throwIfAborted();
	const connections: McpConnection[] = [];
	const tools: McpRuntimeTool[] = [];
	const lifetime = new AbortController();
	const sessionSignal = AbortSignal.any([signal, lifetime.signal]);
	let disposed = false;
	let disposal: Promise<void> | undefined = undefined;
	const dispose = (): Promise<void> => {
		if (disposal) {
			return disposal;
		}
		disposed = true;
		signal.removeEventListener("abort", abortConnections);
		lifetime.abort(new Error("MCP connection disposed"));
		disposal = Promise.allSettled(
			connections.map((connection) =>
				bounded(new AbortController().signal, timeoutMs, () =>
					connection.close(),
				),
			),
		).then((results) => {
			const errors = results
				.filter((result) => result.status === "rejected")
				.map((result) => result.reason);
			if (errors.length) {
				throw new AggregateError(errors, "Failed to close MCP connections");
			}
		});
		return disposal;
	};
	const abortConnections = () => {
		void dispose().catch(() => undefined);
	};
	signal.addEventListener("abort", abortConnections, { once: true });
	if (signal.aborted) {
		abortConnections();
	}
	try {
		for (const server of parsed) {
			const connection = await bounded(
				sessionSignal,
				timeoutMs,
				async (requestSignal) => {
					const opened = await createConnection(server, {
						cwd: resolve(cwd),
						signal: requestSignal,
						timeoutMs,
					});
					if (requestSignal.aborted) {
						await opened.close();
						requestSignal.throwIfAborted();
					}
					return opened;
				},
			);
			connections.push(connection);
			const names = new Set<string>();
			const cursors = new Set<string>();
			let cursor: string | undefined = undefined;
			do {
				const response = await bounded(
					sessionSignal,
					timeoutMs,
					(requestSignal) => connection.listTools(cursor, requestSignal),
				);
				const page = z
					.object({
						tools: z.array(toolSchema),
						nextCursor: z.string().min(1).optional(),
					})
					.passthrough()
					.parse(parseJsonBoundary(response));
				for (const definition of page.tools) {
					if (names.has(definition.name)) {
						throw new Error(
							`Duplicate MCP tool ${server.name}/${definition.name}`,
						);
					}
					names.add(definition.name);
					if (tools.length >= MCP_LIMITS.tools) {
						throw new Error("MCP tool count limit exceeded");
					}
					const validate = compileInput(definition.inputSchema);
					const schema = z.record(z.unknown()).superRefine((args, context) => {
						try {
							parseJsonBoundary(args);
							if (!validate(args)) {
								context.addIssue({
									code: z.ZodIssueCode.custom,
									message: `MCP input schema: ${JSON.stringify(validate.errors)}`,
								});
							}
						} catch (error) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message:
									error instanceof Error ? error.message : "Invalid MCP input",
							});
						}
					});
					tools.push({
						name: mcpToolName(server.name, definition.name),
						description: `MCP ${server.name}/${definition.name}. Approval required; server hints are untrusted. ${definition.description ?? ""}`,
						kind: "other",
						permission: "ask",
						schema,
						inputSchema: definition.inputSchema,
						execute: async (args, context) => {
							if (disposed) {
								throw new Error("MCP connection disposed");
							}
							const input = schema.parse(args);
							const callSignal = AbortSignal.any([
								sessionSignal,
								context.signal,
							]);
							callSignal.throwIfAborted();
							return toolResult(
								await bounded(callSignal, timeoutMs, (requestSignal) =>
									connection.callTool(definition.name, input, requestSignal),
								),
							);
						},
					});
				}
				cursor = page.nextCursor;
				if (cursor) {
					if (cursors.has(cursor) || cursors.size >= MCP_LIMITS.pages) {
						throw new Error("MCP pagination repeated or exceeded its limit");
					}
					cursors.add(cursor);
				}
			} while (cursor);
		}
		return { tools, dispose };
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			// oxlint-disable-next-line preserve-caught-error -- AggregateError.errors preserves both setup and cleanup failures.
			throw new AggregateError(
				[error, cleanupError],
				"MCP setup and cleanup failed",
				{ cause: cleanupError },
			);
		}
		throw error;
	}
};
