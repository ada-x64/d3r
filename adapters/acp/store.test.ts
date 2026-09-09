import { randomUUID } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSessionStore,
	type SessionRecord,
	type StoredSession,
} from "./store.ts";

/** Small pages exercise all cursor transitions without large fixtures. */
const PAGE_SIZE = 2;

/** Build a minimal detached runtime checkpoint for filesystem tests. */
const row = (
	sessionId = randomUUID(),
	cwd = resolve("workspace"),
): StoredSession => ({
	version: 1,
	sessionId,
	cwd,
	additionalDirectories: [],
	updatedAt: new Date().toISOString(),
	records: [
		{ kind: "checkpoint", state: { runtime: { count: 0 }, config: [] } },
	],
});
/** Real filesystem tests cover the persistence boundary independently of ACP transports. */
describe("native session file store", () => {
	const directories: string[] = [];
	const open = async () => {
		const dir = await mkdtemp(join(tmpdir(), "d3r-store-"));
		directories.push(dir);
		return { dir, store: createSessionStore(dir, { pageSize: PAGE_SIZE }) };
	};

	afterEach(async () => {
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it("round-trips atomic private files and never serializes connection configuration or credentials", async () => {
		const { dir, store } = await open();
		const session = row();
		await store.save({
			...session,
			mcpServers: [{ env: [{ name: "KEY", value: "top-secret" }] }],
			records: [
				{
					kind: "checkpoint",
					state: {
						runtime: {
							messages: [],
							apiKey: "provider-secret",
							nested: {
								credentials: "private",
								headers: { Authorization: "Bearer secret" },
							},
							mcpServers: [{ command: "secret-command", args: ["secret-arg"] }],
						},
						config: [],
					},
				},
			],
		} as StoredSession);
		const text = await readFile(join(dir, `${session.sessionId}.json`), "utf8");
		expect(text).not.toMatch(/secret|mcpServers|credentials|Authorization/);
		const stored = await store.get(session.sessionId);
		expect(stored?.records).toEqual([
			{
				kind: "checkpoint",
				state: { runtime: { messages: [], nested: {} }, config: [] },
			},
		]);
		if (process.platform !== "win32") {
			const file = await stat(join(dir, `${session.sessionId}.json`));
			const permissionBits = 0o777;
			const privateMode = 0o600;
			expect(file.mode & permissionBits).toBe(privateMode);
		}
		expect(await readdir(dir)).toEqual([`${session.sessionId}.json`]);
	});

	it("leaves the old checkpoint intact on serialization failure", async () => {
		const { dir, store } = await open();
		const session = row();
		await store.save(session);
		const circular: { self?: unknown } = {};
		circular.self = circular;
		await expect(
			store.save({
				...session,
				records: [{ kind: "checkpoint", state: circular }],
			}),
		).rejects.toMatchObject({ code: -32_603 });
		expect(await store.get(session.sessionId)).toEqual(session);
		expect(await readdir(dir)).toEqual([`${session.sessionId}.json`]);
	});

	it.each([
		{ name: "empty", checkpoint: false, update: false },
		{ name: "update only", checkpoint: false, update: true },
		{ name: "update after a checkpoint", checkpoint: true, update: true },
	])(
		"refuses an interrupted $name journal instead of falling back to an older checkpoint",
		async ({ checkpoint, update }) => {
			const { dir, store } = await open();
			const session = row();
			await store.save(session);
			const records: SessionRecord[] = checkpoint ? [...session.records] : [];
			if (update) {
				records.push({
					kind: "update",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "uncommitted" },
					},
				});
			}
			const interrupted = { ...session, records };
			await expect(store.save(interrupted)).rejects.toMatchObject({
				code: -32_603,
			});
			expect(await store.get(session.sessionId)).toEqual(session);
			await writeFile(
				join(dir, `${session.sessionId}.json`),
				JSON.stringify(interrupted),
			);
			await expect(store.get(session.sessionId)).rejects.toMatchObject({
				code: -32_603,
			});
			await expect(store.list({})).rejects.toMatchObject({ code: -32_603 });
		},
	);

	it("ignores interrupted temporary replacements and keeps the last atomic checkpoint", async () => {
		const { dir, store } = await open();
		const session = row();
		await store.save(session);
		await writeFile(
			join(dir, `${session.sessionId}.${randomUUID()}.tmp`),
			'{"version":1',
		);
		const reopened = createSessionStore(dir);
		expect(await reopened.get(session.sessionId)).toEqual(session);
		const listed = await reopened.list({});
		expect(listed.sessions.map((item) => item.sessionId)).toEqual([
			session.sessionId,
		]);
		await reopened.delete(session.sessionId);
		expect(await reopened.get(session.sessionId)).toBeNull();
		const afterDelete = await reopened.list({});
		expect(afterDelete.sessions).toEqual([]);
	});

	it("never lets session IDs or cursors escape the store", async () => {
		const { store } = await open();
		await Promise.all(
			[
				"../outside",
				String.raw`..\outside`,
				"/absolute",
				"CON",
				"",
				"bad\0id",
			].map(async (id) => {
				await expect(store.get(id)).rejects.toMatchObject({ code: -32_602 });
				await expect(store.acquire(id)).rejects.toMatchObject({
					code: -32_602,
				});
				await expect(store.delete(id)).rejects.toMatchObject({ code: -32_602 });
			}),
		);
		await expect(store.list({ cursor: "../../outside" })).rejects.toMatchObject(
			{ code: -32_602 },
		);
	});

	it("paginates deterministic IDs, filters cwd, and tolerates deletion between pages", async () => {
		const { store } = await open();
		const ids = Array.from({ length: 5 }, () => randomUUID()).toSorted();
		await Promise.all(ids.map((id) => store.save(row(id))));
		await store.save(row(randomUUID(), resolve("elsewhere")));
		const first = await store.list({ cwd: resolve("workspace") });
		const secondPageEnd = 4;
		expect(first.sessions.map((session) => session.sessionId)).toEqual(
			ids.slice(0, PAGE_SIZE),
		);
		expect(first.nextCursor).toBeTypeOf("string");
		await store.delete(ids[1]);
		const second = await store.list({
			cwd: resolve("workspace"),
			cursor: first.nextCursor,
		});
		expect(second.sessions.map((session) => session.sessionId)).toEqual(
			ids.slice(PAGE_SIZE, secondPageEnd),
		);
		const third = await store.list({
			cwd: resolve("workspace"),
			cursor: second.nextCursor,
		});
		expect(third.sessions.map((session) => session.sessionId)).toEqual(
			ids.slice(secondPageEnd),
		);
		expect(third.nextCursor).toBeUndefined();
		await expect(
			store.list({ cwd: resolve("elsewhere"), cursor: first.nextCursor }),
		).rejects.toMatchObject({ code: -32_602 });
	});

	it("excludes duplicate backends across store instances and releases leases idempotently", async () => {
		const { dir, store } = await open();
		const id = randomUUID();
		const release = await store.acquire(id);
		await expect(createSessionStore(dir).acquire(id)).rejects.toMatchObject({
			code: -32_600,
		});
		await release();
		await release();
		const releaseAgain = await createSessionStore(dir).acquire(id);
		await releaseAgain();
		expect(await readdir(dir)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"refuses symlinks even when their target contains a valid session",
		async () => {
			const { dir, store } = await open();
			const session = row();
			const target = join(dir, "outside.json");
			await writeFile(target, JSON.stringify(session));
			await symlink(target, join(dir, `${session.sessionId}.json`));
			await expect(store.get(session.sessionId)).rejects.toMatchObject({
				code: -32_603,
			});
		},
	);

	it("rejects corrupt files and mismatched IDs without exposing their contents", async () => {
		const { dir, store } = await open();
		const id = randomUUID();
		await writeFile(join(dir, `${id}.json`), "secret-invalid-json");
		await expect(store.get(id)).rejects.toMatchObject({
			code: -32_603,
			message: "Internal error: Could not read stored session",
		});
		await writeFile(join(dir, `${id}.json`), JSON.stringify(row()));
		await expect(store.get(id)).rejects.toMatchObject({ code: -32_603 });
		expect(await store.get(randomUUID())).toBeNull();
	});
});
