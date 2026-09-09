import { client, RequestError } from "@agentclientprotocol/sdk";
import {
	createSessionStore,
	type StoredSession,
} from "@d3r/adapter-acp/server";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CWD, deferred, fixture, runtime } from "./test-support.ts";

/** A remote write remains part of the transaction even if cancellation settles the runtime first. */
describe("native client write ownership", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const setup = async (detached = false) => {
		const dir = await mkdtemp(join(tmpdir(), "d3r-client-write-"));
		directories.push(dir);
		const store = createSessionStore(dir);
		const gate = deferred<"success" | "error">();
		const issued = deferred<void>();
		const applied = deferred<void>();
		const events: string[] = [];
		const dispose = vi.fn(async () => {
			events.push("dispose");
		});
		const snapshot = vi.fn(() => {
			events.push("snapshot");
			return { state: "settled" };
		});
		const file = join(dir, "editor-file.txt");
		const app = client().onRequest("fs/write_text_file", async ({ params }) => {
			issued.resolve();
			const result = await gate.promise;
			if (result === "error") {
				events.push("write-error");
				throw RequestError.internalError();
			}
			await appendFile(params.path, params.content);
			events.push("write");
			applied.resolve();
			return {};
		});
		const f = fixture(
			(input) => ({
				...runtime(),
				dispose,
				snapshot,
				prompt: async (request) => {
					const writing = input.client!.writeTextFile!(
						file,
						"effect\n",
						request.signal,
					);
					if (detached) {
						void writing.catch(() => {});
					} else {
						await writing;
					}
					return "completed";
				},
			}),
			async () => {},
			{ deps: { store }, clientApp: app },
		);
		cleanup.push(async () => {
			gate.resolve("success");
			await f.close();
		});
		await f.peer.agent.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { writeTextFile: true } },
		});
		const { sessionId } = await f.newSession();
		events.length = 0;
		return {
			f,
			dir,
			file,
			store,
			sessionId,
			gate,
			issued,
			applied,
			events,
			dispose,
			snapshot,
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
		{ mode: "awaited", detached: false, result: "success" },
		{ mode: "awaited", detached: false, result: "error" },
		{ mode: "detached", detached: true, result: "success" },
	] as const)(
		"joins a $mode write until its delayed $result response before checkpoint, disposal, or unlock",
		async ({ detached, result }) => {
			const { f, store, sessionId, gate, issued, events, dispose, snapshot } =
				await setup(detached);
			const settled = vi.fn();
			const pending = f.prompt(sessionId).then((response) => {
				settled();
				return response;
			});
			await issued.promise;
			await f.peer.agent.notify("session/cancel", { sessionId });
			await f.peer.agent.request("session/list", {});
			const closed = vi.fn();
			const closing = f.peer.agent
				.request("session/close", { sessionId })
				.then(closed);
			await f.peer.agent.request("session/list", {});
			expect(settled).not.toHaveBeenCalled();
			expect(closed).not.toHaveBeenCalled();
			expect(dispose).not.toHaveBeenCalled();
			expect(snapshot).toHaveBeenCalledTimes(1);
			await expect(store.acquire(sessionId)).rejects.toMatchObject({
				code: -32_600,
			});
			await expect(store.get(sessionId)).rejects.toMatchObject({
				code: -32_603,
			});
			gate.resolve(result);
			await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
			await closing;
			expect(events).toEqual([
				result === "success" ? "write" : "write-error",
				"snapshot",
				"dispose",
			]);
			const saved = await store.get(sessionId);
			expect(saved?.records.at(-1)?.kind).toBe("checkpoint");
			const release = await store.acquire(sessionId);
			await release();
		},
	);

	it("leaves an incomplete transaction on disconnect even when the editor writes after disconnect", async () => {
		const {
			f,
			dir,
			file,
			store,
			sessionId,
			gate,
			issued,
			applied,
			dispose,
			snapshot,
		} = await setup();
		const pending = f.prompt(sessionId).catch(() => {});
		await issued.promise;
		await f.close();
		await pending;
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(snapshot).toHaveBeenCalledTimes(1);
		await expect(store.get(sessionId)).rejects.toMatchObject({ code: -32_603 });
		const disk: StoredSession = JSON.parse(
			await readFile(join(dir, `${sessionId}.json`), "utf8"),
		);
		expect(disk.records.at(-1)).toEqual({
			kind: "intent",
			operation: "prompt",
		});
		gate.resolve("success");
		await applied.promise;
		expect(await readFile(file, "utf8")).toBe("effect\n");
		const createSession = vi.fn(runtime);
		const recovered = fixture(createSession, async () => {}, {
			deps: { store: createSessionStore(dir) },
		});
		cleanup.push(recovered.close);
		await recovered.initialize();
		await expect(
			recovered.peer.agent.request("session/resume", { sessionId, cwd: CWD }),
		).rejects.toMatchObject({ code: -32_603 });
		expect(createSession).not.toHaveBeenCalled();
		expect(recovered.updates).toEqual([]);
	});
});
