/* oxlint-disable no-magic-numbers -- Test counters and model usage are fixed offline data. */
import { createEmbeddedRuntime } from "@d3r/adapter-pi/embedded";
import { type Models } from "@d3r/adapter-pi/auth";
import {
	type RuntimeActivity,
	type RuntimeMcpServer,
	type RuntimePermission,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { connectMcpTools, mcpToolName } from "./mcp.ts";
import { createClientServices } from "../../adapters/acp/client.ts";
import { createNativeMcpSecurity } from "./native-mcp.ts";
import {
	CWD,
	HOME,
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

/** Each test owns synthetic credentials and endpoints; no live configuration is loaded. */
const httpServer = (): Extract<RuntimeMcpServer, { type: string }> => ({
	name: "remote",
	type: "http",
	url: "https://remote.invalid/read-only?token=first-query-credential",
	headers: [{ name: "Authorization", value: "Bearer first-http-credential" }],
});
/** The fake transport consumes this plan without ever spawning its executable. */
const stdioServer = (): Extract<RuntimeMcpServer, { command: string }> => ({
	name: "local",
	command: "offline-command",
	args: ["--token", "first-argv-credential"],
	env: [{ name: "API_KEY", value: "first-stdio-credential" }],
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

	it.each([
		{
			change: "HTTP endpoint",
			original: httpServer(),
			changed: { ...httpServer(), url: "https://other.invalid/read-only" },
			samePreview: false,
		},
		{
			change: "HTTP path",
			original: httpServer(),
			changed: {
				...httpServer(),
				url: "https://remote.invalid/admin?token=first-query-credential",
			},
			samePreview: true,
		},
		{
			change: "HTTP query credential",
			original: httpServer(),
			changed: {
				...httpServer(),
				url: "https://remote.invalid/read-only?token=second-query-credential",
			},
			samePreview: true,
		},
		{
			change: "HTTP header credential",
			original: httpServer(),
			changed: {
				...httpServer(),
				headers: [
					{ name: "Authorization", value: "Bearer second-http-credential" },
				],
			},
			samePreview: true,
		},
		{
			change: "stdio environment credential",
			original: stdioServer(),
			changed: {
				...stdioServer(),
				env: [{ name: "API_KEY", value: "second-stdio-credential" }],
			},
			samePreview: true,
		},
		{
			change: "stdio argv credential",
			original: stdioServer(),
			changed: {
				...stdioServer(),
				args: ["--token", "second-argv-credential"],
			},
			samePreview: true,
		},
	])(
		"reuses an unchanged setup grant but requires approval after a $change change",
		// oxlint-disable-next-line max-statements -- Hold approval, failed setup, denial and recovered execution in the same live root.
		async ({ original, changed, samePreview }) => {
			const f = nativeFixture();
			const decisions = ["allow_scope", "allow_scope", "reject"];
			const request = vi.fn(async (_method: string, _params: unknown) => ({
				outcome: {
					outcome: "selected",
					optionId: decisions.shift() ?? "reject",
				},
			}));
			const bridge = createClientServices(
				"offline-session",
				{ request } as unknown as Parameters<typeof createClientServices>[1],
				{ capabilities: {}, connectionSignal: new AbortController().signal },
			);
			const close = vi.fn(async () => {});
			const createConnection = vi
				.fn(async (_server: RuntimeMcpServer) => ({
					listTools: async () => ({ tools: [] }),
					callTool: async () => ({ content: [] }),
					close,
				}))
				.mockRejectedValueOnce(new Error("First controlled transport failure"))
				.mockRejectedValueOnce(
					new Error("Second controlled transport failure"),
				);
			const connector = vi.fn<typeof connectMcpTools>((servers, options) =>
				connectMcpTools(servers, { ...options, createConnection }),
			);
			f.deps.loadMcpConfig.mockResolvedValue([original]);
			f.deps.getMcpEnvironment.mockReturnValue({
				INHERITED_TOKEN: "inherited-stdio-credential",
			});
			f.models.streamSimple.mockImplementation(() =>
				eventStream(
					response([
						{ type: "text", text: "Recovered with the approved connection." },
					]),
				),
			);
			try {
				const session = await f.open(
					{ client: bridge.services },
					{ createEmbeddedRuntime, connectMcpTools: connector },
				);
				await expect(session.prompt(testPrompt())).rejects.toThrow(
					"Unable to initialize native session",
				);
				expect(request).toHaveBeenCalledTimes(2);
				expect(connector).toHaveBeenCalledTimes(1);
				expect(createConnection).toHaveBeenCalledTimes(1);
				expect(request.mock.calls[1][1]).toMatchObject({
					options: expect.arrayContaining([
						{
							optionId: "allow_scope",
							kind: "allow_always",
							name: "Allow this MCP connection configuration for this thread",
						},
					]),
				});
				await bridge.finishTurn();
				await expect(session.prompt(testPrompt())).rejects.toThrow(
					"Unable to initialize native session",
				);
				expect(request).toHaveBeenCalledTimes(2);
				expect(connector).toHaveBeenCalledTimes(2);
				expect(createConnection.mock.calls[1][0]).toEqual(
					createConnection.mock.calls[0][0],
				);
				await bridge.finishTurn();

				f.deps.loadMcpConfig.mockResolvedValue([changed]);
				const denied = testPrompt();
				await expect(session.prompt(denied)).resolves.toBe("completed");
				expect(request).toHaveBeenCalledTimes(3);
				expect(connector).toHaveBeenCalledTimes(2);
				expect(createConnection).toHaveBeenCalledTimes(2);
				expect(f.models.streamSimple).not.toHaveBeenCalled();
				expect(denied.emit).toHaveBeenCalledWith(
					expect.objectContaining({
						text: expect.stringContaining(
							"MCP connection permission was not granted",
						),
					}),
				);
				if (samePreview) {
					const preview = (index: number) => {
						const params = request.mock.calls[index][1] as {
							toolCall: { title: string; content: unknown; rawInput: unknown };
						};
						const { title, content, rawInput } = params.toolCall;
						return { title, content, rawInput };
					};
					expect(preview(2)).toEqual(preview(1));
				}
				await bridge.finishTurn();

				f.deps.loadMcpConfig.mockResolvedValue([original]);
				const recovered = testPrompt();
				await expect(session.prompt(recovered)).resolves.toBe("completed");
				expect(request).toHaveBeenCalledTimes(3);
				expect(connector).toHaveBeenCalledTimes(3);
				expect(createConnection).toHaveBeenCalledTimes(3);
				expect(createConnection.mock.calls[2][0]).toEqual(
					createConnection.mock.calls[0][0],
				);
				expect(f.models.streamSimple).toHaveBeenCalledTimes(1);
				expect(recovered.emit).toHaveBeenCalledWith(
					expect.objectContaining({
						text: "Recovered with the approved connection.",
					}),
				);
				const visible = JSON.stringify(request.mock.calls);
				const saved = JSON.stringify(session.snapshot!());
				for (const text of [visible, saved]) {
					expect(text).not.toContain("d3r:native:mcp-connection:");
					expect(text).not.toMatch(
						/(?:first|second)-(?:http|query|stdio|argv)-credential|inherited-stdio-credential/,
					);
				}
				expect(visible).not.toMatch(/[a-f0-9]{64}/);
				expect(decisions).toEqual([]);
			} finally {
				await f.close();
				await bridge.dispose();
			}
			expect(close).toHaveBeenCalledTimes(1);
		},
	);

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

/** Plan-level cases cover identity fields and instance isolation without transport noise. */
describe("native MCP connection identities", () => {
	it.each(["http", "sse"] as const)(
		"binds %s identities to the original URL, every header, name, transport and cwd",
		(type) => {
			const security = createNativeMcpSecurity();
			const server = { ...httpServer(), type };
			const context = { home: HOME, cwd: CWD, environment: {} };
			const [original] = security.plan([server], [], context);
			const changed = [
				{ ...server, name: "renamed" },
				{
					...server,
					type: type === "http" ? ("sse" as const) : ("http" as const),
				},
				{ ...server, url: server.url.replace("read-only", "admin") },
				{ ...server, url: server.url.replace("first-query", "second-query") },
				{
					...server,
					headers: [
						{ name: "Authorization", value: "Bearer second-http-credential" },
					],
				},
				{
					...server,
					headers: [...server.headers, { name: "X-Tenant", value: "other" }],
				},
			].map(
				(value) => security.plan([value], [], context)[0].permissionScope.id,
			);
			changed.push(
				security.plan([server], [], { ...context, cwd: `${CWD}-other` })[0]
					.permissionScope.id,
			);
			expect(changed).not.toContain(original.permissionScope.id);
			expect(new Set(changed).size).toBe(changed.length);
			expect(
				security.plan([structuredClone(server)], [], context)[0]
					.permissionScope,
			).toEqual(original.permissionScope);
		},
	);

	it("binds stdio identities to command, ordered argv and effective environment after overrides", () => {
		const security = createNativeMcpSecurity();
		const server = stdioServer();
		const context = {
			home: HOME,
			cwd: CWD,
			environment: {
				PATH: "original-path",
				API_KEY: "overridden-host-credential",
				SESSION_TOKEN: "first-host-credential",
			},
		};
		const [original] = security.plan([server], [], context);
		expect(original.server).toMatchObject({
			env: expect.arrayContaining([
				{ name: "PATH", value: "original-path" },
				{ name: "API_KEY", value: "first-stdio-credential" },
				{ name: "SESSION_TOKEN", value: "first-host-credential" },
			]),
		});
		const changed = [
			{ ...server, name: "renamed" },
			{ ...server, command: "different-command" },
			{ ...server, args: server.args.toReversed() },
			{ ...server, args: ["--token", "second-argv-credential"] },
			{
				...server,
				env: [{ name: "API_KEY", value: "second-stdio-credential" }],
			},
		].map((value) => security.plan([value], [], context)[0].permissionScope.id);
		for (const environment of [
			{ ...context.environment, PATH: "different-path" },
			{ ...context.environment, SESSION_TOKEN: "second-host-credential" },
		]) {
			changed.push(
				security.plan([server], [], { ...context, environment })[0]
					.permissionScope.id,
			);
		}
		changed.push(
			security.plan([server], [], { ...context, cwd: `${CWD}-other` })[0]
				.permissionScope.id,
		);
		expect(changed).not.toContain(original.permissionScope.id);
		expect(new Set(changed).size).toBe(changed.length);
		expect(
			security.plan([server], [], {
				...context,
				environment: {
					...context.environment,
					API_KEY: "different-but-overridden",
				},
			})[0].permissionScope,
		).toEqual(original.permissionScope);
	});

	it("keeps identical plans stable only in their owning root and leaves display summaries separate", () => {
		const security = createNativeMcpSecurity();
		const context = { home: HOME, cwd: CWD, environment: {} };
		for (const server of [httpServer(), stdioServer()]) {
			const [original] = security.plan([server], [], context);
			const [repeated] = security.plan([structuredClone(server)], [], context);
			const [otherRoot] = createNativeMcpSecurity().plan([server], [], context);
			expect(original.permissionScope).toEqual({
				id: expect.stringMatching(/^d3r:native:mcp-connection:[a-f0-9]{64}$/),
				label: "this MCP connection configuration",
			});
			expect(repeated.permissionScope).toEqual(original.permissionScope);
			expect(otherRoot.permissionScope.id).not.toBe(
				original.permissionScope.id,
			);
			expect(otherRoot.summary).toEqual(original.summary);
			expect(otherRoot.title).toBe(original.title);
			expect(JSON.stringify([original.title, original.summary])).not.toMatch(
				/[a-f0-9]{64}|first-(?:http|query|stdio|argv)-credential/,
			);
		}
	});
});
