import { appendFile, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RuntimeSession } from "@d3r/core/runtime";
import { RequestError } from "@agentclientprotocol/sdk";
import {
	createSessionStore,
	nativeAuthRequired,
	type SessionStore,
	type StoredSession,
} from "@d3r/adapter-acp/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CWD, deferred, fixture, runtime } from "./test-support.ts";

/** Selector state deliberately lives outside the runtime checkpoint to exercise restore setters. */
const config = (value = "a") => [
	{
		id: "mode",
		name: "Mode",
		category: "mode" as const,
		value,
		options: [
			{ value: "a", name: "A" },
			{ value: "b", name: "B" },
		],
	},
];
/** Inspect the durable file independently of the store's complete-checkpoint read API. */
const readStored = async (dir: string, id: string): Promise<StoredSession> =>
	JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
/** Every mutation must replace the old complete checkpoint with intent before an external effect. */
describe("native write-ahead mutation intents", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const directory = async () => {
		const dir = await mkdtemp(join(tmpdir(), "d3r-intent-"));
		directories.push(dir);
		return dir;
	};
	const open = (
		factory: Parameters<typeof fixture>[0],
		store: SessionStore,
	) => {
		const f = fixture(factory, async () => {}, { deps: { store } });
		cleanup.push(f.close);
		return f;
	};
	const setup = async (operation: "prompt" | "config") => {
		const dir = await directory();
		const store = createSessionStore(dir);
		const gate = deferred<void>();
		const entered = deferred<{ disk: StoredSession; readable: boolean }>();
		const effectPath = join(dir, "external-effect.txt");
		let effects = 0;
		let value = "a";
		const f = open((input) => {
			const mutate = async () => {
				const disk = await readStored(dir, input.sessionId);
				const readable = await store.get(input.sessionId).then(
					() => true,
					() => false,
				);
				await appendFile(effectPath, "effect\n");
				effects += 1;
				entered.resolve({ disk, readable });
				await gate.promise;
			};
			return {
				...runtime(),
				getConfig: () => config(value),
				snapshot: () => ({ effects }),
				prompt: async () => {
					await mutate();
					return "completed";
				},
				setConfig: async (_id, next) => {
					await mutate();
					value = next;
					return config(value);
				},
			};
		}, store);
		cleanup.push(async () => {
			gate.resolve();
		});
		await f.initialize();
		const { sessionId } = await f.newSession();
		const invoke = () =>
			operation === "prompt"
				? f.prompt(sessionId)
				: f.peer.agent.request("session/set_config_option", {
						sessionId,
						configId: "mode",
						value: "b",
					});
		return { dir, store, gate, entered, effectPath, f, sessionId, invoke };
	};
	const refuseRecovery = async (dir: string, sessionId: string) => {
		const recovered = createSessionStore(dir);
		await expect(recovered.get(sessionId)).rejects.toMatchObject({
			code: -32_603,
		});
		const createSession = vi.fn(runtime);
		const f = open(createSession, recovered);
		await f.initialize();
		await expect(
			f.peer.agent.request("session/load", {
				sessionId,
				cwd: CWD,
				mcpServers: [],
			}),
		).rejects.toMatchObject({ code: -32_603 });
		await expect(
			f.peer.agent.request("session/resume", { sessionId, cwd: CWD }),
		).rejects.toMatchObject({ code: -32_603 });
		expect(createSession).not.toHaveBeenCalled();
		expect(f.updates).toEqual([]);
		return recovered;
	};
	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((close) => close()));
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it.each(["prompt", "config"] as const)(
		"persists %s intent before invocation and never resumes a crash image from the old checkpoint",
		async (operation) => {
			const { dir, store, gate, entered, effectPath, f, sessionId, invoke } =
				await setup(operation);
			const pending = invoke().catch(() => {});
			const observed = await entered.promise;
			expect(observed.readable).toBe(false);
			expect(observed.disk.records.at(-1)).toEqual({
				kind: "intent",
				operation,
			});
			await expect(store.get(sessionId)).rejects.toMatchObject({
				code: -32_603,
			});
			const listed = await store.list({});
			expect(listed.sessions.map((row) => row.sessionId)).toEqual([sessionId]);
			const closing = f.close();
			const crashDir = await directory();
			// Copy the real durable file while the effectful runtime is still blocked; no record injection.
			await copyFile(
				join(dir, `${sessionId}.json`),
				join(crashDir, `${sessionId}.json`),
			);
			await refuseRecovery(crashDir, sessionId);
			expect(await readFile(effectPath, "utf8")).toBe("effect\n");
			gate.resolve();
			await closing;
			await pending;
			const settled = await store.get(sessionId);
			expect(settled?.records.at(-1)).toMatchObject({
				kind: "checkpoint",
				state: { runtime: { effects: 1 } },
			});
			await expect(
				createSessionStore(crashDir).get(sessionId),
			).rejects.toMatchObject({ code: -32_603 });
		},
	);

	it.each(["prompt", "config"] as const)(
		"does not invoke %s or overwrite its previous checkpoint when intent persistence fails",
		async (operation) => {
			const store = createSessionStore(await directory());
			const prompt = vi.fn(async () => "completed" as const);
			const setConfig = vi.fn(async () => config("b"));
			const f = open(
				() => ({ ...runtime(), prompt, setConfig, getConfig: () => config() }),
				{
					...store,
					save: async (row) => {
						if (row.records.at(-1)?.kind === "intent") {
							throw new Error("intent write failed");
						}
						await store.save(row);
					},
				},
			);
			await f.initialize();
			const { sessionId } = await f.newSession();
			const before = await store.get(sessionId);
			const pending =
				operation === "prompt"
					? f.prompt(sessionId)
					: f.peer.agent.request("session/set_config_option", {
							sessionId,
							configId: "mode",
							value: "b",
						});
			await expect(pending).rejects.toMatchObject({ code: -32_603 });
			expect(prompt).not.toHaveBeenCalled();
			expect(setConfig).not.toHaveBeenCalled();
			expect(await store.get(sessionId)).toEqual(before);
			await expect(f.prompt(sessionId)).rejects.toMatchObject({
				code: -32_600,
			});
		},
	);

	it("waits for the intent write before running a turn and retains intent if its final checkpoint fails", async () => {
		const dir = await directory();
		const store = createSessionStore(dir);
		const gate = deferred<void>();
		const writing = deferred<void>();
		const prompt = vi.fn(async () => "completed" as const);
		const f = open(() => ({ ...runtime(), prompt }), {
			...store,
			save: async (row) => {
				if (row.records.at(-1)?.kind === "intent") {
					writing.resolve();
					await gate.promise;
				} else if (row.records.some((record) => record.kind === "intent")) {
					throw new Error("checkpoint write failed");
				}
				await store.save(row);
			},
		});
		cleanup.push(async () => {
			gate.resolve();
		});
		await f.initialize();
		const { sessionId } = await f.newSession();
		const pending = f.prompt(sessionId);
		await writing.promise;
		expect(prompt).not.toHaveBeenCalled();
		gate.resolve();
		await expect(pending).rejects.toMatchObject({ code: -32_603 });
		expect(prompt).toHaveBeenCalledTimes(1);
		await f.close();
		await refuseRecovery(dir, sessionId);
	});

	it.each([
		"auth",
		"factory config",
		"capabilities",
		"current config",
	] as const)(
		"retains the last good checkpoint when nonmutating %s preflight fails",
		async (failure) => {
			const store = createSessionStore(await directory());
			const source = open(runtime, store);
			await source.initialize();
			const { sessionId } = await source.newSession();
			await source.close();
			const before = await store.get(sessionId);
			const restore = vi.fn();
			const dispose = vi.fn(async () => {});
			const createSession = vi.fn(async (): Promise<RuntimeSession> => {
				expect(await store.get(sessionId)).toEqual(before);
				if (failure === "auth") {
					throw nativeAuthRequired();
				}
				if (failure === "factory config") {
					throw new Error("malformed current config");
				}
				if (failure === "capabilities") {
					return { prompt: async () => "completed", dispose };
				}
				return {
					...runtime(),
					restore,
					dispose,
					getConfig: () => config("not-an-option"),
				};
			});
			const f = open(createSession, store);
			await f.initialize();
			await expect(
				f.peer.agent.request("session/load", {
					sessionId,
					cwd: CWD,
					mcpServers: [],
				}),
			).rejects.toMatchObject({
				code:
					failure === "auth"
						? RequestError.authRequired().code
						: RequestError.internalError().code,
			});
			expect(restore).not.toHaveBeenCalled();
			expect(f.updates).toEqual([]);
			expect(await store.get(sessionId)).toEqual(before);
			createSession.mockImplementation(async () => ({
				...runtime(),
				restore,
				dispose,
			}));
			await f.peer.agent.request("session/resume", { sessionId, cwd: CWD });
			expect(restore).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["restore", "restore config"] as const)(
		"marks %s before mutation and refuses automatic retry after restoration fails",
		async (stage) => {
			const dir = await directory();
			const store = createSessionStore(dir);
			const source = open(
				() => ({ ...runtime(), getConfig: () => config("b") }),
				store,
			);
			await source.initialize();
			const { sessionId } = await source.newSession();
			await source.close();
			const effectPath = join(dir, "restore-effect.txt");
			const observed: StoredSession[] = [];
			const fail = async () => {
				observed.push(await readStored(dir, sessionId));
				await appendFile(effectPath, "effect\n");
				throw new Error("interrupted restore");
			};
			const backend: RuntimeSession = {
				...runtime(),
				getConfig: () => config(),
				setConfig: fail,
				...(stage === "restore"
					? {
							restore: () => {
								observed.push(
									JSON.parse(
										readFileSync(join(dir, `${sessionId}.json`), "utf8"),
									),
								);
								appendFileSync(effectPath, "effect\n");
								throw new Error("interrupted restore");
							},
						}
					: {}),
			};
			const restoring = open(() => backend, store);
			await restoring.initialize();
			await expect(
				restoring.peer.agent.request("session/load", {
					sessionId,
					cwd: CWD,
					mcpServers: [],
				}),
			).rejects.toMatchObject({ code: -32_603 });
			const disk = await readStored(dir, sessionId);
			expect(disk.records.at(-1)).toEqual({
				kind: "intent",
				operation: "restore",
			});
			expect(observed[0].records.at(-1)).toEqual({
				kind: "intent",
				operation: "restore",
			});
			expect(await readFile(effectPath, "utf8")).toBe("effect\n");
			await refuseRecovery(dir, sessionId);
		},
	);
});
