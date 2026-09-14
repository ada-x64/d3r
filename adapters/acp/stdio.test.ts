import { RequestError } from "@agentclientprotocol/sdk";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { type RuntimePrompt, type RuntimeSession } from "@d3r/core/runtime";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runNativeStdio } from "./stdio.ts";
import { createSessionStore, type SessionStore } from "./store.ts";
import { deferred, runtime, waitForAbort } from "./test-support.ts";

/** Independently specified shell statuses for the wrapper's signal contract. */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;
/** Split inside the JSON prefix to exercise partial reads rather than complete frames. */
const FRAME_SPLIT = 7;
/** Exercise actual byte framing, not SDK-normalized request objects. */
const fixture = (createSession: () => RuntimeSession, store?: SessionStore) => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const signals = new EventEmitter();
	let output = "";
	stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	const running = runNativeStdio({
		version: "stdio-test",
		agentInfo: { name: "native-test", title: "Native test" },
		createSession,
		store,
		stdin,
		stdout,
		signals,
	});
	const messages = (): {
		id?: string;
		result?: Record<string, unknown>;
		error?: { code: number };
		method?: string;
	}[] =>
		output
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	const send = (id: string, method: string, params: unknown) => {
		const text = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		stdin.write(text.slice(0, FRAME_SPLIT));
		stdin.write(text.slice(FRAME_SPLIT));
	};
	const request = async (id: string, method: string, params: unknown) => {
		send(id, method, params);
		await vi.waitFor(() =>
			expect(messages().some((message) => message.id === id)).toBe(true),
		);
		return messages().find((message) => message.id === id)!;
	};
	return { stdin, stdout, signals, running, send, request, messages };
};

/** Hold both prompt settlement and disposal so disconnect cannot release a lease early. */
const pendingFixture = async () => {
	const dir = await mkdtemp(join(tmpdir(), "d3r-stdio-"));
	const store = createSessionStore(dir);
	const calls: RuntimePrompt[] = [];
	const cleanup = deferred<void>();
	const disposal = deferred<void>();
	const settled = vi.fn();
	const done = vi.fn();
	const dispose = vi.fn(() => disposal.promise);
	const f = fixture(
		() => ({
			...runtime(),
			dispose,
			prompt: async (request) => {
				calls.push(request);
				await waitForAbort(request.signal).catch(() => {});
				await cleanup.promise;
				settled();
				return "completed";
			},
		}),
		store,
	);
	const close = async () => {
		cleanup.resolve();
		disposal.resolve();
		f.signals.emit("SIGTERM");
		await f.running;
		await rm(dir, { recursive: true, force: true });
	};
	void f.running.then(done);
	try {
		await f.request("initialize", "initialize", { protocolVersion: 1 });
		const created = await f.request("new", "session/new", {
			cwd: resolve("workspace"),
			mcpServers: [],
		});
		const sessionId = created.result?.sessionId as string;
		f.send("prompt", "session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "hi" }],
		});
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		return {
			...f,
			store,
			sessionId,
			signal: calls[0].signal,
			cleanup,
			disposal,
			settled,
			done,
			dispose,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
};

/** CLI composition owns exit codes; the wrapper owns transport and resource shutdown. */
describe("native stdio wrapper", () => {
	it("uses caller metadata, rejects malformed raw content and cleans up on EOF", async () => {
		const dispose = vi.fn(async () => {});
		const prompt = vi.fn(async (request: RuntimePrompt) => {
			await request.emit({
				kind: "text",
				messageId: "m",
				text: "hello\nworld",
			});
			return "completed" as const;
		});
		const f = fixture(() => ({ prompt, dispose }));
		try {
			const initialized = await f.request("initialize", "initialize", {
				protocolVersion: 1,
			});
			expect(initialized.result?.agentInfo).toEqual({
				name: "native-test",
				title: "Native test",
				version: "stdio-test",
			});
			const created = await f.request("new", "session/new", {
				cwd: resolve("workspace"),
				mcpServers: [],
			});
			const sessionId = created.result?.sessionId;
			const invalid = await f.request("invalid", "session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "valid" }, { type: "text" }],
			});
			expect(invalid.error?.code).toBe(RequestError.invalidParams().code);
			expect(prompt).not.toHaveBeenCalled();
			const prompted = await f.request("prompt", "session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "hi" }],
			});
			expect(prompted.result).toEqual({ stopReason: "end_turn" });
			expect(
				f.messages().filter((row) => row.method === "session/update"),
			).toHaveLength(1);
			f.stdin.end();
			await expect(f.running).resolves.toBe(0);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(f.signals.listenerCount("SIGINT")).toBe(0);
			expect(f.signals.listenerCount("SIGTERM")).toBe(0);
			expect(f.stdout.writableEnded).toBe(false);
		} finally {
			f.signals.emit("SIGTERM");
			await f.running;
		}
	});

	it.each([
		{ cause: "stdout close", code: 1 },
		{ cause: "stdin close", code: 1 },
		{ cause: "EOF", code: 0 },
		{ cause: "SIGINT", code: SIGNAL_EXIT.SIGINT },
		{ cause: "SIGTERM", code: SIGNAL_EXIT.SIGTERM },
	] as const)(
		"aborts on $cause, waits for cleanup before unlocking and ignores late closes",
		async ({ cause, code }) => {
			const f = await pendingFixture();
			try {
				const outputClosed = once(f.stdout, "close");
				if (cause === "stdout close") {
					expect(f.stdin.destroyed).toBe(false);
					expect(f.stdin.writableEnded).toBe(false);
					f.stdout.destroy();
				} else if (cause === "stdin close") {
					f.stdin.destroy();
				} else if (cause === "EOF") {
					f.stdin.end();
				} else {
					f.signals.emit(cause);
				}
				await vi.waitFor(() => expect(f.signal.aborted).toBe(true));
				f.stdout.destroy();
				await outputClosed;
				expect(f.settled).not.toHaveBeenCalled();
				expect(f.dispose).not.toHaveBeenCalled();
				expect(f.done).not.toHaveBeenCalled();
				await expect(f.store.acquire(f.sessionId)).rejects.toMatchObject({
					code: RequestError.invalidRequest().code,
				});
				f.cleanup.resolve();
				await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledTimes(1));
				expect(f.settled).toHaveBeenCalledTimes(1);
				expect(f.done).not.toHaveBeenCalled();
				await expect(f.store.acquire(f.sessionId)).rejects.toMatchObject({
					code: RequestError.invalidRequest().code,
				});
				f.disposal.resolve();
				await expect(f.running).resolves.toBe(code);
				const release = await f.store.acquire(f.sessionId);
				await release();
				expect(f.signals.listenerCount("SIGINT")).toBe(0);
				expect(f.signals.listenerCount("SIGTERM")).toBe(0);
				expect(f.stdout.listenerCount("close")).toBe(0);
			} finally {
				await f.close();
			}
		},
	);

	it("returns failure for output errors and never waits for blocked stdout during shutdown", async () => {
		const input = new PassThrough();
		const signals = new EventEmitter();
		const output = new Writable({
			write: (_chunk, _encoding, done) => done(new Error("broken pipe")),
		});
		const running = runNativeStdio({
			version: "test",
			createSession: () => ({
				prompt: async () => "completed",
				dispose: async () => {},
			}),
			stdin: input,
			stdout: output,
			signals,
		});
		input.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
		);
		await expect(running).resolves.toBe(1);
		const blockedInput = new PassThrough();
		const blockedSignals = new EventEmitter();
		let writing = false;
		const blockedOutput = new Writable({
			write: () => {
				writing = true;
			},
		});
		const blocked = runNativeStdio({
			version: "test",
			createSession: () => ({
				prompt: async () => "completed",
				dispose: async () => {},
			}),
			stdin: blockedInput,
			stdout: blockedOutput,
			signals: blockedSignals,
		});
		blockedInput.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
		);
		await vi.waitFor(() => expect(writing).toBe(true));
		blockedSignals.emit("SIGTERM");
		await expect(blocked).resolves.toBe(SIGNAL_EXIT.SIGTERM);
	});
});
