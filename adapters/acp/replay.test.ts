import {
	createSessionStore,
	type SessionStore,
	type StoredSession,
} from "@d3r/adapter-acp/server";
import {
	type OpenRuntimeSession,
	type RuntimeSessionInput,
	type RuntimePrompt,
} from "@d3r/core/runtime";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CWD, fixture, runtime } from "./test-support.ts";

/** Exercise every retained activity with model and conversation state that changes over time. */
const replayRuntime = () => {
	const inputs: RuntimeSessionInput[] = [];
	const restored: unknown[] = [];
	const turns: RuntimePrompt[] = [];
	const factory: OpenRuntimeSession = (input) => {
		inputs.push(input);
		let count = 0;
		let model = "a";
		const getConfig = () => [
			{
				id: "model",
				name: "Model",
				category: "model" as const,
				value: model,
				options: [
					{ value: "a", name: "A" },
					{ value: "b", name: "B" },
				],
			},
		];
		return {
			getConfig,
			setConfig: async (_id, value) => {
				model = value;
				return getConfig();
			},
			getCommands: () => [
				{ name: "explain", description: "Explain", inputHint: "topic" },
			],
			snapshot: () => ({ count, model }),
			restore: (state) => {
				restored.push(state);
				({ count, model } = state as { count: number; model: string });
			},
			dispose: async () => {},
			prompt: async (request) => {
				turns.push(request);
				count += 1;
				await request.emit({
					kind: "thought",
					messageId: "thought",
					text: "Thinking",
				});
				await request.activity!({
					kind: "tool",
					toolCallId: `edit-${count}`,
					title: "Edit",
					toolKind: "edit",
					status: "in_progress",
					rawInput: { path: resolve("file") },
				});
				await request.activity!({
					kind: "tool",
					toolCallId: `edit-${count}`,
					title: "Edit",
					toolKind: "edit",
					status: "completed",
					content: [
						{
							type: "diff",
							path: resolve("file"),
							oldText: "old",
							newText: "new",
						},
						{ type: "text", text: "Updated" },
					],
					locations: [{ path: resolve("file"), line: 2 }],
					rawOutput: { ok: true },
				});
				await request.activity!({
					kind: "plan",
					entries: [{ content: "Edit", status: "completed", priority: "high" }],
				});
				await request.activity!({
					kind: "usage",
					used: 10,
					size: 1000,
					cost: { amount: 0.1, currency: "USD" },
				});
				await request.emit({
					kind: "text",
					messageId: "reply",
					text: `Turn ${count}`,
				});
				return "completed";
			},
		};
	};
	return { factory, inputs, restored, turns };
};
/** Reopening must restore exactly the state corresponding to the complete replay transcript. */
describe("native ACP replay and recovery", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const open = (factory: OpenRuntimeSession, store: SessionStore) => {
		const f = fixture(factory, async () => {}, { deps: { store } });
		cleanup.push(f.close);
		return f;
	};
	const store = async () => {
		const dir = await mkdtemp(join(tmpdir(), "d3r-replay-"));
		directories.push(dir);
		return { dir, persistence: createSessionStore(dir) };
	};
	const prepare = async () => {
		const { persistence } = await store();
		const backend = replayRuntime();
		const f = open(backend.factory, persistence);
		const initialized = await f.initialize();
		const { sessionId } = await f.newSession();
		const created = await persistence.get(sessionId);
		await f.prompt(sessionId);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: "b",
		});
		const saved = (await persistence.get(sessionId))!;
		return {
			...backend,
			f,
			initialized,
			sessionId,
			created,
			saved,
			persistence,
		};
	};
	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((close) => close()));
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it("checkpoints creation, settled turns and configuration without accepting late activities", async () => {
		const { f, initialized, created, saved, turns, persistence, sessionId } =
			await prepare();
		expect(initialized.agentCapabilities).toMatchObject({
			loadSession: true,
			sessionCapabilities: { list: {}, resume: {}, delete: {} },
		});
		expect(created?.records).toHaveLength(1);
		expect(f.updates[0].update).toMatchObject({
			sessionUpdate: "available_commands_update",
			availableCommands: [{ name: "explain", input: { hint: "topic" } }],
		});
		expect(saved.records.at(-1)).toEqual({
			kind: "checkpoint",
			state: {
				runtime: { count: 1, model: "b" },
				config: [{ id: "model", value: "b" }],
			},
		});
		const checkpointCount = 3;
		expect(
			saved.records.filter((record) => record.kind === "checkpoint"),
		).toHaveLength(checkpointCount);
		expect(
			f.updates.find((row) => row.update.sessionUpdate === "tool_call_update")
				?.update,
		).toMatchObject({
			content: [
				{ type: "diff", oldText: "old", newText: "new" },
				{ type: "content", content: { type: "text", text: "Updated" } },
			],
			locations: [{ line: 2 }],
		});
		await turns[0].activity!({ kind: "usage", used: 999, size: 1000 });
		const afterLateActivity = await persistence.get(sessionId);
		expect(afterLateActivity?.records).toEqual(saved.records);
	});

	it("restores the latest backend and model and replays messages, tools, diffs, locations, usage and plan", async () => {
		const { f, factory, persistence, sessionId, restored, inputs, saved } =
			await prepare();
		await f.close();
		const g = open(factory, persistence);
		await g.initialize();
		await expect(
			g.peer.agent.request("session/load", {
				sessionId,
				cwd: resolve("other"),
				mcpServers: [],
			}),
		).rejects.toMatchObject({ code: -32_602 });
		const loaded = await g.peer.agent.request("session/load", {
			sessionId,
			cwd: CWD,
			mcpServers: [],
			additionalDirectories: [resolve("new-root")],
		});
		expect(loaded.configOptions?.[0]).toMatchObject({ currentValue: "b" });
		expect(restored).toEqual([{ count: 1, model: "b" }]);
		expect(inputs.at(-1)?.additionalDirectories).toEqual([resolve("new-root")]);
		expect(g.updates.slice(0, -1).map((row) => row.update)).toEqual(
			saved.records.flatMap((record) =>
				record.kind === "update" ? [record.update] : [],
			),
		);
		await g.prompt(sessionId);
		expect(
			g.updates.findLast(
				(row) => row.update.sessionUpdate === "agent_message_chunk",
			)?.update,
		).toMatchObject({ content: { text: "Turn 2" } });
	});

	it("resumes without replay and closes and deletes the resumed session", async () => {
		const { f, persistence, sessionId } = await prepare();
		await f.peer.agent.request("session/close", { sessionId });
		f.updates.length = 0;
		await f.peer.agent.request("session/resume", { sessionId, cwd: CWD });
		expect(f.updates.map((row) => row.update.sessionUpdate)).toEqual([
			"available_commands_update",
		]);
		await f.peer.agent.request("session/delete", { sessionId });
		await expect(f.prompt(sessionId)).rejects.toMatchObject({ code: -32_602 });
		await expect(
			f.peer.agent.request("session/load", {
				sessionId,
				cwd: CWD,
				mcpServers: [],
			}),
		).rejects.toMatchObject({ code: -32_602 });
		const listed = await f.peer.agent.request("session/list", {});
		expect(listed.sessions).toEqual([]);
		expect(await persistence.get(sessionId)).toBeNull();
	});

	it.each(["session/load", "session/resume"] as const)(
		"refuses %s without restoring or replaying an interrupted final record",
		async (method) => {
			const { dir, persistence } = await store();
			const sessionId = randomUUID();
			const interrupted: StoredSession = {
				version: 1,
				sessionId,
				cwd: CWD,
				additionalDirectories: [],
				updatedAt: new Date().toISOString(),
				records: [
					{ kind: "checkpoint", state: { runtime: { count: 1 }, config: [] } },
					{
						kind: "update",
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "uncommitted" },
						},
					},
				],
			};
			await writeFile(
				join(dir, `${sessionId}.json`),
				JSON.stringify(interrupted),
			);
			const restore = vi.fn();
			const factory = vi.fn(() => ({ ...runtime(), restore }));
			const f = open(factory, persistence);
			await f.initialize();
			await expect(
				f.peer.agent.request(method, { sessionId, cwd: CWD, mcpServers: [] }),
			).rejects.toMatchObject({ code: -32_603 });
			expect(factory).not.toHaveBeenCalled();
			expect(restore).not.toHaveBeenCalled();
			expect(f.updates).toEqual([]);
			// Custom stores are also an untrusted recovery boundary, even without file parsing.
			const custom = open(factory, {
				...persistence,
				get: async () => interrupted,
			});
			await custom.initialize();
			await expect(
				custom.peer.agent.request(method, {
					sessionId,
					cwd: CWD,
					mcpServers: [],
				}),
			).rejects.toMatchObject({ code: -32_603 });
			expect(factory).not.toHaveBeenCalled();
			expect(restore).not.toHaveBeenCalled();
			expect(custom.updates).toEqual([]);
		},
	);
});
