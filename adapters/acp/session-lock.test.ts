import { randomUUID } from "node:crypto";
// oxlint-disable-next-line import/no-namespace -- Fault injection must reach the production ESM bindings.
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// oxlint-disable-next-line import/no-namespace -- Keep owner classification separate from registry mechanics.
import * as owners from "./lock-owner.ts";
import { acquireSessionLock } from "./session-lock.ts";
import { deferred } from "./test-support.ts";

vi.mock("node:fs/promises", async (original) => ({
	...(await original<typeof fs>()),
}));

/** Unverifiable metadata must fail closed with actionable guidance. */
const RECOVERY = /ownership could not be verified/;
/** Independent boundary values and a deliberately small OS read size. */
const LIMITS = { contenders: 3, claims: 128, bytes: 4096, chunk: 7 };
/** Fault injection caps real reads without replacing file contents, offsets, or EOF. */
const shortReads = (target: string, size: number) => {
	const { open } = fs;
	vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const file = await open(...args);
		if (args[0] === target) {
			const read = file.read.bind(file);
			const limited = (
				...[buffer, offset, length, position]: [
					Buffer,
					number,
					number,
					number | null,
				]
			) => read(buffer, offset, Math.min(length, size), position);
			vi.spyOn(file, "read").mockImplementation(limited as typeof file.read);
		}
		return file;
	});
};

/** Real registries exercise publication and withdrawal; only OS observations/faults are injected. */
describe("session lock registry", () => {
	const directories: string[] = [];
	const fixture = async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), "d3r-session-lock-"));
		directories.push(dir);
		const path = join(dir, `${randomUUID()}.lock`);
		const owner = await owners.currentLockOwner();
		const seed = async (recorded = owner) => {
			const id = randomUUID();
			const name = `${id}.json`;
			const file = join(path, name);
			const text = JSON.stringify({ id, owner: recorded });
			await fs.mkdir(path, { recursive: true });
			await fs.writeFile(file, text);
			return { id, name, file, text };
		};
		return { dir, path, owner, seed, acquire: () => acquireSessionLock(path) };
	};
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => fs.rm(dir, { recursive: true, force: true })),
		);
	});

	it("allows at most one of three simultaneous publishers to win, including mutual denial", async () => {
		const f = await fixture();
		const published = deferred<void>();
		const { rename } = fs;
		let count = 0;
		vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
			await rename(...args);
			if (++count === LIMITS.contenders) {
				published.resolve();
			}
			await published.promise;
		});
		const results = await Promise.allSettled(
			Array.from({ length: LIMITS.contenders }, f.acquire),
		);
		const winners = results.filter((result) => result.status === "fulfilled");
		expect(winners.length).toBeLessThanOrEqual(1);
		expect(await fs.readdir(f.path)).toHaveLength(winners.length);
		await Promise.all(winners.map((winner) => winner.value()));
		expect(await fs.readdir(f.path)).toEqual([]);
	});

	it("never steals an ancient live claim and makes old releases harmless to a newer owner", async () => {
		const f = await fixture();
		const release = await f.acquire();
		const [name] = await fs.readdir(f.path);
		const file = join(f.path, name);
		const text = await fs.readFile(file, "utf8");
		const ancient = new Date(0);
		await Promise.all(
			[f.path, file].map((path) => fs.utimes(path, ancient, ancient)),
		);
		await expect(f.acquire()).rejects.toThrow(/live D3R process/);
		expect(await fs.readFile(file, "utf8")).toBe(text);
		expect(await fs.readdir(f.path)).toEqual([name]);
		await release();
		const newer = await f.acquire();
		const names = await fs.readdir(f.path);
		expect(names).toHaveLength(1);
		expect(names).not.toContain(name);
		await release();
		expect(await fs.readdir(f.path)).toEqual(names);
		await expect(f.acquire()).rejects.toThrow(/live D3R process/);
		await newer();
		expect(await fs.readdir(f.path)).toEqual([]);
	});

	it("reclaims only proven-dead claims without replacing the registry directory", async () => {
		const f = await fixture();
		const old = await f.seed();
		const identity = await fs.stat(f.path);
		const status = vi.spyOn(owners, "lockOwnerStatus");
		status.mockResolvedValue("dead");
		const release = await f.acquire();
		expect(status).toHaveBeenCalledWith(f.owner);
		const names = await fs.readdir(f.path);
		expect(names).toHaveLength(1);
		expect(names).not.toContain(old.name);
		await release();
		expect(await fs.stat(f.path)).toMatchObject({
			dev: identity.dev,
			ino: identity.ino,
		});
		expect(await fs.readdir(f.path)).toEqual([]);
	});

	it.each(["unknown", "foreign", "malformed", "truncated", "mismatched ID"])(
		"preserves %s metadata and withdraws its own claim",
		async (kind) => {
			const f = await fixture();
			const claim = await f.seed(
				kind === "foreign"
					? { ...f.owner, host: `foreign-${randomUUID()}` }
					: f.owner,
			);
			const invalid: Record<string, string> = {
				malformed: "not JSON",
				truncated: claim.text.slice(0, -1),
				"mismatched ID": JSON.stringify({ id: randomUUID(), owner: f.owner }),
			};
			const text = invalid[kind] ?? claim.text;
			await fs.writeFile(claim.file, text);
			if (kind === "unknown") {
				vi.spyOn(owners, "lockOwnerStatus").mockResolvedValue("unknown");
			}
			await expect(f.acquire()).rejects.toThrow(RECOVERY);
			expect(await fs.readdir(f.path)).toEqual([claim.name]);
			expect(await fs.readFile(claim.file, "utf8")).toBe(text);
			expect(await fs.readdir(f.dir)).toEqual([basename(f.path)]);
		},
	);

	it("refuses an empty legacy regular lock without mutation", async () => {
		const f = await fixture();
		await fs.writeFile(f.path, "");
		const identity = await fs.stat(f.path);
		await expect(f.acquire()).rejects.toThrow(/legacy lock/);
		expect(await fs.readFile(f.path, "utf8")).toBe("");
		expect(await fs.stat(f.path)).toMatchObject({
			dev: identity.dev,
			ino: identity.ino,
			size: 0,
		});
		expect(await fs.readdir(f.dir)).toEqual([basename(f.path)]);
	});

	it.for(["directory symlink", "claim symlink", "hardlink"])(
		"denies a %s without changing its target",
		async (kind, { skip }) => {
			if (process.platform === "win32" && kind !== "hardlink") {
				skip();
			}
			const f = await fixture();
			const claim = await f.seed();
			const target = join(f.dir, "target");
			if (kind === "directory symlink") {
				await fs.rename(f.path, target);
				await fs.symlink(target, f.path, "dir");
			} else {
				await fs.rename(claim.file, target);
				await (kind === "hardlink"
					? fs.link(target, claim.file)
					: fs.symlink(target, claim.file));
			}
			vi.spyOn(owners, "lockOwnerStatus").mockResolvedValue("dead");
			await expect(f.acquire()).rejects.toThrow(RECOVERY);
			expect(await fs.readdir(f.path)).toEqual([claim.name]);
			expect(await fs.readFile(claim.file, "utf8")).toBe(claim.text);
			expect(await fs.readdir(f.dir)).toEqual(
				[basename(f.path), "target"].toSorted(),
			);
		},
	);

	it.each([
		{ claims: LIMITS.claims - 1, bytes: LIMITS.bytes, allowed: true },
		{ claims: LIMITS.claims, bytes: LIMITS.bytes, allowed: false },
		{ claims: 1, bytes: LIMITS.bytes + 1, allowed: false },
	])(
		"bounds $claims claims of $bytes bytes",
		async ({ claims, bytes, allowed }) => {
			const f = await fixture();
			const seeded = await Promise.all(
				Array.from({ length: claims }, async () => {
					const claim = await f.seed();
					await fs.writeFile(claim.file, claim.text.padEnd(bytes, " "));
					return claim.name;
				}),
			);
			vi.spyOn(owners, "lockOwnerStatus").mockResolvedValue("dead");
			if (allowed) {
				const release = await f.acquire();
				await release();
				expect(await fs.readdir(f.path)).toEqual([]);
			} else {
				await expect(f.acquire()).rejects.toThrow(RECOVERY);
				const remaining = await fs.readdir(f.path);
				expect(remaining.every((name) => seeded.includes(name))).toBe(true);
				if (bytes > LIMITS.bytes) {
					expect(remaining).toEqual(seeded);
				}
			}
			expect(await fs.readdir(f.dir)).toEqual([basename(f.path)]);
		},
	);

	it.each(["", "!"])(
		"reads through short chunks to EOF before parsing (trailer %j)",
		async (trailer) => {
			const f = await fixture();
			const claim = await f.seed();
			await fs.writeFile(claim.file, claim.text + trailer);
			shortReads(
				claim.file,
				trailer ? Buffer.byteLength(claim.text) : LIMITS.chunk,
			);
			vi.spyOn(owners, "lockOwnerStatus").mockResolvedValue("dead");
			if (trailer) {
				await expect(f.acquire()).rejects.toThrow(RECOVERY);
				expect(await fs.readdir(f.path)).toEqual([claim.name]);
				expect(await fs.readFile(claim.file, "utf8")).toBe(
					claim.text + trailer,
				);
			} else {
				const release = await f.acquire();
				await release();
				expect(await fs.readdir(f.path)).toEqual([]);
			}
		},
	);

	it.each(["publication", "scan"])(
		"cleans only its own claim/temp after failed %s",
		async (phase) => {
			const f = await fixture();
			const claim = await f.seed();
			const other = `${basename(f.path)}.${randomUUID()}.tmp`;
			await fs.writeFile(join(f.dir, other), "other publisher");
			if (phase === "publication") {
				vi.spyOn(fs, "rename").mockRejectedValueOnce(
					new Error("rename failed"),
				);
			} else {
				vi.spyOn(owners, "lockOwnerStatus").mockRejectedValueOnce(
					new Error("scan failed"),
				);
			}
			await expect(f.acquire()).rejects.toThrow(RECOVERY);
			expect(await fs.readdir(f.path)).toEqual([claim.name]);
			expect(await fs.readFile(claim.file, "utf8")).toBe(claim.text);
			expect(await fs.readdir(f.dir)).toEqual(
				[basename(f.path), other].toSorted(),
			);
			expect(await fs.readFile(join(f.dir, other), "utf8")).toBe(
				"other publisher",
			);
		},
	);

	it("leaves a failed release retryable instead of marking the claim released", async () => {
		const f = await fixture();
		const release = await f.acquire();
		const names = await fs.readdir(f.path);
		const error = Object.assign(new Error("denied"), { code: "EACCES" });
		const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(error);
		await expect(release()).rejects.toMatchObject({ code: "EACCES" });
		expect(await fs.readdir(f.path)).toEqual(names);
		unlink.mockRestore();
		await release();
		await release();
		expect(await fs.readdir(f.path)).toEqual([]);
	});
});
