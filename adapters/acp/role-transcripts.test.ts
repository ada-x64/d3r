/* oxlint-disable no-magic-numbers -- Chunk counts and limits are explicit boundary test data. */
import {
	type AgentContext,
	type SessionUpdate,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { AgentSpec, Workflow } from "@d3r/core";
import {
	type RuntimeChunk,
	type RuntimePrompt,
	type RuntimeActivity,
} from "@d3r/core/runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowRuntime } from "../../cli/src/workflow-runtime.ts";
import { createClientServices } from "./client.ts";
import { checkpointSession, type Session } from "./session.ts";
import {
	createSessionStore,
	type SessionRecord,
	type StoredSession,
} from "./store.ts";
import {
	CWD,
	deferred,
	fixture,
	runtime,
	waitForAbort,
} from "./test-support.ts";
import { runTurn } from "./turn.ts";

/** Deterministic transport backpressure, with real turn and client-service settlement. */
const setup = (
	prompt: Session["runtime"]["prompt"],
	write: (update: SessionUpdate) => Promise<void> = async () => {},
) => {
	const controller = new AbortController();
	const updates: SessionUpdate[] = [];
	const saved: StoredSession[] = [];
	const client = {
		notify: vi.fn(
			async (_method: string, { update }: { update: SessionUpdate }) => {
				updates.push(structuredClone(update));
				await write(update);
			},
		),
		request: vi.fn(async () => ({
			outcome: { outcome: "selected", optionId: "allow_once" },
		})),
	} as unknown as AgentContext;
	const session: Session = {
		id: "root",
		cwd: CWD,
		additionalDirectories: [],
		runtime: { ...runtime(), prompt },
		services: createClientServices("root", client, {
			capabilities: {},
			connectionSignal: controller.signal,
		}),
		store: {
			acquire: async () => async () => {},
			get: async () => null,
			save: async (row) => {
				saved.push(structuredClone(row));
			},
			delete: async () => false,
			list: async () => ({ sessions: [] }),
		},
		secrets: [],
		records: [],
		tools: new Set(),
		pending: null,
		active: null,
		closing: false,
		failed: false,
	};
	return {
		controller,
		updates,
		session,
		client,
		saved,
		run: () =>
			runTurn(session, {
				params: { sessionId: "root", prompt: [{ type: "text", text: "go" }] },
				signal: controller.signal,
				client,
			}),
	};
};

/** Role identity is established by ordinary tool activity, not names or metadata. */
const tool = (
	toolCallId: string,
	status: "in_progress" | "completed" | "failed" = "in_progress",
): Extract<RuntimeActivity, { kind: "tool" }> => ({
	kind: "tool",
	toolCallId,
	title: toolCallId,
	toolKind: "other",
	status,
});
/** Reused message IDs deliberately exercise role-local identity. */
const chunk = (
	parentToolCallId: string,
	text: string,
	kind: RuntimeChunk["kind"] = "text",
): RuntimeChunk => ({
	parentToolCallId,
	messageId: "same",
	kind,
	text,
});
/** Project the separate content blocks that an ACP client actually renders. */
const blocks = (update: ToolCallUpdate) =>
	(update.content ?? []).flatMap((part) =>
		part.type === "content" && part.content.type === "text"
			? [part.content.text]
			: [],
	);
/** Keep only tool rows for a particular card, excluding coordinator messages. */
const card = (updates: SessionUpdate[], id: string) =>
	updates.filter(
		(update) =>
			(update.sessionUpdate === "tool_call" ||
				update.sessionUpdate === "tool_call_update") &&
			update.toolCallId === id,
	) as ToolCallUpdate[];
/** Inspect replay records without changing unrelated history. */
const recorded = (session: Session) =>
	session.records.flatMap((record) =>
		record.kind === "update" ? [record.update] : [],
	);

/** No protocol extensions are needed to present independent runtime children. */
describe("role transcript presentation", () => {
	it("groups interleaved text and thoughts by parent, message and kind, preserving final results", async () => {
		const f = setup(async (request) => {
			await request.activity!({
				...tool("a"),
				rawInput: { role: "a" },
				content: [{ type: "text", text: "Initial preview" }],
			});
			await request.activity!(tool("b"));
			await request.emit(chunk("a", "A"));
			await request.emit(chunk("b", "B thought", "thought"));
			await request.emit(chunk("a", "A thought", "thought"));
			await request.emit(chunk("b", "B"));
			await request.emit({
				...chunk("a", " second message"),
				messageId: "other",
			});
			await request.emit(chunk("b", " response"));
			await request.emit(chunk("a", " response"));
			await request.emit(chunk("a", " continued", "thought"));
			await request.activity!({
				...tool("independent", "completed"),
				content: [{ type: "terminal", terminalId: "terminal" }],
			});
			await request.emit({
				kind: "text",
				messageId: "root",
				text: "Coordinator",
			});
			await request.emit({
				kind: "thought",
				messageId: "root",
				text: "Coordinator thought",
			});
			await request.activity!({
				...tool("a", "completed"),
				rawOutput: { summary: "full outcome" },
				content: [{ type: "text", text: "Final result" }],
			});
			await request.activity!({
				...tool("b", "failed"),
				rawOutput: { error: "failure" },
			});
			await request.activity!(tool("a"));
			await request.emit(chunk("a", " late accepted text"));
			return "completed";
		});
		await expect(f.run()).resolves.toBe("completed");
		expect(card(f.updates, "a")[0]).toMatchObject({
			status: "in_progress",
			rawInput: { role: "a" },
		});
		const a = card(f.updates, "a").at(-1)!;
		expect(a).toMatchObject({
			status: "completed",
			rawOutput: { summary: "full outcome" },
		});
		expect(blocks(a)).toEqual([
			"Final result",
			"Response\n\nA response late accepted text",
			"Thought\n\nA thought continued",
			"Response\n\n second message",
		]);
		const b = card(f.updates, "b").at(-1)!;
		expect(b).toMatchObject({
			status: "failed",
			rawOutput: { error: "failure" },
		});
		expect(blocks(b)).toEqual([
			"Thought\n\nB thought",
			"Response\n\nB response",
		]);
		expect(
			f.updates.filter(
				(update) =>
					update.sessionUpdate === "agent_message_chunk" ||
					update.sessionUpdate === "agent_thought_chunk",
			),
		).toEqual([
			{
				sessionUpdate: "agent_message_chunk",
				messageId: "root",
				content: { type: "text", text: "Coordinator" },
			},
			{
				sessionUpdate: "agent_thought_chunk",
				messageId: "root",
				content: { type: "text", text: "Coordinator thought" },
			},
		]);
		expect(card(f.updates, "independent")).toEqual([
			{
				toolCallId: "independent",
				kind: "other",
				title: "independent",
				status: "completed",
				sessionUpdate: "tool_call",
				content: [{ type: "terminal", terminalId: "terminal" }],
			},
		]);
		expect(card(recorded(f.session), "a")).toHaveLength(2);
		expect(card(recorded(f.session), "a").at(-1)).toEqual(a);
	});

	it("coalesces a blocked role while permissions and other cards still dispatch, then flushes its final snapshot", async () => {
		const gate = deferred<void>();
		const ready = deferred<void>();
		let request: RuntimePrompt | undefined = undefined;
		const f = setup(
			async (input) => {
				request = input;
				await input.activity!(tool("a"));
				await input.activity!(tool("b"));
				await input.emit(chunk("a", "first"));
				await Promise.all(
					Array.from({ length: 2000 }, () => input.emit(chunk("a", "."))),
				);
				await input.emit(chunk("b", "other role"));
				await f.session.services.services.requestPermission(
					{ toolCallId: "permission", title: "Read", kind: "read", input: {} },
					input.signal,
				);
				ready.resolve();
				await input.activity!({
					...tool("a", "completed"),
					rawOutput: { complete: true },
				});
				return "completed";
			},
			(update) =>
				update.sessionUpdate === "tool_call_update" && update.toolCallId === "a"
					? gate.promise
					: Promise.resolve(),
		);
		let settled = false;
		const pending = f.run().then(() => {
			settled = true;
		});
		await ready.promise;
		expect(settled).toBe(false);
		expect(card(f.updates, "a")).toHaveLength(2);
		expect(blocks(card(f.updates, "b").at(-1)!)).toEqual([
			"Response\n\nother role",
		]);
		expect(f.client.request).toHaveBeenCalledWith(
			"session/request_permission",
			expect.objectContaining({ sessionId: "root" }),
			expect.anything(),
		);
		gate.resolve();
		await pending;
		const final = card(f.updates, "a").at(-1)!;
		expect(card(f.updates, "a")).toHaveLength(3);
		expect(final).toMatchObject({
			status: "completed",
			rawOutput: { complete: true },
		});
		expect(blocks(final)).toEqual([`Response\n\nfirst${".".repeat(2000)}`]);
		expect(card(recorded(f.session), "a")).toHaveLength(2);
		const before = structuredClone(f.updates);
		await request!.emit(chunk("a", "after settlement"));
		await request!.activity!(tool("a"));
		expect(f.updates).toEqual(before);
	});

	it("drains buffered text even when the runtime returns without a final tool update", async () => {
		const gate = deferred<void>();
		const ready = deferred<void>();
		const f = setup(
			async (request) => {
				await request.activity!(tool("a"));
				await request.emit(chunk("a", "first"));
				await request.emit(chunk("a", " last"));
				ready.resolve();
				return "completed";
			},
			(update) =>
				update.sessionUpdate === "tool_call_update"
					? gate.promise
					: Promise.resolve(),
		);
		const pending = f.run();
		await ready.promise;
		gate.resolve();
		await expect(pending).resolves.toBe("completed");
		expect(blocks(card(f.updates, "a").at(-1)!)).toEqual([
			"Response\n\nfirst last",
		]);
	});

	it("releases a stalled snapshot on abort and checkpoints buffered text without late callbacks", async () => {
		const gate = deferred<void>();
		const ready = deferred<void>();
		let request: RuntimePrompt | undefined = undefined;
		const f = setup(
			async (input) => {
				request = input;
				await input.activity!(tool("a"));
				await input.emit(chunk("a", "sent"));
				await input.emit(chunk("a", " buffered"));
				ready.resolve();
				return waitForAbort(input.signal);
			},
			(update) =>
				update.sessionUpdate === "tool_call_update"
					? gate.promise
					: Promise.resolve(),
		);
		const error = new Error("connection or turn cancelled");
		const pending = f.run();
		const rejected = expect(pending).rejects.toBe(error);
		await ready.promise;
		f.controller.abort(error);
		await rejected;
		await checkpointSession(f.session);
		const checkpoint = f.saved.at(-1)!;
		expect(checkpoint.records.at(-1)?.kind).toBe("checkpoint");
		expect(card(recorded(f.session), "a").at(-1)).toMatchObject({
			status: "failed",
		});
		expect(card(recorded(f.session), "a").at(-1)?.rawOutput).toBeUndefined();
		expect(blocks(card(recorded(f.session), "a").at(-1)!)).toEqual([
			"Response\n\nsent buffered",
		]);
		const updates = structuredClone(f.updates);
		const records = structuredClone(f.session.records);
		gate.resolve();
		await request!.emit(chunk("a", "discard"));
		await request!.activity!(tool("a", "completed"));
		expect(f.updates).toEqual(updates);
		expect(f.session.records).toEqual(records);
	});

	it.each(["cancel", "disconnect"] as const)(
		"checkpoints and reloads terminal role statuses and buffered text after real ACP %s with blocked output",
		// oxlint-disable-next-line max-statements -- Keep blocked transport, cancellation, checkpoint and new-lease replay in one journey.
		async (action) => {
			const dir = await mkdtemp(join(tmpdir(), "d3r-role-output-"));
			const store = createSessionStore(dir);
			const gate = deferred<void>();
			const ready = deferred<void>();
			const blocked = deferred<void>();
			const checkpointed = deferred<void>();
			const turns: RuntimePrompt[] = [];
			const completed = { summary: "Sibling completed before cancellation" };
			const failed = {
				error: "Role interrupted",
				outcome: { summary: "Partial work retained" },
			};
			let pause = false;
			const f = fixture(
				() => ({
					...runtime(),
					prompt: async (request) => {
						turns.push(request);
						await request.activity!(tool("completed"));
						await request.emit(chunk("completed", "Sibling response"));
						await request.activity!({
							...tool("completed", "completed"),
							rawOutput: completed,
						});
						await request.activity!({
							...tool("silent-completed", "completed"),
							rawOutput: completed,
						});
						await request.activity!(tool("role"));
						await request.activity!(tool("silent"));
						await request.activity!(tool("unfinished"));
						await request.activity!(tool("independent"));
						pause = true;
						await request.emit(chunk("role", "sent"));
						await request.emit(chunk("role", " buffered"));
						await request.emit(chunk("unfinished", "No terminal callback"));
						ready.resolve();
						try {
							return await waitForAbort(request.signal);
						} finally {
							await request.activity!({
								...tool("role", "failed"),
								rawOutput: failed,
							});
							await request.activity!({
								...tool("silent", "failed"),
								rawOutput: failed,
							});
							await request.activity!({
								...tool("completed", "failed"),
								rawOutput: failed,
							});
							await request.activity!({
								...tool("silent-completed", "failed"),
								rawOutput: failed,
							});
							await request.activity!(tool("unannounced", "failed"));
							await request.emit(chunk("role", "discard after abort"));
						}
					},
				}),
				async () => {
					if (pause) {
						blocked.resolve();
						await gate.promise;
					}
				},
				{
					deps: {
						store: {
							...store,
							save: async (row) => {
								await store.save(row);
								if (pause && row.records.at(-1)?.kind === "checkpoint") {
									checkpointed.resolve();
								}
							},
						},
					},
				},
			);
			const resumed = fixture(runtime, async () => {}, { deps: { store } });
			const expectSettled = (updates: SessionUpdate[]) => {
				expect(card(updates, "role")).toHaveLength(2);
				expect(card(updates, "role").at(-1)).toMatchObject({
					status: "failed",
					rawOutput: failed,
				});
				expect(blocks(card(updates, "role").at(-1)!)).toEqual([
					"Response\n\nsent buffered",
				]);
				expect(card(updates, "silent")).toHaveLength(2);
				expect(card(updates, "silent").at(-1)).toMatchObject({
					status: "failed",
					rawOutput: failed,
				});
				expect(blocks(card(updates, "silent").at(-1)!)).toEqual([]);
				expect(card(updates, "unfinished").at(-1)).toMatchObject({
					status: "failed",
				});
				expect(card(updates, "unfinished").at(-1)?.rawOutput).toBeUndefined();
				expect(blocks(card(updates, "unfinished").at(-1)!)).toEqual([
					"Response\n\nNo terminal callback",
				]);
				expect(card(updates, "completed")).toHaveLength(2);
				expect(card(updates, "completed").at(-1)).toMatchObject({
					status: "completed",
					rawOutput: completed,
				});
				expect(blocks(card(updates, "completed").at(-1)!)).toEqual([
					"Response\n\nSibling response",
				]);
				expect(card(updates, "silent-completed")).toHaveLength(1);
				expect(card(updates, "silent-completed")[0]).toMatchObject({
					status: "completed",
					rawOutput: completed,
				});
				expect(card(updates, "independent")).toHaveLength(1);
				expect(card(updates, "unannounced")).toEqual([]);
			};
			try {
				await f.initialize();
				const { sessionId } = await f.newSession();
				const pending = f.prompt(sessionId).then(
					(response) => ({ response }),
					(error: unknown) => ({ error }),
				);
				await Promise.all([ready.promise, blocked.promise]);
				const closing =
					action === "disconnect"
						? f.close()
						: f.peer.agent.notify("session/cancel", { sessionId });
				await checkpointed.promise;
				const saved = (await store.get(sessionId))!;
				expect(saved.records.at(-1)?.kind).toBe("checkpoint");
				const updates = saved.records.flatMap((record) =>
					record.kind === "update" ? [record.update] : [],
				);
				expectSettled(updates);
				gate.resolve();
				await closing;
				if (action === "cancel") {
					await expect(pending).resolves.toEqual({
						response: { stopReason: "cancelled" },
					});
				} else {
					expect(await pending).toHaveProperty("error");
				}
				await f.close();
				await turns[0].emit(chunk("role", "late"));
				await turns[0].activity!(tool("role", "completed"));
				await expect(store.get(sessionId)).resolves.toEqual(saved);
				await resumed.initialize();
				await resumed.peer.agent.request("session/load", {
					sessionId,
					cwd: CWD,
					mcpServers: [],
				});
				expectSettled(resumed.updates.map(({ update }) => update));
				expect(
					resumed.updates.some(
						({ update }) =>
							update.sessionUpdate === "agent_message_chunk" ||
							update.sessionUpdate === "agent_thought_chunk",
					),
				).toBe(false);
			} finally {
				gate.resolve();
				await Promise.all([f.close(), resumed.close()]);
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("reports asynchronous snapshot delivery failure rather than successful completion", async () => {
		const gate = deferred<void>();
		const ready = deferred<void>();
		const f = setup(
			async (request) => {
				await request.activity!(tool("a"));
				await request.emit(chunk("a", "accepted"));
				await request.emit(chunk("a", " buffered"));
				ready.resolve();
				return "completed";
			},
			(update) =>
				update.sessionUpdate === "tool_call_update"
					? gate.promise
					: Promise.resolve(),
		);
		const error = new Error("write failed");
		const rejected = expect(f.run()).rejects.toBe(error);
		await ready.promise;
		gate.reject(error);
		await rejected;
		expect(blocks(card(recorded(f.session), "a").at(-1)!)).toEqual([
			"Response\n\naccepted buffered",
		]);
	});

	it.each(["text", "thought"] as const)(
		"rejects an unknown or previous-turn parent for %s without leaking to root",
		async (kind) => {
			const f = setup(async (request) => {
				await request.emit(chunk("old", "must not leak", kind));
				return "completed";
			});
			f.session.tools.add("old");
			const previous: SessionRecord[] = [
				{
					kind: "update",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "old",
						title: "old",
						status: "completed",
					},
				},
				{ kind: "checkpoint", state: { prior: true } },
			];
			f.session.records.push(...structuredClone(previous));
			await expect(f.run()).rejects.toThrow("not announced in this turn");
			expect(f.updates).toEqual([]);
			expect(f.session.records.slice(0, previous.length)).toEqual(previous);
			expect(JSON.stringify(f.session.records)).not.toContain("must not leak");
		},
	);

	it("bounds presentation text and block metadata without truncating structured outcomes or old history", async () => {
		const outcome = { summary: "s".repeat(70_000) };
		const f = setup(async (request) => {
			await request.activity!(tool("a"));
			await request.activity!(tool("b"));
			await request.emit(chunk("a", "x".repeat(70_000)));
			await Promise.all(
				Array.from({ length: 1000 }, (_, index) =>
					request.emit({
						...chunk("b", "tiny", "thought"),
						messageId: String(index),
					}),
				),
			);
			await request.activity!({
				...tool("a", "completed"),
				rawOutput: outcome,
			});
			return "completed";
		});
		const previous: SessionRecord[] = [
			{
				kind: "update",
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "a",
					content: [
						{ type: "content", content: { type: "text", text: "past turn" } },
					],
				},
			},
			{ kind: "checkpoint", state: {} },
		];
		f.session.records.push(...structuredClone(previous));
		await f.run();
		const a = card(f.updates, "a").at(-1)!;
		expect(blocks(a)).toEqual([
			`Response\n\n${"x".repeat(65_536)}`,
			"[Role transcript truncated for display.]",
		]);
		expect(a.rawOutput).toEqual(outcome);
		const b = blocks(card(f.updates, "b").at(-1)!);
		expect(b).toHaveLength(129);
		expect(b.at(-1)).toBe("[Role transcript truncated for display.]");
		expect(f.session.records.slice(0, previous.length)).toEqual(previous);
		expect(card(recorded(f.session), "b")).toHaveLength(2);
	});

	it("keeps ordinary text fully streamed and backpressured", async () => {
		const gate = deferred<void>();
		const reached = deferred<void>();
		let accepted = false;
		const f = setup(
			async (request) => {
				await request.emit({ messageId: "root", kind: "text", text: "first" });
				accepted = true;
				await request.emit({ messageId: "root", kind: "text", text: "second" });
				return "completed";
			},
			async () => {
				reached.resolve();
				await gate.promise;
			},
		);
		const pending = f.run();
		await reached.promise;
		expect(accepted).toBe(false);
		expect(f.updates).toHaveLength(1);
		gate.resolve();
		await pending;
		expect(f.updates).toHaveLength(2);
		expect(
			recorded(f.session).filter(
				(update) => update.sessionUpdate === "agent_message_chunk",
			),
		).toEqual(f.updates);
	});

	it.each(["text", "silent"] as const)(
		"retains the actual workflow's failed %s role update during abort without notifying",
		async (output) => {
			const ready = deferred<void>();
			const turns: RuntimePrompt[] = [];
			const outcome = {
				status: "completed" as const,
				summary: "Report submitted before interruption",
			};
			const backend = createWorkflowRuntime({
				workflow: Workflow.parse({
					commands: {
						delegate: {
							description: "test",
							chain: [{ kind: "agent", name: "worker" }],
						},
					},
					vault: { dirs: [], template_kinds: [] },
				}),
				agents: [
					{
						spec: AgentSpec.parse({
							name: "worker",
							tier: "low",
							description: "test",
							capabilities: [],
						}),
						prompt: "worker",
					},
				],
				routing: runtime(),
				createAgent: async (_name, report) => ({
					...runtime(),
					prompt: async (request) => {
						if (output === "text") {
							await request.emit({
								messageId: "child",
								kind: "text",
								text: "Accepted before abort",
							});
						}
						report(outcome);
						ready.resolve();
						return waitForAbort(request.signal);
					},
				}),
			});
			const f = setup((request) => {
				turns.push(request);
				return backend.prompt({
					...request,
					content: [{ type: "text", text: "/delegate test" }],
				});
			});
			try {
				const pending = f.run().catch((error: unknown) => {
					if (error !== f.controller.signal.reason) {
						throw error;
					}
					return "cancelled";
				});
				await ready.promise;
				const beforeAbort = structuredClone(f.updates);
				const initial = f.updates.find(
					(update) =>
						update.sessionUpdate === "tool_call" && update.title === "worker",
				) as ToolCallUpdate;
				f.controller.abort(new Error("cancelled"));
				await expect(pending).resolves.toBe("cancelled");
				const retained = card(recorded(f.session), initial.toolCallId);
				expect(retained).toHaveLength(2);
				expect(retained.at(-1)).toMatchObject({
					status: "failed",
					rawOutput: {
						error:
							"Role setup or execution failed; effects may have occurred. Workflow paused.",
						outcome,
					},
				});
				expect(blocks(retained.at(-1)!)).toEqual([
					...blocks(initial),
					...(output === "text" ? ["Response\n\nAccepted before abort"] : []),
				]);
				expect(f.updates).toEqual(beforeAbort);
				const records = structuredClone(f.session.records);
				await turns[0].activity!({
					...tool(initial.toolCallId, "completed"),
					rawOutput: { summary: "late" },
				});
				expect(f.updates).toEqual(beforeAbort);
				expect(f.session.records).toEqual(records);
			} finally {
				f.controller.abort();
				await backend.dispose();
			}
		},
	);

	it("stamps workflow role emissions but preserves already-scoped nested emissions and tool IDs", async () => {
		const workflow = Workflow.parse({
			commands: {
				delegate: {
					description: "test",
					chain: [{ kind: "agent", name: "worker" }],
				},
			},
			vault: { dirs: [], template_kinds: [] },
		});
		const backend = createWorkflowRuntime({
			workflow,
			agents: [
				{
					spec: AgentSpec.parse({
						name: "worker",
						tier: "low",
						description: "test",
						capabilities: [],
					}),
					prompt: "worker",
				},
			],
			routing: runtime(),
			createAgent: async (_name, report) => ({
				...runtime(),
				prompt: async (request) => {
					await request.emit({
						messageId: "child",
						kind: "text",
						text: "outer child",
					});
					await request.activity!(tool("nested"));
					await request.emit(chunk("nested", "nested child"));
					report({ status: "completed", summary: "done" });
					return "completed";
				},
			}),
		});
		const f = setup((request) =>
			backend.prompt({
				...request,
				content: [{ type: "text", text: "/delegate test" }],
			}),
		);
		try {
			await f.run();
			const outer = f.updates.find(
				(update) =>
					update.sessionUpdate === "tool_call" && update.title === "worker",
			) as ToolCallUpdate;
			expect(outer).toBeDefined();
			expect(blocks(card(f.updates, outer.toolCallId).at(-1)!)).toEqual([
				...blocks(outer),
				"Response\n\nouter child",
			]);
			expect(blocks(card(f.updates, "nested").at(-1)!)).toEqual([
				"Response\n\nnested child",
			]);
			expect(
				f.updates
					.filter((update) => update.sessionUpdate === "agent_message_chunk")
					.map((update) => JSON.stringify(update))
					.join(""),
			).not.toContain("child");
		} finally {
			await backend.dispose();
		}
	});
});
