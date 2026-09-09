/* oxlint-disable init-declarations, no-magic-numbers -- Deferred fixtures and protocol count assertions are test data. */
import {
	type RuntimeMcpServer,
	type RuntimeToolContext,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { connectMcpTools, mcpToolName, type McpConnection } from "./mcp.ts";

/** Injected protocol peers test discovery without launching providers or servers. */
const server: RuntimeMcpServer = {
	name: "test-server",
	command: "never-launch",
	args: [],
	env: [],
};

/** Native MCP tool fixtures include nested JSON Schema constraints. */
const definition = {
	name: "lookup/items",
	description: "Lookup",
	inputSchema: {
		type: "object",
		properties: {
			count: { type: "integer", minimum: 1 },
			nested: {
				type: "object",
				properties: { choice: { enum: ["a", "b"] } },
				required: ["choice"],
				additionalProperties: false,
			},
		},
		required: ["count", "nested"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true, destructiveHint: false },
};

/** Each test owns its connection and close state. */
const connection = (): McpConnection => ({
	listTools: vi.fn(async () => ({ tools: [definition] })),
	callTool: vi.fn(async () => ({
		content: [{ type: "text", text: "answer" }],
	})),
	close: vi.fn(async () => undefined),
});

/** Test executions are scoped and cancellable, like runtime-owned calls. */
const context = (): RuntimeToolContext => ({
	toolCallId: "call-1",
	cwd: process.cwd(),
	roots: [process.cwd()],
	signal: new AbortController().signal,
});

/** No tests make provider requests or instantiate real MCP transports. */
describe("MCP runtime tools", () => {
	it("starts nothing for empty configuration", async () => {
		const createConnection = vi.fn();
		const result = await connectMcpTools([], { createConnection });
		expect(result.tools).toEqual([]);
		expect(createConnection).not.toHaveBeenCalled();
		await result.dispose();
	});

	it("preserves raw schemas, validates nested arguments, and always asks permission", async () => {
		const peer = connection();
		const result = await connectMcpTools([server], {
			createConnection: async () => peer,
		});
		try {
			const [tool] = result.tools;
			expect(tool.permission).toBe("ask");
			expect(tool.inputSchema).toEqual(definition.inputSchema);
			expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
			expect(
				tool.schema.safeParse({ count: 0, nested: { choice: "c" } }).success,
			).toBe(false);
			await expect(
				tool.execute({ count: "1", nested: { choice: "a" } }, context()),
			).rejects.toThrow(/MCP input schema/);
			await expect(
				tool.execute(
					{ count: 1, nested: { choice: "a" }, extra: true },
					context(),
				),
			).rejects.toThrow(/MCP input schema/);
			expect(peer.callTool).not.toHaveBeenCalled();
			const output = await tool.execute(
				{ count: 1, nested: { choice: "a" } },
				context(),
			);
			expect(output).toMatchObject({
				text: "answer",
				isError: false,
				content: [{ type: "text", text: "answer" }],
			});
			expect(peer.callTool).toHaveBeenCalledWith(
				"lookup/items",
				{ count: 1, nested: { choice: "a" } },
				expect.any(AbortSignal),
			);
		} finally {
			await result.dispose();
		}
	});

	it("generates deterministic names that disambiguate sanitized collisions", () => {
		expect(mcpToolName("a/b", "c")).not.toBe(mcpToolName("a_b", "c"));
		expect(mcpToolName("a", "b/c")).not.toBe(mcpToolName("a", "b_c"));
		expect(
			mcpToolName("a".repeat(500), "b".repeat(500)).length,
		).toBeLessThanOrEqual(64);
		expect(mcpToolName("server", "tool")).toBe(mcpToolName("server", "tool"));
	});

	it("passes stdio and streamable HTTP settings to the injected transport factory", async () => {
		const http: RuntimeMcpServer = {
			type: "http",
			name: "remote",
			url: "https://example.invalid/mcp",
			headers: [{ name: "Authorization", value: "Bearer test-value" }],
		};
		const createConnection = vi.fn(async () => connection());
		const result = await connectMcpTools([server, http], {
			cwd: process.cwd(),
			createConnection,
		});
		expect(createConnection).toHaveBeenNthCalledWith(
			1,
			server,
			expect.objectContaining({ cwd: process.cwd() }),
		);
		expect(createConnection).toHaveBeenNthCalledWith(
			2,
			http,
			expect.objectContaining({ cwd: process.cwd() }),
		);
		expect(new Set(result.tools.map(({ name }) => name)).size).toBe(2);
		await result.dispose();
	});

	it.each(
		[
			[
				{
					type: "sse",
					name: "legacy",
					url: "https://example.invalid",
					headers: [],
				},
			],
			[{ type: "http", name: "bad", url: "file:///tmp/mcp", headers: [] }],
			[
				{
					type: "http",
					name: "bad",
					url: "https://user:password@example.invalid",
					headers: [],
				},
			],
			[
				{
					type: "http",
					name: "bad",
					url: "https://example.invalid",
					headers: [{ name: "X-Test", value: "bad\r\nHeader: value" }],
				},
			],
			[{ ...server, env: [{ name: "BAD=NAME", value: "x" }] }],
			[{ ...server, ignored: "not allowed" }],
			[server, server],
		].map((servers) => [servers]),
	)(
		"rejects invalid server configuration before connecting: %j",
		async (invalid) => {
			const createConnection = vi.fn();
			await expect(
				connectMcpTools(invalid as unknown as RuntimeMcpServer[], {
					createConnection,
				}),
			).rejects.toThrow();
			expect(createConnection).not.toHaveBeenCalled();
		},
	);

	it("discovers all pages and closes exactly once", async () => {
		const peer = connection();
		const listTools = vi
			.fn()
			.mockResolvedValueOnce({ tools: [definition], nextCursor: "page-2" })
			.mockResolvedValueOnce({ tools: [{ ...definition, name: "second" }] });
		const result = await connectMcpTools([server], {
			createConnection: async () => ({ ...peer, listTools }),
		});
		expect(result.tools).toHaveLength(2);
		expect(listTools).toHaveBeenNthCalledWith(
			2,
			"page-2",
			expect.any(AbortSignal),
		);
		await Promise.all([result.dispose(), result.dispose()]);
		expect(peer.close).toHaveBeenCalledTimes(1);
		await expect(result.tools[0].execute({}, context())).rejects.toThrow(
			/disposed/,
		);
	});

	it("cleans up all earlier connections when later discovery fails", async () => {
		const first = connection();
		const second = {
			...connection(),
			listTools: vi.fn(async () => ({
				tools: [
					{
						name: "broken",
						inputSchema: {
							type: "object",
							properties: { x: { $ref: "https://example.invalid/schema" } },
						},
					},
				],
			})),
		};
		const createConnection = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(second);
		await expect(
			connectMcpTools([server, { ...server, name: "second" }], {
				createConnection,
			}),
		).rejects.toThrow();
		expect(first.close).toHaveBeenCalledTimes(1);
		expect(second.close).toHaveBeenCalledTimes(1);
	});

	it("fails clearly for duplicate tools, malformed pages, and repeated pagination", async () => {
		await Promise.all(
			[
				{ tools: [definition, definition] },
				{ tools: [{ name: "bad", inputSchema: { type: "array" } }] },
				{ tools: [] as unknown[], nextCursor: "repeated" },
			].map(async (response) => {
				const peer = {
					...connection(),
					listTools: vi.fn(async () => response),
				};
				await expect(
					connectMcpTools([server], { createConnection: async () => peer }),
				).rejects.toThrow();
				expect(peer.close).toHaveBeenCalledTimes(1);
			}),
		);
	});

	it("validates draft 2020-12 and refuses unsupported schema dialects", async () => {
		const peer = {
			...connection(),
			listTools: async () => ({
				tools: [
					{
						name: "modern",
						inputSchema: {
							$schema: "https://json-schema.org/draft/2020-12/schema",
							type: "object",
							properties: {
								values: {
									type: "array",
									prefixItems: [{ type: "string" }],
									items: false,
								},
							},
						},
					},
				],
			}),
		};
		const result = await connectMcpTools([server], {
			createConnection: async () => peer,
		});
		try {
			expect(
				result.tools[0].schema.safeParse({ values: ["yes"] }).success,
			).toBe(true);
			expect(result.tools[0].schema.safeParse({ values: [1] }).success).toBe(
				false,
			);
		} finally {
			await result.dispose();
		}
		const unsupported = {
			...connection(),
			listTools: async () => ({
				tools: [
					{
						...definition,
						inputSchema: {
							type: "object",
							$schema: "https://example.invalid/custom-dialect",
						},
					},
				],
			}),
		};
		await expect(
			connectMcpTools([server], { createConnection: async () => unsupported }),
		).rejects.toThrow(/Unsupported/);
	});

	it("preserves error and structured text, never fetches resource links", async () => {
		const peer = {
			...connection(),
			callTool: async () => ({
				isError: true,
				content: [
					{ type: "text", text: "remote failure" },
					{
						type: "resource_link",
						uri: "https://example.invalid/private",
						name: "link",
					},
					{
						type: "resource",
						resource: { uri: "file:///remote/file", text: "embedded text" },
					},
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
				structuredContent: { detail: 1 },
			}),
		};
		const result = await connectMcpTools([server], {
			createConnection: async () => peer,
		});
		try {
			const output = await result.tools[0].execute(
				{ count: 1, nested: { choice: "a" } },
				context(),
			);
			expect(output.isError).toBe(true);
			expect(output.text).toContain("remote failure");
			expect(output.text).toContain("embedded text");
			expect(output.text).toContain('"detail":1');
			expect(output.text).not.toContain("AA==");
		} finally {
			await result.dispose();
		}
	});

	it("rejects malformed tool results rather than silently ignoring them", async () => {
		const peer = {
			...connection(),
			callTool: async () => ({
				content: [{ type: "unknown", payload: "bad" }],
			}),
		};
		const result = await connectMcpTools([server], {
			createConnection: async () => peer,
		});
		try {
			await expect(
				result.tools[0].execute(
					{ count: 1, nested: { choice: "a" } },
					context(),
				),
			).rejects.toThrow();
		} finally {
			await result.dispose();
		}
	});

	it("cancels before connection or tool dispatch and bounds stalled requests", async () => {
		const createConnection = vi.fn();
		await expect(
			connectMcpTools([server], {
				signal: AbortSignal.abort(new Error("cancelled")),
				createConnection,
			}),
		).rejects.toThrow("cancelled");
		expect(createConnection).not.toHaveBeenCalled();
		const peer = {
			...connection(),
			callTool: vi.fn(() => new Promise<never>(() => undefined)),
		};
		const result = await connectMcpTools([server], {
			timeoutMs: 20,
			createConnection: async () => peer,
		});
		try {
			await expect(
				result.tools[0].execute(
					{ count: 1, nested: { choice: "a" } },
					{ ...context(), signal: AbortSignal.abort(new Error("cancelled")) },
				),
			).rejects.toThrow("cancelled");
			expect(peer.callTool).not.toHaveBeenCalled();
			await expect(
				result.tools[0].execute(
					{ count: 1, nested: { choice: "a" } },
					context(),
				),
			).rejects.toThrow(/timed out/);
		} finally {
			await result.dispose();
		}
	});

	it("disposal aborts active tool requests", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const peer = {
			...connection(),
			callTool: vi.fn(async (_name, _args, signal: AbortSignal) => {
				entered();
				return new Promise<never>((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			}),
		};
		const result = await connectMcpTools([server], {
			createConnection: async () => peer,
		});
		const pending = result.tools[0].execute(
			{ count: 1, nested: { choice: "a" } },
			context(),
		);
		const rejection = expect(pending).rejects.toThrow(/disposed/);
		await started;
		await result.dispose();
		await rejection;
	});

	it("bounds setup and closes connections that finish after cancellation", async () => {
		const peer = connection();
		let complete!: (value: McpConnection) => void;
		const pending = connectMcpTools([server], {
			timeoutMs: 20,
			createConnection: () =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		});
		await expect(pending).rejects.toThrow(/timed out/);
		complete(peer);
		await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(1));
	});
});
