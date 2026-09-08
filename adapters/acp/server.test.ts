import {
	client,
	ndJsonStream,
	RequestError,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { connectNativeServer } from "@d3r/adapter-acp/server";
import {
	type CreateRuntimeSession,
	type RuntimePrompt,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Host-native absolute paths keep protocol tests portable. */
const CWD = resolve("workspace-a");

/** Build a cancellable fake that cannot settle before the caller aborts it. */
const waitForAbort = (signal: AbortSignal): Promise<never> =>
	new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
		} else {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		}
	});

/** Exercise our handlers through the SDK and newline-delimited byte streams. */
const fixture = (
	createSession: CreateRuntimeSession,
	beforeWrite: () => Promise<void> = async () => {},
) => {
	const incoming = new TransformStream<Uint8Array>();
	const outgoing = new TransformStream<Uint8Array>();
	const updates: SessionNotification[] = [];
	const transport = ndJsonStream(outgoing.writable, incoming.readable);
	const writer = transport.writable.getWriter();
	const server = connectNativeServer(
		{
			readable: transport.readable,
			writable: new WritableStream({
				write: async (message) => {
					await beforeWrite();
					await writer.write(message);
				},
			}),
		},
		{ version: "test-version", createSession },
	);
	const peer = client()
		.onNotification("session/update", ({ params }) => {
			updates.push(params);
		})
		.connect(ndJsonStream(incoming.writable, outgoing.readable));
	return {
		server,
		peer,
		updates,
		initialize: () => peer.agent.request("initialize", { protocolVersion: 1 }),
		newSession: (cwd = CWD) =>
			peer.agent.request("session/new", { cwd, mcpServers: [] }),
		prompt: (sessionId: string) =>
			peer.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "hello" }],
			}),
		close: async () => {
			peer.close();
			server.connection.close();
			await server.closed;
		},
	};
};

/** Contract tests for native session ownership rather than SDK internals. */
describe("native ACP session foundation", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const open = (
		createSession: CreateRuntimeSession = () => ({
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
			agentCapabilities: {},
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
			[{ sessionId: first.sessionId, cwd: CWD }],
			[{ sessionId: second.sessionId, cwd: otherCwd }],
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
				mcpServers: [{ name: "tools", command: "/server", args: [], env: [] }],
			},
			{ cwd: CWD, mcpServers: [], additionalDirectories: [resolve("extra")] },
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
				prompt: [{ type: "image", mimeType: "image/png", data: "AA==" }],
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
