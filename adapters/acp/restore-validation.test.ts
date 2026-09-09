import { createSessionStore, type SessionStore } from "@d3r/adapter-acp/server";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CWD, fixture, runtime } from "./test-support.ts";
import { validateRestoreConfig } from "./config.ts";

/** A stable selector exposes the difference between invalid current metadata and an unavailable saved value. */
const modelConfig = (value = "a", values = ["a", "b"]) => [
	{
		id: "model",
		name: "Model",
		category: "model" as const,
		value,
		options: values.map((option) => ({ value: option, name: option })),
	},
];
/** Validation failures must leave the original bytes intact, while mutation failures remain quarantined. */
describe("native restore preflight", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const open = (
		factory: Parameters<typeof fixture>[0],
		store: SessionStore,
	) => {
		const f = fixture(factory, async () => {}, { deps: { store } });
		cleanup.push(f.close);
		return f;
	};
	const savedSession = async () => {
		const dir = await mkdtemp(join(tmpdir(), "d3r-restore-validation-"));
		directories.push(dir);
		const store = createSessionStore(dir);
		const save = vi.fn(store.save);
		const observedStore = { ...store, save };
		const checkpoint = { model: "a", content: "pinned state" };
		const source = open(
			() => ({
				...runtime(),
				getConfig: () => modelConfig(),
				snapshot: () => checkpoint,
			}),
			observedStore,
		);
		await source.initialize();
		const { sessionId } = await source.newSession();
		await source.close();
		const file = join(dir, `${sessionId}.json`);
		const bytes = await readFile(file, "utf8");
		save.mockClear();
		return {
			dir,
			store: observedStore,
			save,
			checkpoint,
			sessionId,
			file,
			bytes,
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

	it.each([
		"backend validation",
		"saved value",
		"saved selector",
		"saved selector with backend validation",
	] as const)(
		"does not write intent or invoke restore when %s validation fails",
		async (failure) => {
			const { store, save, checkpoint, sessionId, file, bytes } =
				await savedSession();
			const restore = vi.fn();
			const setConfig = vi.fn(async () => modelConfig());
			const dispose = vi.fn(async () => {});
			const validateRestore = vi.fn(() => {
				if (failure === "backend validation") {
					throw new Error("Saved roots differ");
				}
			});
			const f = open(
				() => ({
					...runtime(),
					restore,
					setConfig,
					dispose,
					getConfig: () =>
						failure.startsWith("saved selector")
							? []
							: modelConfig(
									"b",
									failure === "saved value" ? ["b"] : ["a", "b"],
								),
					...(failure.includes("backend validation")
						? { validateRestore }
						: {}),
				}),
				store,
			);
			await f.initialize();
			await expect(
				f.peer.agent.request("session/load", {
					sessionId,
					cwd: CWD,
					mcpServers: [],
				}),
			).rejects.toMatchObject({ code: -32_603 });
			if (failure.includes("backend validation")) {
				expect(validateRestore).toHaveBeenCalledWith(checkpoint);
			}
			expect(save).not.toHaveBeenCalled();
			expect(restore).not.toHaveBeenCalled();
			expect(setConfig).not.toHaveBeenCalled();
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(f.updates).toEqual([]);
			expect(await readFile(file, "utf8")).toBe(bytes);
			expect(await store.get(sessionId)).toEqual(JSON.parse(bytes));
			const release = await store.acquire(sessionId);
			await release();
		},
	);

	it("rejects ambiguous duplicate selector IDs during preflight", () => {
		const backend = { ...runtime(), getConfig: () => modelConfig() };
		expect(() =>
			validateRestoreConfig(
				backend,
				[
					{ id: "model", value: "a" },
					{ id: "model", value: "b" },
				],
				"selectors",
			),
		).toThrow("Duplicate stored configuration selector");
	});

	it("does not certify a checkpoint when a setter fails to restore the selected value", async () => {
		const { store, save, checkpoint, sessionId } = await savedSession();
		const validateRestore = vi.fn();
		const restore = vi.fn();
		const setConfig = vi.fn(async () => modelConfig("a"));
		const f = open(
			() => ({
				...runtime(),
				validateRestore,
				restore,
				setConfig,
				getConfig: () => modelConfig("b"),
			}),
			store,
		);
		await f.initialize();
		await expect(
			f.peer.agent.request("session/resume", { sessionId, cwd: CWD }),
		).rejects.toMatchObject({ code: -32_603 });
		expect(validateRestore).toHaveBeenCalledWith(checkpoint);
		expect(restore).toHaveBeenCalledWith(checkpoint);
		expect(setConfig).toHaveBeenCalledWith("model", "a");
		expect(save).toHaveBeenCalledTimes(1);
		await expect(store.get(sessionId)).rejects.toMatchObject({ code: -32_603 });
	});

	it("does not undo an intent when mutation fails after successful validateRestore", async () => {
		const { dir, store, save, checkpoint, sessionId, file } =
			await savedSession();
		const order: string[] = [];
		const validateRestore = vi.fn((value: unknown) => {
			expect(value).toEqual(checkpoint);
			expect(save).not.toHaveBeenCalled();
			order.push("validate");
		});
		const restore = vi.fn(() => {
			const disk = JSON.parse(readFileSync(file, "utf8"));
			expect(disk.records.at(-1)).toEqual({
				kind: "intent",
				operation: "restore",
			});
			order.push("restore");
			appendFileSync(join(dir, "effect.txt"), "effect\n");
			throw new Error("Uncertain partial restore");
		});
		const f = open(
			() => ({
				...runtime(),
				getConfig: () => modelConfig(),
				validateRestore,
				restore,
			}),
			store,
		);
		await f.initialize();
		await expect(
			f.peer.agent.request("session/resume", { sessionId, cwd: CWD }),
		).rejects.toMatchObject({ code: -32_603 });
		expect(order).toEqual(["validate", "restore"]);
		expect(save).toHaveBeenCalledTimes(1);
		expect(await readFile(join(dir, "effect.txt"), "utf8")).toBe("effect\n");
		await expect(store.get(sessionId)).rejects.toMatchObject({ code: -32_603 });
	});
});
