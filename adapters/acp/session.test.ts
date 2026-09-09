import { client } from "@agentclientprotocol/sdk";
import { createSessionStore } from "@d3r/adapter-acp/server";
import {
	type RuntimePrompt,
	type RuntimeSessionInput,
} from "@d3r/core/runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CWD,
	deferred,
	fixture,
	runtime,
	waitForAbort,
} from "./test-support.ts";

/** Cancellation remains effective until cleanup and the settled checkpoint finish. */
describe("native prompt completion ordering", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const setup = async (stage: "checkpoint" | "terminal") => {
		const dir = await mkdtemp(join(tmpdir(), "d3r-settlement-"));
		directories.push(dir);
		const store = createSessionStore(dir);
		const gate = deferred<void>();
		const reached = deferred<void>();
		const events: string[] = [];
		const requests: RuntimePrompt[] = [];
		let paused = false;
		const pause = async () => {
			reached.resolve();
			await gate.promise;
		};
		const f = fixture(
			(input: RuntimeSessionInput) => ({
				...runtime(),
				prompt: async (request) => {
					requests.push(request);
					request.signal.addEventListener(
						"abort",
						() => {
							events.push("callbacks-closed");
							void request.emit({
								kind: "text",
								messageId: "late",
								text: "discard",
							});
						},
						{ once: true },
					);
					if (stage === "terminal") {
						await input.client!.runCommand!(
							{ command: "echo", args: [], cwd: CWD },
							request.signal,
						);
					}
					await request.emit({
						kind: "text",
						messageId: "reply",
						text: "done",
					});
					return "completed";
				},
				dispose: async () => {
					events.push("disposed");
				},
			}),
			async () => {},
			{
				deps: {
					store: {
						...store,
						save: async (row) => {
							const checkpoint = row.records.at(-1)?.kind === "checkpoint";
							if (checkpoint && paused && stage === "checkpoint") {
								await pause();
							}
							await store.save(row);
							if (checkpoint) {
								events.push("checkpoint");
							}
						},
					},
				},
				clientApp: client()
					.onRequest("terminal/create", () => ({ terminalId: "t" }))
					.onRequest("terminal/wait_for_exit", () => ({ exitCode: 0 }))
					.onRequest("terminal/output", () => ({
						output: "done",
						truncated: false,
					}))
					.onRequest("terminal/release", async () => {
						if (paused && stage === "terminal") {
							await pause();
						}
						events.push("released");
						return {};
					}),
			},
		);
		cleanup.push(async () => {
			gate.resolve();
			await f.close();
		});
		await f.peer.agent.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: { terminal: true },
		});
		const { sessionId } = await f.newSession();
		events.length = 0;
		paused = true;
		return { f, gate, reached, events, requests, sessionId, store };
	};
	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((close) => close()));
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it.each(["checkpoint", "terminal"] as const)(
		"honors cancellation during %s finalization without early acknowledgement or late updates",
		async (stage) => {
			const { f, gate, reached, events, requests, sessionId, store } =
				await setup(stage);
			const pending = f.prompt(sessionId).then((response) => {
				events.push("response");
				return response;
			});
			await reached.promise;
			expect(events).not.toContain("response");
			await expect(f.prompt(sessionId)).rejects.toMatchObject({
				code: -32_600,
			});
			await f.peer.agent.notify("session/cancel", { sessionId });
			await f.peer.agent.request("session/list", {});
			gate.resolve();
			await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
			expect(events.indexOf("callbacks-closed")).toBeLessThan(
				events.indexOf("checkpoint"),
			);
			expect(events.indexOf("checkpoint")).toBeLessThan(
				events.indexOf("response"),
			);
			await requests[0].emit({
				kind: "text",
				messageId: "later",
				text: "discard",
			});
			expect(f.updates.map((row) => row.update)).toEqual([
				{
					sessionUpdate: "agent_message_chunk",
					messageId: "reply",
					content: { type: "text", text: "done" },
				},
			]);
			const saved = await store.get(sessionId);
			expect(saved?.records.at(-1)?.kind).toBe("checkpoint");
			await f.close();
			expect(events.at(-1)).toBe("disposed");
		},
	);

	it("keeps successful completion distinct from its own callback shutdown", async () => {
		const { f, gate, reached, requests, sessionId } = await setup("checkpoint");
		const pending = f.prompt(sessionId);
		await reached.promise;
		expect(requests[0].signal.aborted).toBe(true);
		gate.resolve();
		await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
		await expect(f.prompt(sessionId)).resolves.toEqual({
			stopReason: "end_turn",
		});
	});

	it.each(["completed", "failed", "cancelled"] as const)(
		"publishes the runtime's new phase before acknowledging a %s prompt",
		async (outcome) => {
			const dir = await mkdtemp(join(tmpdir(), "d3r-phase-"));
			directories.push(dir);
			const store = createSessionStore(dir);
			let phase = "plan";
			const f = fixture(
				() => ({
					...runtime(),
					snapshot: () => ({ phase }),
					getConfig: () => [
						{
							id: "phase",
							name: "Phase",
							category: "_d3r",
							value: phase,
							options: [
								{ value: "plan", name: "Plan" },
								{ value: "apply", name: "Apply" },
							],
						},
					],
					prompt: async (request) => {
						phase = "apply";
						if (outcome === "cancelled") {
							return waitForAbort(request.signal);
						}
						if (outcome === "failed") {
							throw new Error("runtime failure");
						}
						return "completed";
					},
				}),
				async () => {},
				{ deps: { store } },
			);
			cleanup.push(f.close);
			await f.initialize();
			const { sessionId } = await f.newSession();
			const pending = f.prompt(sessionId);
			if (outcome === "cancelled") {
				await vi.waitFor(() => expect(phase).toBe("apply"));
				await f.peer.agent.notify("session/cancel", { sessionId });
			}
			const stopReason = outcome === "cancelled" ? "cancelled" : "end_turn";
			await (outcome === "failed"
				? expect(pending).rejects.toMatchObject({ code: -32_603 })
				: expect(pending).resolves.toEqual({ stopReason }));
			expect(f.updates.at(-1)?.update).toMatchObject({
				sessionUpdate: "config_option_update",
				configOptions: [{ id: "phase", currentValue: "apply" }],
			});
			const saved = await store.get(sessionId);
			expect(saved?.records).toContainEqual({
				kind: "update",
				update: f.updates.at(-1)!.update,
			});
			expect(saved?.records.at(-1)).toMatchObject({
				kind: "checkpoint",
				state: {
					runtime: { phase: "apply" },
					config: [{ id: "phase", value: "apply" }],
				},
			});
		},
	);

	it("honors SDK request cancellation during checkpointing", async () => {
		const { f, gate, reached, sessionId } = await setup("checkpoint");
		const cancellation = new AbortController();
		const pending = f.peer.agent.request(
			"session/prompt",
			{ sessionId, prompt: [{ type: "text", text: "hello" }] },
			{ cancellationSignal: cancellation.signal },
		);
		await reached.promise;
		cancellation.abort();
		await f.peer.agent.request("session/list", {});
		gate.resolve();
		await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
	});

	it("forwards setup cancellation to an asynchronous runtime factory", async () => {
		const started = deferred<RuntimeSessionInput>();
		const f = fixture(async (input) => {
			started.resolve(input);
			return waitForAbort(input.signal!);
		});
		cleanup.push(f.close);
		await f.initialize();
		const cancellation = new AbortController();
		const pending = f.peer.agent.request(
			"session/new",
			{ cwd: CWD, mcpServers: [] },
			{ cancellationSignal: cancellation.signal },
		);
		const input = await started.promise;
		expect(input.signal).toBeInstanceOf(AbortSignal);
		expect(input.signal?.aborted).toBe(false);
		cancellation.abort();
		await expect(pending).rejects.toMatchObject({ code: -32_800 });
		expect(input.signal?.aborted).toBe(true);
	});

	it("keeps later prompt lifetimes independent of the setup signal", async () => {
		const inputs: RuntimeSessionInput[] = [];
		const requests: RuntimePrompt[] = [];
		const f = fixture((input) => {
			inputs.push(input);
			return {
				...runtime(),
				prompt: async (request) => {
					requests.push(request);
					expect(request.signal).not.toBe(input.signal);
					expect(request.signal.aborted).toBe(false);
					if (requests.length === 1) {
						return waitForAbort(request.signal);
					}
					return "completed";
				},
			};
		});
		cleanup.push(f.close);
		await f.initialize();
		const { sessionId } = await f.newSession();
		const pending = f.prompt(sessionId);
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		await f.peer.agent.notify("session/cancel", { sessionId });
		await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
		expect(inputs[0].signal?.aborted).toBe(false);
		await expect(f.prompt(sessionId)).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(requests[0].signal).not.toBe(requests[1].signal);
		expect(inputs[0].signal?.aborted).toBe(false);
	});

	it("reports a cancelled setup before acquiring resources or starting a runtime", async () => {
		const gate = deferred<void>();
		const checking = deferred<void>();
		const createSession = vi.fn(runtime);
		const f = fixture(createSession, async () => {}, {
			deps: {
				authenticate: async () => {
					checking.resolve();
					await gate.promise;
				},
			},
		});
		cleanup.push(async () => {
			gate.resolve();
			await f.close();
		});
		await f.initialize();
		const cancellation = new AbortController();
		const pending = f.peer.agent.request(
			"session/new",
			{ cwd: CWD, mcpServers: [] },
			{ cancellationSignal: cancellation.signal },
		);
		await checking.promise;
		cancellation.abort();
		// Reinitialization is a harmless barrier after the cancellation notification.
		await expect(f.initialize()).rejects.toMatchObject({ code: -32_600 });
		gate.resolve();
		await expect(pending).rejects.toMatchObject({ code: -32_800 });
		expect(createSession).not.toHaveBeenCalled();
	});

	it("waits for a disconnected turn's checkpoint before disposing its runtime", async () => {
		const { f, gate, reached, events, sessionId } = await setup("checkpoint");
		const pending = f.prompt(sessionId).catch(() => {});
		await reached.promise;
		const closed = vi.fn();
		const closing = f.close().then(closed);
		await pending;
		expect(closed).not.toHaveBeenCalled();
		expect(events).not.toContain("disposed");
		gate.resolve();
		await closing;
		expect(events).toEqual(["callbacks-closed", "checkpoint", "disposed"]);
	});
});
