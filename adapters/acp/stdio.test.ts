import { RequestError } from "@agentclientprotocol/sdk";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { type RuntimePrompt, type RuntimeSession } from "@d3r/core/runtime";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runNativeStdio } from "./stdio.ts";

/** Independently specified shell statuses for the wrapper's signal contract. */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;
/** Split inside the JSON prefix to exercise partial reads rather than complete frames. */
const FRAME_SPLIT = 7;
/** Exercise actual byte framing, not SDK-normalized request objects. */
const fixture = (createSession: () => RuntimeSession) => {
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
	const request = async (id: string, method: string, params: unknown) => {
		const text = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		stdin.write(text.slice(0, FRAME_SPLIT));
		stdin.write(text.slice(FRAME_SPLIT));
		await vi.waitFor(() =>
			expect(messages().some((message) => message.id === id)).toBe(true),
		);
		return messages().find((message) => message.id === id)!;
	};
	return { stdin, stdout, signals, running, request, messages };
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

	it.each(["SIGINT", "SIGTERM"] as const)(
		"aborts and disposes on %s without calling process.exit",
		async (signal) => {
			const calls: RuntimePrompt[] = [];
			const dispose = vi.fn(async () => {});
			const f = fixture(() => ({
				dispose,
				prompt: async (request) => {
					calls.push(request);
					await new Promise<void>((done) =>
						request.signal.addEventListener("abort", () => done(), {
							once: true,
						}),
					);
					return "completed";
				},
			}));
			try {
				await f.request("initialize", "initialize", { protocolVersion: 1 });
				const created = await f.request("new", "session/new", {
					cwd: resolve("workspace"),
					mcpServers: [],
				});
				f.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: created.result?.sessionId, prompt: [{ type: "text", text: "hi" }] } })}\n`,
				);
				await vi.waitFor(() => expect(calls).toHaveLength(1));
				f.signals.emit(signal);
				await expect(f.running).resolves.toBe(SIGNAL_EXIT[signal]);
				expect(calls[0].signal.aborted).toBe(true);
				expect(dispose).toHaveBeenCalledTimes(1);
			} finally {
				f.signals.emit("SIGTERM");
				await f.running;
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
