/* oxlint-disable no-magic-numbers -- Test counters and model usage are fixed offline data. */
import { createEmbeddedRuntime } from "@d3r/adapter-pi/embedded";
import { type Models } from "@d3r/adapter-pi/auth";
import {
	type RuntimeActivity,
	type RuntimePermission,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { connectMcpTools, mcpToolName } from "./mcp.ts";
import {
	CWD,
	MODEL_A,
	chosenModel,
	nativeFixture,
	testPrompt,
} from "./native-test-support.ts";
import { nativeRoleTools } from "./native-resources.ts";

/** Provider types are inferred through the public auth adapter, not imported from Pi. */
type Stream = ReturnType<Models["streamSimple"]>;
/** Complete offline messages exercise the actual embedded tool loop. */
type Message = Awaited<ReturnType<Stream["result"]>>;
/** A tiny injected event source implements the portion consumed by the actual runtime. */
const eventStream = (message: Message): Stream => {
	const events: Awaited<
		ReturnType<ReturnType<Stream[typeof Symbol.asyncIterator]>["next"]>
	>["value"][] = [
		{ type: "start", partial: message },
		...message.content
			.filter((part) => part.type === "text")
			.map((part) => ({
				type: "text_delta" as const,
				contentIndex: 0,
				delta: part.text,
				partial: message,
			})),
		{ type: "done", reason: message.stopReason as "stop" | "toolUse", message },
	];
	let index = 0;
	return {
		[Symbol.asyncIterator]: () => ({
			next: async () =>
				index < events.length
					? { value: events[index++], done: false }
					: { value: undefined, done: true },
		}),
		result: async () => message,
	} as Stream;
};
/** No token/accounting or provider response fields depend on network state. */
const response = (
	content: Message["content"],
	stopReason: Message["stopReason"] = "stop",
): Message => ({
	role: "assistant",
	content,
	api: MODEL_A.api,
	provider: MODEL_A.provider,
	model: "second",
	stopReason,
	timestamp: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

/** Real runtime and MCP SDK-facing discovery/validation; only the provider/transport IO is fake. */
describe("native real runtime and MCP composition", () => {
	it("makes its first provider request only after explicit selection and a same-session retry grants workspace approval", async () => {
		const f = nativeFixture();
		f.deps.loadModelConfig.mockResolvedValue({
			ok: true,
			value: { config: { presets: [], defaultPreset: null }, sources: [] },
		});
		const order: string[] = [];
		f.requestPermission
			.mockImplementationOnce(async () => {
				order.push("permission");
				return false;
			})
			.mockImplementation(async () => {
				order.push("permission");
				return true;
			});
		f.models.streamSimple.mockImplementation(() => {
			order.push("provider");
			return eventStream(
				response([{ type: "text", text: "Actual embedded offline reply" }]),
			);
		});
		const session = await f.open({}, { createEmbeddedRuntime });
		try {
			const unselected = testPrompt("Hi! tell me about yourself.");
			await expect(session.prompt(unselected)).resolves.toBe("completed");
			expect(unselected.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "text",
					text: expect.stringContaining("Select a model in Zed"),
				}),
			);
			expect(order).toEqual([]);
			expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
			expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
			expect(f.models.streamSimple).not.toHaveBeenCalled();
			await session.setConfig!("model", chosenModel);
			const denied = testPrompt();
			await expect(session.prompt(denied)).resolves.toBe("completed");
			expect(denied.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "text",
					text: expect.stringMatching(/workspace permission.*not granted/i),
				}),
			);
			expect(order).toEqual(["permission"]);
			expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
			expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
			expect(f.models.streamSimple).not.toHaveBeenCalled();
			const prompt = testPrompt();
			await expect(session.prompt(prompt)).resolves.toBe("completed");
			expect(order).toEqual(["permission", "permission", "provider"]);
			expect(f.models.streamSimple).toHaveBeenCalledTimes(1);
			expect(f.models.streamSimple.mock.calls[0][0].id).toBe("second");
			expect(prompt.emit).toHaveBeenCalledWith(
				expect.objectContaining({ text: "Actual embedded offline reply" }),
			);
			expect(JSON.stringify(session.snapshot!())).toContain(
				"Actual embedded offline reply",
			);
		} finally {
			await f.close();
		}
	});

	it("separately asks to connect and call a discovered MCP tool, preserving explicit role filtering", async () => {
		const f = nativeFixture();
		const name = mcpToolName("remote", "write");
		const callTool = vi.fn(async () => ({
			content: [{ type: "text", text: "Tool completed" }],
		}));
		const close = vi.fn(async () => {});
		const permissions: RuntimePermission[] = [];
		const requestPermission = vi.fn(async (request: RuntimePermission) => {
			permissions.push(request);
			return true;
		});
		const createConnection = vi.fn(async () => ({
			listTools: async () => ({
				tools: [
					{
						name: "write",
						inputSchema: {
							type: "object",
							properties: {},
							additionalProperties: false,
						},
					},
				],
			}),
			callTool,
			close,
		}));
		const connector = vi.fn<typeof connectMcpTools>((servers, options) =>
			connectMcpTools(servers, { ...options, createConnection }),
		);
		f.models.streamSimple
			.mockImplementationOnce(() =>
				eventStream(
					response(
						[{ type: "toolCall", id: "tool-1", name, arguments: {} }],
						"toolUse",
					),
				),
			)
			.mockImplementation(() =>
				eventStream(response([{ type: "text", text: "Done" }])),
			);
		const session = await f.open(
			{
				client: { requestPermission },
				mcpServers: [
					{
						name: "remote",
						type: "http",
						url: "https://remote.invalid/mcp",
						headers: [],
					},
				],
			},
			{ createEmbeddedRuntime, connectMcpTools: connector },
		);
		try {
			const activities: RuntimeActivity[] = [];
			await expect(
				session.prompt(
					testPrompt("call remote", {
						activity: async (event) => {
							activities.push(event);
						},
					}),
				),
			).resolves.toBe("completed");
			expect(permissions.map(({ title }) => title)).toEqual([
				expect.stringContaining("Trust workspace"),
				"Connect MCP remote: https://remote.invalid",
				expect.stringContaining(name),
			]);
			expect(createConnection).toHaveBeenCalledTimes(1);
			expect(callTool).toHaveBeenCalledWith(
				"write",
				{},
				expect.any(AbortSignal),
			);
			expect(activities).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "tool", status: "completed" }),
				]),
			);
			const result = await connector.mock.results[0].value;
			expect(result.tools[0].permission).toBe("ask");
			expect(nativeRoleTools(f.resources.agents[0], result.tools)).toEqual([]);
			const named = {
				...f.resources.agents[0],
				spec: { ...f.resources.agents[0].spec, tools: [name] },
			};
			expect(nativeRoleTools(named, result.tools)).toHaveLength(1);
			await session.dispose();
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});

	it("never calls a connected MCP tool when its separate per-call permission is denied", async () => {
		const f = nativeFixture();
		const name = mcpToolName("remote", "write");
		const callTool = vi.fn(async () => ({ content: [] }));
		const close = vi.fn(async () => {});
		const requestPermission = vi.fn(async (request: RuntimePermission) =>
			request.toolCallId.startsWith("d3r:permission:"),
		);
		f.models.streamSimple
			.mockImplementationOnce(() =>
				eventStream(
					response(
						[{ type: "toolCall", id: "denied", name, arguments: {} }],
						"toolUse",
					),
				),
			)
			.mockImplementation(() =>
				eventStream(response([{ type: "text", text: "Permission denied" }])),
			);
		const session = await f.open(
			{
				client: { requestPermission },
				mcpServers: [
					{ name: "remote", command: "offline-command", args: [], env: [] },
				],
			},
			{
				createEmbeddedRuntime,
				connectMcpTools: (servers, options) =>
					connectMcpTools(servers, {
						...options,
						createConnection: async () => ({
							listTools: async () => ({
								tools: [{ name: "write", inputSchema: { type: "object" } }],
							}),
							callTool,
							close,
						}),
					}),
			},
		);
		try {
			await session.prompt(testPrompt());
			expect(requestPermission).toHaveBeenCalledTimes(3);
			expect(callTool).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});

	it("rolls back earlier MCP connections if a later connection fails, without requesting a model", async () => {
		const f = nativeFixture();
		const close = vi.fn(async () => {});
		const createConnection = vi.fn(async () => ({
			listTools: async () => ({ tools: [] }),
			callTool: async () => ({}),
			close,
		}));

		const session = await f.open(
			{
				mcpServers: ["one", "two"].map((name) => ({
					name,
					command: "offline-command",
					args: [],
					env: [],
				})),
			},
			{
				connectMcpTools: (servers, options) =>
					connectMcpTools(servers, { ...options, cwd: CWD, createConnection }),
			},
		);
		try {
			createConnection
				.mockResolvedValueOnce({
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({}),
					close,
				})
				.mockRejectedValueOnce(new Error("second transport failure"));
			await expect(session.prompt(testPrompt())).rejects.toThrow(
				"Unable to initialize native session",
			);
			expect(close).toHaveBeenCalledTimes(1);
			expect(f.models.streamSimple).not.toHaveBeenCalled();
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});
});
