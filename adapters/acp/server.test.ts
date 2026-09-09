import { client, RequestError, type McpServer } from "@agentclientprotocol/sdk";
import {
	createSessionStore,
	nativeAuthRequired,
	type NativeServerDeps,
} from "@d3r/adapter-acp/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import {
	type CreateRuntimeSession,
	type OpenRuntimeSession,
	type RuntimeSession,
	type RuntimePrompt,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CWD, fixture, runtime, waitForAbort } from "./test-support.ts";

/** Contract tests for native session ownership rather than SDK internals. */
describe("native ACP session foundation", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const open = (
		createSession: OpenRuntimeSession = () => ({
			prompt: async () => "completed",
			dispose: async () => {},
		}),
	) => {
		const f = fixture(createSession);
		cleanup.push(f.close);
		return f;
	};

	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((close) => close()));
	});

	it("reports D3R and v1 without advertising unimplemented features", async () => {
		const f = open();
		const futureVersion = 99;
		const result = await f.peer.agent.request("initialize", {
			protocolVersion: futureVersion,
			clientCapabilities: { fs: { readTextFile: true }, terminal: true },
		});
		expect(result).toEqual({
			protocolVersion: 1,
			agentInfo: { name: "d3r", title: "D3R", version: "test-version" },
			agentCapabilities: {
				promptCapabilities: { image: true, embeddedContext: true },
				mcpCapabilities: { http: true, sse: false },
				sessionCapabilities: { close: {}, additionalDirectories: {} },
			},
			authMethods: [],
		});
	});

	it("requires initialization and rejects reinitialization without losing sessions", async () => {
		const f = open();
		await expect(f.newSession()).rejects.toMatchObject({
			code: RequestError.invalidRequest().code,
		});
		await f.initialize();
		const { sessionId } = await f.newSession();
		await expect(f.initialize()).rejects.toMatchObject({
			code: RequestError.invalidRequest().code,
		});
		await expect(f.prompt(sessionId)).resolves.toEqual({
			stopReason: "end_turn",
		});
	});

	it("creates one runtime per session and forwards the requested cwd", async () => {
		const createSession = vi.fn<CreateRuntimeSession>(() => ({
			prompt: async () => "completed",
			dispose: async () => {},
		}));
		const f = open(createSession);
		await f.initialize();
		const first = await f.newSession();
		const otherCwd = resolve("workspace-b");
		const second = await f.newSession(otherCwd);
		expect(first.sessionId).not.toBe(second.sessionId);
		expect(createSession.mock.calls).toEqual([
			[
				expect.objectContaining({
					sessionId: first.sessionId,
					cwd: CWD,
					mcpServers: [],
					additionalDirectories: [],
					client: expect.any(Object),
				}),
			],
			[
				expect.objectContaining({
					sessionId: second.sessionId,
					cwd: otherCwd,
					mcpServers: [],
					additionalDirectories: [],
					client: expect.any(Object),
				}),
			],
		]);
	});

	it("refuses unsupported session inputs before constructing any runtime", async () => {
		const createSession = vi.fn<CreateRuntimeSession>();
		const f = open(createSession);
		await f.initialize();
		const invalid = [
			{ cwd: "relative", mcpServers: [] },
			{
				cwd: CWD,
				mcpServers: [{ name: "tools", command: "relative", args: [], env: [] }],
			},
			{ cwd: CWD, mcpServers: [{}] },
			{ cwd: CWD, mcpServers: "not-a-list" },
			{ cwd: CWD, mcpServers: [], additionalDirectories: [0] },
			{ cwd: CWD, mcpServers: [], additionalDirectories: "not-a-list" },
		];
		await Promise.all(
			invalid.map(async (params) => {
				await expect(
					f.peer.agent.request("session/new", params),
				).rejects.toMatchObject({
					code: RequestError.invalidParams().code,
				});
			}),
		);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("keeps text and resource links in order and streams thoughts separately", async () => {
		const requests: RuntimePrompt[] = [];
		const f = open(() => ({
			prompt: async (request) => {
				requests.push(request);
				await request.emit({
					kind: "thought",
					messageId: "thought-1",
					text: "Checking",
				});
				await request.emit({
					kind: "text",
					messageId: "message-1",
					text: "Hello",
				});
				await request.emit({
					kind: "text",
					messageId: "message-1",
					text: " world",
				});
				return "completed";
			},
			dispose: async () => {},
		}));
		await f.initialize();
		const { sessionId } = await f.newSession();
		const content = [
			{ type: "text" as const, text: "Inspect " },
			{
				type: "resource_link" as const,
				uri: "file:///work/config.json",
				name: "config.json",
				description: "Settings",
				mimeType: "application/json",
			},
			{ type: "text" as const, text: " please" },
		];
		await expect(
			f.peer.agent.request("session/prompt", { sessionId, prompt: content }),
		).resolves.toEqual({ stopReason: "end_turn" });
		expect(requests[0].content).toEqual(content);
		expect(f.updates).toEqual([
			{
				sessionId,
				update: {
					sessionUpdate: "agent_thought_chunk",
					messageId: "thought-1",
					content: { type: "text", text: "Checking" },
				},
			},
			{
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					messageId: "message-1",
					content: { type: "text", text: "Hello" },
				},
			},
			{
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					messageId: "message-1",
					content: { type: "text", text: " world" },
				},
			},
		]);
		await requests[0].emit({
			kind: "text",
			messageId: "late",
			text: "discard",
		});
		const expectedUpdates = 3;
		expect(f.updates).toHaveLength(expectedUpdates);
	});

	it.each([
		["completed", "end_turn"],
		["token_limit", "max_tokens"],
		["request_limit", "max_turn_requests"],
		["refused", "refusal"],
		["cancelled", "cancelled"],
	] as const)("maps %s to %s", async (runtimeReason, expected) => {
		const f = open(() => ({
			prompt: async () => runtimeReason,
			dispose: async () => {},
		}));
		await f.initialize();
		const { sessionId } = await f.newSession();
		await expect(f.prompt(sessionId)).resolves.toEqual({
			stopReason: expected,
		});
	});

	it("rejects unknown sessions and unsupported content without entering the runtime", async () => {
		const prompt = vi.fn<() => Promise<RuntimeStopReason>>(
			async () => "completed",
		);
		const f = open(() => ({ prompt, dispose: async () => {} }));
		await f.initialize();
		await expect(f.prompt("unknown")).rejects.toMatchObject({
			code: RequestError.invalidParams().code,
		});
		const { sessionId } = await f.newSession();
		await expect(
			f.peer.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "audio", mimeType: "audio/wav", data: "AA==" }],
			}),
		).rejects.toMatchObject({ code: RequestError.invalidParams().code });
		await expect(
			f.peer.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text" }],
			}),
		).rejects.toMatchObject({ code: RequestError.invalidParams().code });
		expect(prompt).not.toHaveBeenCalled();
		await expect(f.prompt(sessionId)).resolves.toEqual({
			stopReason: "end_turn",
		});
	});

	it("serializes prompts per session, cancels only that session, and accepts a later turn", async () => {
		const calls: RuntimePrompt[] = [];
		const concurrentCount = 2;
		const f = open(() => ({
			prompt: async (request) => {
				calls.push(request);
				if (calls.length <= concurrentCount) {
					return waitForAbort(request.signal);
				}
				return "completed";
			},
			dispose: async () => {},
		}));
		await f.initialize();
		const first = await f.newSession();
		const second = await f.newSession();
		const running = f.prompt(first.sessionId);
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		await expect(f.prompt(first.sessionId)).rejects.toMatchObject({
			code: RequestError.invalidRequest().code,
		});
		const otherRunning = f.prompt(second.sessionId);
		await vi.waitFor(() => expect(calls).toHaveLength(concurrentCount));
		await f.peer.agent.notify("session/cancel", { sessionId: first.sessionId });
		await expect(running).resolves.toEqual({ stopReason: "cancelled" });
		expect(calls[0].signal.aborted).toBe(true);
		expect(calls[1].signal.aborted).toBe(false);
		await f.peer.agent.notify("session/cancel", {
			sessionId: second.sessionId,
		});
		await expect(otherRunning).resolves.toEqual({ stopReason: "cancelled" });
		await expect(f.prompt(first.sessionId)).resolves.toEqual({
			stopReason: "end_turn",
		});
	});

	it("cancellation wins over a runtime's successful result and suppresses late chunks", async () => {
		const calls: RuntimePrompt[] = [];
		const f = open(() => ({
			prompt: async (request) => {
				calls.push(request);
				await waitForAbort(request.signal).catch(() => {});
				await request.emit({
					kind: "text",
					messageId: "cancelled",
					text: "discard",
				});
				return "completed";
			},
			dispose: async () => {},
		}));
		await f.initialize();
		const { sessionId } = await f.newSession();
		const running = f.prompt(sessionId);
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		await f.peer.agent.notify("session/cancel", { sessionId });
		await expect(running).resolves.toEqual({ stopReason: "cancelled" });
		expect(f.updates).toEqual([]);
	});

	it("sanitizes runtime errors and releases the session for the next prompt", async () => {
		const f = open(() => ({
			prompt: vi
				.fn()
				.mockRejectedValueOnce(new Error("secret request body"))
				.mockResolvedValue("completed"),
			dispose: async () => {},
		}));
		await f.initialize();
		const { sessionId } = await f.newSession();
		await expect(f.prompt(sessionId)).rejects.toMatchObject({
			code: RequestError.internalError().code,
			message: "Internal error: Agent runtime failed",
		});
		await expect(f.prompt(sessionId)).resolves.toEqual({
			stopReason: "end_turn",
		});
	});

	it("does not share session IDs between client connections", async () => {
		const a = open();
		const b = open();
		await Promise.all([a.initialize(), b.initialize()]);
		const { sessionId } = await a.newSession();
		await expect(b.prompt(sessionId)).rejects.toMatchObject({
			code: RequestError.invalidParams().code,
		});
	});

	it.each(["resolve", "reject"] as const)(
		"disposes runtimes while output is stalled, even if it later %ss",
		async (settlement) => {
			let release: () => void = vi.fn();
			const blocked = new Promise<void>((resolveOutput, rejectOutput) => {
				release = () =>
					settlement === "resolve"
						? resolveOutput()
						: rejectOutput(new Error("Output closed"));
			});
			let paused = false;
			let writing = false;
			const order: string[] = [];
			const f = fixture(
				() => ({
					prompt: async (request) => {
						try {
							await request.emit({
								kind: "text",
								messageId: "msg",
								text: "hello",
							});
							return "completed";
						} finally {
							order.push("settled");
						}
					},
					dispose: async () => {
						order.push("disposed");
					},
				}),
				async () => {
					if (paused) {
						writing = true;
						await blocked;
					}
				},
			);
			cleanup.push(f.close);
			try {
				await f.initialize();
				const { sessionId } = await f.newSession();
				await f.newSession();
				paused = true;
				const running = f.prompt(sessionId).catch(() => {});
				await vi.waitFor(() => expect(writing).toBe(true));
				await f.close();
				await running;
				expect(order).toEqual(["settled", "disposed", "disposed"]);
			} finally {
				release();
			}
		},
	);

	it("aborts work on disconnect and disposes idle and active runtimes after settlement", async () => {
		const calls: RuntimePrompt[] = [];
		const order: string[] = [];
		const dispose = vi.fn(async () => {
			order.push("dispose");
		});
		const f = open(() => ({
			prompt: async (request) => {
				calls.push(request);
				try {
					return await waitForAbort(request.signal);
				} finally {
					order.push("settled");
				}
			},
			dispose,
		}));
		await f.initialize();
		const { sessionId } = await f.newSession();
		await f.newSession();
		const running = f.prompt(sessionId).catch(() => {});
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		await f.close();
		await running;
		expect(calls[0].signal.aborted).toBe(true);
		expect(order).toEqual(["settled", "dispose", "dispose"]);
		const sessionCount = 2;
		expect(dispose).toHaveBeenCalledTimes(sessionCount);
	});
});

/** Integration contracts for persistence, runtime facilities, and async ownership. */
describe("native ACP full surface", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const open = (
		factory: OpenRuntimeSession,
		deps: Partial<NativeServerDeps> = {},
		app = client(),
	) => {
		const f = fixture(factory, async () => {}, { deps, clientApp: app });
		cleanup.push(f.close);
		return f;
	};
	const store = async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "d3r-acp-"));
		directories.push(dir);
		return createSessionStore(dir, { pageSize: 2 });
	};

	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((close) => close()));
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it("passes stdio/HTTP/SSE MCP, workspace roots, images and embedded resources without loss", async () => {
		const requests: RuntimePrompt[] = [];
		const factory = vi.fn<OpenRuntimeSession>(async () => ({
			...runtime(),
			prompt: async (request) => {
				requests.push(request);
				return "completed";
			},
		}));
		const f = open(factory);
		await f.initialize();
		const mcpServers: McpServer[] = [
			{
				name: "stdio",
				command: resolve("mcp-server"),
				args: ["--stdio"],
				env: [{ name: "TOKEN", value: "private-token" }],
			},
			{
				type: "http",
				name: "http",
				url: "https://example.test/mcp",
				headers: [{ name: "Authorization", value: "Bearer secret" }],
			},
			{
				type: "sse",
				name: "sse",
				url: "https://example.test/sse",
				headers: [],
			},
		];
		const { sessionId } = await f.peer.agent.request("session/new", {
			cwd: CWD,
			mcpServers,
			additionalDirectories: [resolve("extra")],
		});
		expect(factory.mock.calls[0][0]).toMatchObject({
			cwd: CWD,
			additionalDirectories: [resolve("extra")],
			mcpServers,
		});
		const prompt = [
			{ type: "image", mimeType: "image/png", data: "AA==" },
			{
				type: "resource",
				resource: {
					uri: "file:///text",
					text: "verbatim\ncontent",
					mimeType: "text/plain",
				},
			},
			{
				type: "resource",
				resource: {
					uri: "file:///binary",
					blob: "AP8=",
					mimeType: "application/octet-stream",
				},
			},
		];
		await f.peer.agent.request("session/prompt", { sessionId, prompt });
		const [image, embeddedText, binary] = requests[0].content;
		expect(requests[0].content).toHaveLength(prompt.length);
		expect(image).toEqual(prompt[0]);
		expect(embeddedText).toEqual({
			type: "text",
			text: JSON.stringify({
				uri: "file:///text",
				mimeType: "text/plain",
				text: "verbatim\ncontent",
			}),
		});
		expect(binary).toEqual({
			type: "text",
			text: JSON.stringify({
				uri: "file:///binary",
				mimeType: "application/octet-stream",
				encoding: "base64",
				blob: "AP8=",
			}),
		});
	});

	it("rejects malformed raw arrays, selectors, capabilities and unsupported variants before normalization", async () => {
		const prompt = vi.fn(async () => "completed" as const);
		const f = open(() => ({ ...runtime(), prompt }));
		await expect(
			f.peer.agent.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { terminal: "yes" },
			}),
		).rejects.toMatchObject({ code: -32_602 });
		await f.initialize();
		const { sessionId } = await f.newSession();
		await Promise.all(
			[
				[],
				[{ type: "text", text: "valid" }, { type: "text" }],
				[{ type: "image", data: "not base64", mimeType: "image/png" }],
				[{ type: "resource", resource: { uri: "file:///x" } }],
				[
					{
						type: "resource",
						resource: { uri: "file:///x", text: "x", blob: "AA==" },
					},
				],
				[{ type: "unknown" }],
			].map(async (blocks) => {
				await expect(
					f.peer.agent.request("session/prompt", { sessionId, prompt: blocks }),
				).rejects.toMatchObject({ code: -32_602 });
			}),
		);
		await expect(
			f.peer.agent.request("session/new", {
				cwd: CWD,
				mcpServers: [
					{
						type: "acp",
						name: "x",
						serverId: "x",
						command: resolve("x"),
						args: [],
						env: [],
					},
				],
			}),
		).rejects.toMatchObject({ code: -32_602 });
		expect(prompt).not.toHaveBeenCalled();
	});

	it("rejects invalid config without mutating and checkpoints failed and cancelled turns", async () => {
		const persistence = await store();
		const setConfig = vi.fn(async () => []);
		let state = 0;
		const f = open(
			() => ({
				...runtime(),
				snapshot: () => ({ state }),
				getConfig: () => [
					{
						id: "x",
						name: "X",
						category: "_d3r",
						value: "a",
						options: [{ value: "a", name: "A" }],
					},
				],
				setConfig,
				prompt: async (request) => {
					state += 1;
					if (state === 1) {
						throw new Error("private");
					}
					await waitForAbort(request.signal);
					return "completed";
				},
			}),
			{ store: persistence },
		);
		await f.initialize();
		const { sessionId } = await f.newSession();
		await Promise.all(
			[
				{ configId: "missing", value: "a" },
				{ configId: "x", value: "missing" },
				{ configId: "x", type: "boolean", value: true },
				{ configId: "x", type: "future", value: "a" },
			].map(async (params) => {
				await expect(
					f.peer.agent.request("session/set_config_option", {
						sessionId,
						...params,
					}),
				).rejects.toMatchObject({ code: -32_602 });
			}),
		);
		expect(setConfig).not.toHaveBeenCalled();
		await expect(f.prompt(sessionId)).rejects.toMatchObject({ code: -32_603 });
		const pending = f.prompt(sessionId);
		const turnCount = 2;
		await vi.waitFor(() => expect(state).toBe(turnCount));
		await f.peer.agent.notify("session/cancel", { sessionId });
		await pending;
		const saved = await persistence.get(sessionId);
		const checkpointCount = 3;
		expect(
			saved?.records.filter((row) => row.kind === "checkpoint"),
		).toHaveLength(checkpointCount);
	});

	it("gates persistence, rejects missing checkpoints and distinguishes request auth failures", async () => {
		const dispose = vi.fn(async () => {});
		const authenticated = { value: false };
		const authenticate = vi.fn(async () => {
			if (!authenticated.value) {
				throw nativeAuthRequired();
			}
		});
		const logout = vi.fn(async () => {
			authenticated.value = false;
		});
		const f = open(() => ({ ...runtime(), dispose }), {
			authenticate,
			logout,
			authMethods: [
				{ type: "terminal", id: "login", name: "Login", args: ["auth"] },
				{ id: "unsupported-agent-login", name: "No" },
			],
		});
		expect(authenticate).not.toHaveBeenCalled();
		const result = await f.peer.agent.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: { auth: { terminal: true } },
		});
		expect(result.authMethods).toEqual([
			{ type: "terminal", id: "login", name: "Login", args: ["auth"] },
		]);
		await expect(f.newSession()).rejects.toMatchObject({
			code: RequestError.authRequired().code,
		});
		await expect(
			f.peer.agent.request("authenticate", { methodId: "login" }),
		).rejects.toMatchObject({ code: -32_602 });
		authenticated.value = true;
		await f.newSession();
		await expect(
			f.peer.agent.request("session/list", {}),
		).rejects.toMatchObject({ code: -32_601 });
		await f.peer.agent.request("logout", {});
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(logout).toHaveBeenCalledTimes(1);
		await expect(f.newSession()).rejects.toMatchObject({
			code: RequestError.authRequired().code,
		});
		const g = open(() => ({ prompt: async () => "completed", dispose }), {
			store: await store(),
		});
		await g.initialize();
		await expect(g.newSession()).rejects.toMatchObject({ code: -32_603 });
		const createdRuntimeCount = 2;
		expect(dispose).toHaveBeenCalledTimes(createdRuntimeCount);
		const h = open(async () => {
			throw nativeAuthRequired();
		});
		await h.initialize();
		await expect(h.newSession()).rejects.toMatchObject({
			code: RequestError.authRequired().code,
		});
	});

	it("waits for async factory completion on disconnect and disposes its late runtime once", async () => {
		let release: (runtime: RuntimeSession) => void = vi.fn();
		const factory = vi.fn(
			() =>
				new Promise<RuntimeSession>((resolveRuntime) => {
					release = resolveRuntime;
				}),
		);
		const dispose = vi.fn(async () => {});
		const f = open(factory);
		await f.initialize();
		const creating = f.newSession().catch(() => {});
		await vi.waitFor(() => expect(factory).toHaveBeenCalled());
		let closed = false;
		const closing = f.close().then(() => {
			closed = true;
		});
		await setImmediate();
		expect(closed).toBe(false);
		release({ ...runtime(), dispose });
		await closing;
		await creating;
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("closes a live prompt before disposal and releases its store lease for resume", async () => {
		const persistence = await store();
		const events: string[] = [];
		const f = open(
			() => ({
				...runtime(),
				prompt: async (request) => {
					events.push("prompt");
					try {
						return await waitForAbort(request.signal);
					} finally {
						events.push("settled");
					}
				},
				dispose: async () => {
					events.push("dispose");
				},
			}),
			{ store: persistence },
		);
		await f.initialize();
		const { sessionId } = await f.newSession();
		const pending = f.prompt(sessionId);
		await vi.waitFor(() => expect(events).toEqual(["prompt"]));
		await f.peer.agent.request("session/close", { sessionId });
		await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
		expect(events).toEqual(["prompt", "settled", "dispose"]);
		await f.peer.agent.request("session/resume", { sessionId, cwd: CWD });
	});

	it("negotiates permission/fs/terminal/form services and stores terminal output for replay", async () => {
		const persistence = await store();
		const events: string[] = [];
		const app = client()
			.onRequest("session/request_permission", ({ params }) => {
				expect(params.options.map((option) => option.kind)).toEqual([
					"allow_once",
					"reject_once",
				]);
				return { outcome: { outcome: "selected", optionId: "allow" } };
			})
			.onRequest("fs/read_text_file", () => ({ content: "file text" }))
			.onRequest("fs/write_text_file", ({ params }) => {
				expect(params.content).toBe("new text");
				return {};
			})
			.onRequest("terminal/create", ({ params }) => {
				expect(params.args).toEqual(["a b"]);
				events.push("create");
				return { terminalId: "t" };
			})
			.onRequest("terminal/wait_for_exit", () => {
				events.push("wait");
				return { exitCode: 0 };
			})
			.onRequest("terminal/output", () => {
				events.push("output");
				return { output: "terminal text", truncated: false };
			})
			.onRequest("terminal/release", () => {
				events.push("release");
				return {};
			})
			.onRequest("elicitation/create", ({ params }) => {
				expect(params.mode).toBe("form");
				return { action: "accept", content: { answer: "yes" } };
			});
		const f = open(
			(input) => ({
				...runtime(),
				prompt: async (request) => {
					const services = input.client!;
					expect(
						await services.requestPermission(
							{ toolCallId: "tool", title: "Run", kind: "execute", input: {} },
							request.signal,
						),
					).toBe(true);
					expect(
						await services.readTextFile!(resolve("file"), request.signal),
					).toBe("file text");
					await services.writeTextFile!(
						resolve("file"),
						"new text",
						request.signal,
					);
					expect(await services.ask!("Continue?", request.signal)).toBe("yes");
					const result = await services.runCommand!(
						{ command: "echo", args: ["a b"], cwd: CWD },
						request.signal,
					);
					expect(result).toEqual({
						terminalId: "t",
						output: "terminal text",
						exitCode: 0,
					});
					expect(events).not.toContain("release");
					await request.activity!({
						kind: "tool",
						toolCallId: "tool",
						title: "Run",
						toolKind: "execute",
						status: "completed",
						content: [{ type: "terminal", terminalId: result.terminalId! }],
					});
					return "completed";
				},
			}),
			{ store: persistence },
			app,
		);
		await f.peer.agent.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: true,
				elicitation: { form: {} },
			},
		});
		const { sessionId } = await f.newSession();
		await f.prompt(sessionId);
		expect(events).toEqual(["create", "wait", "output", "release"]);
		expect(f.updates[0].update).toMatchObject({
			content: [{ type: "terminal", terminalId: "t" }],
		});
		const saved = await persistence.get(sessionId);
		expect(saved?.records).toContainEqual({
			kind: "update",
			update: expect.objectContaining({
				sessionUpdate: "tool_call",
				content: [
					{ type: "content", content: { type: "text", text: "terminal text" } },
				],
			}),
		});
	});

	it.each([
		["permission", "permission"],
		["terminal", "wait"],
		["late-terminal", "create"],
		["form", "form"],
	] as const)(
		"cancels a blocked %s client without waiting for its cooperative response",
		async (kind, expectedEvent) => {
			const events: string[] = [];
			let release: (value: { terminalId: string }) => void = vi.fn();
			const never = new Promise<never>(() => {});
			const app = client()
				.onRequest("session/request_permission", () => {
					events.push("permission");
					return never;
				})
				.onRequest("terminal/create", () => {
					events.push("create");
					return kind === "late-terminal"
						? new Promise<{ terminalId: string }>((resolveTerminal) => {
								release = resolveTerminal;
							})
						: { terminalId: "t" };
				})
				.onRequest("terminal/wait_for_exit", () => {
					events.push("wait");
					return never;
				})
				.onRequest("terminal/kill", () => {
					events.push("kill");
					return {};
				})
				.onRequest("terminal/output", () => ({
					output: "partial",
					truncated: false,
				}))
				.onRequest("terminal/release", () => {
					events.push("release");
					return {};
				})
				.onRequest("elicitation/create", () => {
					events.push("form");
					return never;
				});
			const f = open(
				(input) => ({
					...runtime(),
					prompt: async (request) => {
						if (kind === "permission") {
							await input.client!.requestPermission(
								{ toolCallId: "t", title: "Tool", kind: "other", input: {} },
								request.signal,
							);
						} else if (kind === "form") {
							expect(
								await input.client!.ask!("Question", request.signal),
							).toBeNull();
						} else {
							await input.client!.runCommand!(
								{ command: "cmd", args: [], cwd: CWD },
								request.signal,
							);
						}
						return "completed";
					},
				}),
				{},
				app,
			);
			await f.peer.agent.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { terminal: true, elicitation: { form: {} } },
			});
			const { sessionId } = await f.newSession();
			const pending = f.prompt(sessionId);
			await vi.waitFor(() => expect(events).toContain(expectedEvent));
			await f.peer.agent.notify("session/cancel", { sessionId });
			await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
			if (kind === "late-terminal") {
				release({ terminalId: "late" });
			}
			if (kind.includes("terminal")) {
				const cleanupEvents = ["kill", "release"];
				await vi.waitFor(() =>
					expect(events.slice(-cleanupEvents.length)).toEqual(cleanupEvents),
				);
			}
		},
	);

	it("cancels a prompt while its request-time credential check is still pending", async () => {
		let blocked = false;
		let checking = false;
		let release: () => void = vi.fn();
		const prompt = vi.fn(async () => "completed" as const);
		const f = open(() => ({ ...runtime(), prompt }), {
			authenticate: async () => {
				if (blocked) {
					checking = true;
					await new Promise<void>((done) => {
						release = done;
					});
				}
			},
		});
		await f.initialize();
		const { sessionId } = await f.newSession();
		blocked = true;
		const running = f.prompt(sessionId);
		await vi.waitFor(() => expect(checking).toBe(true));
		await f.peer.agent.notify("session/cancel", { sessionId });
		await expect(running).resolves.toEqual({ stopReason: "cancelled" });
		expect(prompt).not.toHaveBeenCalled();
		release();
		blocked = false;
		await expect(f.prompt(sessionId)).resolves.toEqual({
			stopReason: "end_turn",
		});
	});

	it("does not persist transient MCP credentials even when echoed by a runtime", async () => {
		const persistence = await store();
		const f = open(
			() => ({
				...runtime(),
				snapshot: () => ({
					messages: ["private-mcp-token"],
					credentials: "provider-secret",
				}),
				prompt: async (request) => {
					await request.activity!({
						kind: "tool",
						toolCallId: "t",
						title: "Call",
						toolKind: "fetch",
						status: "completed",
						rawOutput: {
							text: "private-mcp-token",
							headers: { Authorization: "provider-secret" },
						},
					});
					return "completed";
				},
			}),
			{ store: persistence },
		);
		await f.initialize();
		const { sessionId } = await f.peer.agent.request("session/new", {
			cwd: CWD,
			mcpServers: [
				{
					name: "tools",
					command: resolve("tools"),
					args: [],
					env: [{ name: "KEY", value: "private-mcp-token" }],
				},
			],
		});
		await f.prompt(sessionId);
		const saved = await persistence.get(sessionId);
		expect(JSON.stringify(saved)).not.toMatch(
			/private-mcp-token|provider-secret|mcpServers|Authorization/,
		);
	});

	it("cancels blocked history replay and releases its lease without deleting history", async () => {
		const persistence = await store();
		const f = open(
			() => ({
				...runtime(),
				prompt: async (request) => {
					await request.emit({ kind: "text", messageId: "m", text: "Saved" });
					return "completed";
				},
			}),
			{ store: persistence },
		);
		await f.initialize();
		const { sessionId } = await f.newSession();
		await f.prompt(sessionId);
		await f.close();
		const dispose = vi.fn(async () => {});
		let stalled = false;
		let writing = false;
		let release: () => void = vi.fn();
		const blocked = new Promise<void>((done) => {
			release = done;
		});
		const g = fixture(
			() => ({ ...runtime(), dispose }),
			async () => {
				if (stalled) {
					writing = true;
					await blocked;
				}
			},
			{ deps: { store: persistence } },
		);
		cleanup.push(g.close);
		await g.initialize();
		stalled = true;
		const loading = g.peer.agent
			.request("session/load", { sessionId, cwd: CWD, mcpServers: [] })
			.catch(() => {});
		try {
			await vi.waitFor(() => expect(writing).toBe(true));
			await g.close();
			await loading;
			expect(dispose).toHaveBeenCalledTimes(1);
			const h = open(runtime, { store: persistence });
			await h.initialize();
			await h.peer.agent.request("session/load", {
				sessionId,
				cwd: CWD,
				mcpServers: [],
			});
			expect(h.updates).toContainEqual({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					messageId: "m",
					content: { type: "text", text: "Saved" },
				},
			});
		} finally {
			release();
		}
	});

	it("does not expose unnegotiated facilities or accept unrecognized permission/elicitation answers", async () => {
		const f = open(
			(input) => ({
				...runtime(),
				prompt: async (request) => {
					expect(input.client?.readTextFile).toBeUndefined();
					expect(input.client?.writeTextFile).toBeUndefined();
					expect(input.client?.runCommand).toBeUndefined();
					expect(
						await input.client!.ask!("Question", request.signal),
					).toBeNull();
					expect(
						await input.client!.requestPermission(
							{ toolCallId: "t", title: "Tool", kind: "other", input: {} },
							request.signal,
						),
					).toBe(false);
					return "completed";
				},
			}),
			{},
			client().onRequest("session/request_permission", () => ({
				outcome: { outcome: "selected", optionId: "unknown" },
			})),
		);
		await f.initialize();
		const { sessionId } = await f.newSession();
		await f.prompt(sessionId);
	});
});
