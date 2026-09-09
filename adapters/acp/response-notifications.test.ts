import {
	ndJsonStream,
	RequestError,
	type AnyMessage,
	type AnyNotification,
	type JsonRpcId,
} from "@agentclientprotocol/sdk";
import {
	connectNativeServer,
	createSessionStore,
	type NativeServerDeps,
} from "@d3r/adapter-acp/server";
import { type RuntimeSessionInput } from "@d3r/core/runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { responseNotifications } from "./response-notifications.ts";
import { CWD, deferred, fixture, runtime } from "./test-support.ts";

/** Distinguish absent hints from explicit empty hints without depending on the core command list. */
const commands = [
	{ name: "explain", description: "Explain", inputHint: "topic" },
	{ name: "status", description: "Status" },
	{ name: "empty", description: "Empty", inputHint: "" },
];
/** Expected ACP menu is independent of the production mapper. */
const availableCommands = [
	{ name: "explain", description: "Explain", input: { hint: "topic" } },
	{ name: "status", description: "Status" },
	{ name: "empty", description: "Empty", input: { hint: "" } },
];
/** Every deferred row is a payload, never a callback into a live runtime. */
const notification = (sessionId = "session"): AnyNotification => ({
	jsonrpc: "2.0",
	method: "session/update",
	params: {
		sessionId,
		update: { sessionUpdate: "available_commands_update", availableCommands },
	},
});
/** Observe the wrapper's ordered output with controllable sink backpressure. */
const outputFixture = (
	write: (message: AnyMessage) => Promise<void> = async () => {},
) => {
	const messages: AnyMessage[] = [];
	const output = responseNotifications({
		readable: new ReadableStream(),
		writable: new WritableStream({
			write: async (message) => {
				messages.push(message);
				await write(message);
			},
		}),
	});
	const writer = output.stream.writable.getWriter();
	const defer = (
		id: JsonRpcId,
		value = notification(),
		signal = new AbortController().signal,
	) => output.defer(id, value, signal);
	return { output, writer, messages, defer };
};

/** The adapter, rather than SDK scheduling or elapsed time, owns response/notification order. */
describe("response notifications", () => {
	it("matches IDs by value and type, snapshots payloads, and leaves unrelated traffic alone", async () => {
		const f = outputFixture();
		const original = notification();
		f.defer(1, original);
		f.defer("1", notification("string"));
		f.defer(null, notification("null"));
		original.params = {};
		const request: AnyMessage = {
			jsonrpc: "2.0",
			id: 1,
			method: "client/request",
		};
		const update = notification("unrelated");
		const responses = ["1", null, 1].map((id) => ({
			jsonrpc: "2.0" as const,
			id,
			result: {},
		}));
		const [stringResponse, nullResponse, numberResponse] = responses;
		await f.writer.write(request);
		await f.writer.write(update);
		await Promise.all(responses.map((response) => f.writer.write(response)));
		expect(f.messages).toEqual([
			request,
			update,
			stringResponse,
			notification("string"),
			nullResponse,
			notification("null"),
			numberResponse,
			notification(),
		]);
		expect(f.output.pendingCount()).toBe(0);
		await f.writer.close();
	});

	it("drops notifications for error and cancelled responses", async () => {
		const f = outputFixture();
		const cancellation = new AbortController();
		f.defer("failed");
		f.defer("cancelled", notification(), cancellation.signal);
		cancellation.abort();
		const error: AnyMessage = {
			jsonrpc: "2.0",
			id: "failed",
			error: RequestError.internalError().toErrorResponse(),
		};
		const cancelled: AnyMessage = {
			jsonrpc: "2.0",
			id: "cancelled",
			result: {},
		};
		await f.writer.write(error);
		await f.writer.write(cancelled);
		expect(f.messages).toEqual([error, cancelled]);
		expect(f.output.pendingCount()).toBe(0);
		await f.writer.close();
	});

	it("awaits both writes before allowing later output past the menu", async () => {
		const responseGate = deferred<void>();
		const menuGate = deferred<void>();
		const responseStarted = deferred<void>();
		const menuStarted = deferred<void>();
		const f = outputFixture(async (message) => {
			if ("id" in message && message.id === "new") {
				responseStarted.resolve();
				await responseGate.promise;
			} else if ("method" in message) {
				menuStarted.resolve();
				await menuGate.promise;
			}
		});
		f.defer("new");
		const response: AnyMessage = { jsonrpc: "2.0", id: "new", result: {} };
		const later: AnyMessage = { jsonrpc: "2.0", id: "later", result: {} };
		const finished = vi.fn();
		const writing = f.writer.write(response).then(finished);
		const queued = f.writer.write(later);
		await responseStarted.promise;
		expect(f.messages).toEqual([response]);
		responseGate.resolve();
		await menuStarted.promise;
		expect(f.messages).toEqual([response, notification()]);
		expect(finished).not.toHaveBeenCalled();
		menuGate.resolve();
		await Promise.all([writing, queued]);
		expect(f.messages).toEqual([response, notification(), later]);
		await f.writer.close();
	});

	it("keeps menus associated with their response when the peer reuses a request ID", async () => {
		const delivered = deferred<void>();
		const gate = deferred<void>();
		const first: AnyMessage = {
			jsonrpc: "2.0",
			id: "reused",
			result: { sessionId: "first" },
		};
		const second: AnyMessage = {
			jsonrpc: "2.0",
			id: "reused",
			result: { sessionId: "second" },
		};
		const f = outputFixture(async (message) => {
			if (message === first) {
				delivered.resolve();
				await gate.promise;
			}
		});
		f.defer("reused", notification("first"));
		const firstWrite = f.writer.write(first);
		await delivered.promise;
		f.defer("reused", notification("second"));
		const secondWrite = f.writer.write(second);
		gate.resolve();
		await Promise.all([firstWrite, secondWrite]);
		expect(f.messages).toEqual([
			first,
			notification("first"),
			second,
			notification("second"),
		]);
		expect(f.output.pendingCount()).toBe(0);
		await f.writer.close();
	});

	it("suppresses commands cancelled while their successful response is backpressured", async () => {
		const gate = deferred<void>();
		const started = deferred<void>();
		const cancellation = new AbortController();
		const f = outputFixture(async () => {
			started.resolve();
			await gate.promise;
		});
		f.defer("new", notification(), cancellation.signal);
		const response: AnyMessage = { jsonrpc: "2.0", id: "new", result: {} };
		const writing = f.writer.write(response);
		await started.promise;
		cancellation.abort();
		gate.resolve();
		await writing;
		expect(f.messages).toEqual([response]);
		expect(f.output.pendingCount()).toBe(0);
		await f.writer.close();
	});

	it.each(["response", "notification"] as const)(
		"clears all pending rows when the %s write fails",
		async (stage) => {
			const failure = new Error("broken pipe");
			const f = outputFixture(async (message) => {
				if ("method" in message === (stage === "notification")) {
					throw failure;
				}
			});
			f.defer("new");
			f.defer("other");
			await expect(
				f.writer.write({ jsonrpc: "2.0", id: "new", result: {} }),
			).rejects.toBe(failure);
			expect(f.output.pendingCount()).toBe(0);
			f.defer("late");
			expect(f.output.pendingCount()).toBe(0);
		},
	);

	it.each([
		["response", "resolve"],
		["response", "reject"],
		["notification", "resolve"],
		["notification", "reject"],
	] as const)(
		"clears and releases stalled %s output on close even if it later %ss",
		async (stage, settlement) => {
			const gate = deferred<void>();
			const started = deferred<void>();
			const f = outputFixture(async (message) => {
				if ("method" in message === (stage === "notification")) {
					started.resolve();
					await gate.promise;
				}
			});
			f.defer("new");
			f.defer("other");
			const writing = f.writer.write({ jsonrpc: "2.0", id: "new", result: {} });
			await started.promise;
			const reason = new Error("disconnected");
			f.output.close(reason);
			await expect(writing).rejects.toBe(reason);
			expect(f.output.pendingCount()).toBe(0);
			f.defer("late");
			expect(f.output.pendingCount()).toBe(0);
			if (settlement === "resolve") {
				gate.resolve();
			} else {
				gate.reject(new Error("late write failure"));
			}
			await gate.promise.catch(() => {});
			expect(f.messages.filter((message) => "method" in message)).toHaveLength(
				stage === "response" ? 0 : 1,
			);
		},
	);

	it.each(["close", "abort"] as const)(
		"clears unflushed rows on writable %s",
		async (method) => {
			const f = outputFixture();
			f.defer("new");
			await f.writer[method]();
			expect(f.output.pendingCount()).toBe(0);
			expect(f.messages).toEqual([]);
		},
	);
});

/** Parse only the wire fields this client needs, keeping full update payloads for assertions. */
const wireSchema = z.object({
	id: z.union([z.string(), z.number(), z.null()]).optional(),
	result: z
		.object({ sessionId: z.string().optional() })
		.passthrough()
		.optional(),
	error: z.object({ code: z.number() }).optional(),
	method: z.string().optional(),
	params: z
		.object({
			sessionId: z.string(),
			update: z.object({ sessionUpdate: z.string() }).passthrough(),
		})
		.optional(),
});
/** Raw clients cannot discover a new session ID from an ignored early notification. */
type WireMessage = z.infer<typeof wireSchema>;
/** Model Zed registration using raw NDJSON, not an SDK client that accepts unknown IDs. */
const wireClient = (deps: Omit<NativeServerDeps, "version">) => {
	const incoming = new TransformStream<Uint8Array>();
	const input = incoming.writable.getWriter();
	const waiting = new Map<
		JsonRpcId,
		ReturnType<typeof deferred<WireMessage>>
	>();
	const registered = new Set<string>();
	const messages: WireMessage[] = [];
	const accepted: NonNullable<WireMessage["params"]>[] = [];
	const dropped: WireMessage[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	const output = new WritableStream<Uint8Array>({
		write: (chunk) => {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop()!;
			lines.forEach((line) => {
				const message = wireSchema.parse(JSON.parse(line));
				messages.push(message);
				if (message.id !== undefined) {
					if (message.result?.sessionId) {
						registered.add(message.result.sessionId);
					}
					waiting.get(message.id)?.resolve(message);
					waiting.delete(message.id);
				} else if (message.params) {
					if (registered.has(message.params.sessionId)) {
						accepted.push(message.params);
					} else {
						dropped.push(message);
					}
				}
			});
		},
	});
	const server = connectNativeServer(ndJsonStream(output, incoming.readable), {
		version: "test",
		...deps,
	});
	const send = (message: AnyMessage) =>
		input.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
	const request = async (id: JsonRpcId, method: string, params: unknown) => {
		const result = deferred<WireMessage>();
		waiting.set(id, result);
		await send({ jsonrpc: "2.0", id, method, params });
		return result.promise;
	};
	return {
		server,
		messages,
		accepted,
		dropped,
		registered,
		request,
		send,
		initialize: () =>
			request("initialize", "initialize", { protocolVersion: 1 }),
		// An unrelated response is a deterministic output barrier, not a prompt or menu refresh.
		barrier: () => request("barrier", "initialize", { protocolVersion: 1 }),
		close: async () => {
			server.connection.close();
			await server.closed;
		},
	};
};

/** These integration checks fail if activation publishes before the first response again. */
describe("native ACP command discovery on the wire", () => {
	it("populates the first thread menu after session/new without prompting", async () => {
		const prompt = vi.fn(runtime().prompt);
		const f = wireClient({
			createSession: () => ({
				...runtime(),
				prompt,
				getCommands: () => commands,
			}),
		});
		try {
			await f.initialize();
			const response = await f.request("new", "session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			await f.barrier();
			expect(response.result?.sessionId).toEqual(expect.any(String));
			expect(
				f.messages.slice(1).map((message) => message.id ?? message.method),
			).toEqual(["new", "session/update", "barrier"]);
			expect(f.accepted).toEqual([
				{
					sessionId: response.result?.sessionId,
					update: {
						sessionUpdate: "available_commands_update",
						availableCommands,
					},
				},
			]);
			expect(f.dropped).toEqual([]);
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});

	it.each(["absent", "empty"] as const)(
		"preserves an %s runtime command list",
		async (kind) => {
			const f = wireClient({
				createSession: () => ({
					...runtime(),
					...(kind === "empty" ? { getCommands: () => [] } : {}),
				}),
			});
			try {
				await f.initialize();
				await f.request("new", "session/new", { cwd: CWD, mcpServers: [] });
				await f.barrier();
				expect(f.accepted.map((row) => row.update)).toEqual(
					kind === "empty"
						? [
								{
									sessionUpdate: "available_commands_update",
									availableCommands: [],
								},
							]
						: [],
				);
			} finally {
				await f.close();
			}
		},
	);

	it.each(["session/load", "session/resume"] as const)(
		"preserves pre-response commands and replay policy for %s",
		async (method) => {
			const dir = await mkdtemp(join(tmpdir(), "d3r-command-discovery-"));
			const store = createSessionStore(dir);
			const f = wireClient({
				store,
				createSession: () => ({ ...runtime(), getCommands: () => commands }),
			});
			try {
				await f.initialize();
				const created = await f.request("new", "session/new", {
					cwd: CWD,
					mcpServers: [],
				});
				const sessionId = created.result!.sessionId!;
				await f.request("close", "session/close", { sessionId });
				const stored = (await store.get(sessionId))!;
				const replay = {
					sessionUpdate: "agent_message_chunk" as const,
					content: { type: "text" as const, text: "history" },
				};
				await store.save({
					...stored,
					records: [{ kind: "update", update: replay }, ...stored.records],
				});
				f.messages.length = 0;
				f.accepted.length = 0;
				await f.request("restore", method, {
					sessionId,
					cwd: CWD,
					mcpServers: [],
				});
				expect(f.accepted.map((row) => row.update)).toEqual([
					...(method === "session/load" ? [replay] : []),
					{ sessionUpdate: "available_commands_update", availableCommands },
				]);
				expect(
					f.messages.map((message) => message.id ?? message.method),
				).toEqual([
					...(method === "session/load" ? ["session/update"] : []),
					"session/update",
					"restore",
				]);
				expect(f.dropped).toEqual([]);
			} finally {
				await f.close();
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("emits no commands and disposes the runtime when command discovery fails", async () => {
		const dispose = vi.fn(async () => {});
		const f = wireClient({
			createSession: () => ({
				...runtime(),
				dispose,
				getCommands: () => {
					throw new Error("discovery failed");
				},
			}),
		});
		try {
			await f.initialize();
			const response = await f.request("new", "session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			await f.barrier();
			expect(response.error?.code).toBe(RequestError.internalError().code);
			expect(f.messages.filter((message) => message.method)).toEqual([]);
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});

	it("emits no commands for a cancelled create even when its runtime returns successfully", async () => {
		const started = deferred<RuntimeSessionInput>();
		const gate = deferred<void>();
		const dispose = vi.fn(async () => {});
		const f = wireClient({
			createSession: async (input) => {
				started.resolve(input);
				await gate.promise;
				return { ...runtime(), dispose, getCommands: () => commands };
			},
		});
		try {
			await f.initialize();
			const creating = f.request("new", "session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			const input = await started.promise;
			await f.send({
				jsonrpc: "2.0",
				method: "$/cancel_request",
				params: { requestId: "new" },
			});
			await f.barrier();
			expect(input.signal?.aborted).toBe(true);
			gate.resolve();
			const response = await creating;
			expect(response.error?.code).toBe(RequestError.requestCancelled().code);
			await f.barrier();
			expect(f.messages.filter((message) => message.method)).toEqual([]);
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve();
			await f.close();
		}
	});

	it.each(["response", "notification"] as const)(
		"disposes without waiting for stalled %s output on disconnect",
		async (stage) => {
			const dispose = vi.fn(async () => {});
			const gate = deferred<void>();
			const started = deferred<void>();
			let writes = 0;
			const notificationWrite = 2;
			const pauseAt = stage === "response" ? 1 : notificationWrite;
			const f = fixture(
				() => ({ ...runtime(), dispose, getCommands: () => commands }),
				async () => {
					if (writes++ === pauseAt) {
						started.resolve();
						await gate.promise;
					}
				},
			);
			try {
				await f.initialize();
				const creating = f.newSession().catch(() => {});
				await started.promise;
				await f.close();
				await creating;
				expect(dispose).toHaveBeenCalledTimes(1);
			} finally {
				gate.resolve();
				await f.close();
			}
		},
	);

	it.each(["response", "notification"] as const)(
		"disposes the runtime when deferred %s output fails",
		async (stage) => {
			const dispose = vi.fn(async () => {});
			let writes = 0;
			const notificationWrite = 2;
			const failAt = stage === "response" ? 1 : notificationWrite;
			const f = fixture(
				() => ({ ...runtime(), dispose, getCommands: () => commands }),
				async () => {
					if (writes++ === failAt) {
						throw new Error("broken pipe");
					}
				},
			);
			try {
				await f.initialize();
				const creating = f.newSession().catch(() => {});
				await f.server.closed;
				expect(dispose).toHaveBeenCalledTimes(1);
				f.peer.close();
				await creating;
			} finally {
				await f.close();
			}
		},
	);
});
