/* oxlint-disable init-declarations, no-magic-numbers -- Filesystem fault fixtures and POSIX modes are test data. */
import {
	chmod,
	link,
	lstat,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWorkspaceWrite, type AtomicWriteIo } from "./resource-atomic.ts";

/** Real siblings plus injected write/fsync faults exercise the atomic publication boundary. */
describe("atomic workspace writes", () => {
	let cwd: string;
	let path: string;
	let controller: AbortController;
	const access = () => ({ cwd, roots: [cwd], signal: controller.signal });
	const io: AtomicWriteIo = { open, link, rename, unlink };
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "d3r-atomic-"));
		path = join(cwd, "file.txt");
		controller = new AbortController();
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("atomically replaces a complete file and preserves executable mode", async () => {
		await writeFile(path, "old text");
		await chmod(path, 0o751);
		const before = await lstat(path);
		await atomicWorkspaceWrite(
			{ path, oldText: "old text", newText: "new" },
			access(),
		);
		expect(await readFile(path, "utf8")).toBe("new");
		const after = await lstat(path);
		expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
		expect(after.ino).not.toBe(before.ino);
		expect(await readdir(cwd)).toEqual(["file.txt"]);
	});

	it.each(["partial write", "fsync", "rename"])(
		"preserves the preimage on %s failure",
		async (fault) => {
			await writeFile(path, "precious preimage");
			const injected: AtomicWriteIo = {
				...io,
				open: async (...args) => {
					const handle = await open(...args);
					if (fault === "partial write") {
						const write = handle.writeFile.bind(handle);
						vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
							await write("partial");
							throw new Error("injected failure");
						});
					}
					if (fault === "fsync") {
						vi.spyOn(handle, "sync").mockRejectedValueOnce(
							new Error("injected failure"),
						);
					}
					return handle;
				},
				rename:
					fault === "rename"
						? async () => {
								throw new Error("injected failure");
							}
						: rename,
			};
			await expect(
				atomicWorkspaceWrite(
					{ path, oldText: "precious preimage", newText: "replacement" },
					access(),
					injected,
				),
			).rejects.toThrow("injected failure");
			expect(await readFile(path, "utf8")).toBe("precious preimage");
			expect(await readdir(cwd)).toEqual(["file.txt"]);
		},
	);

	it.each([null, "existing"])(
		"cleans unpublished staging on cancellation for preimage %s",
		async (oldText) => {
			if (oldText !== null) {
				await writeFile(path, oldText);
			}
			const injected: AtomicWriteIo = {
				...io,
				open: async (...args) => {
					const handle = await open(...args);
					controller.abort(new Error("cancelled after exclusive creation"));
					return handle;
				},
			};
			await expect(
				atomicWorkspaceWrite(
					{ path, oldText, newText: "bad" },
					access(),
					injected,
				),
			).rejects.toThrow(/cancelled/);
			expect(await readdir(cwd)).toEqual(oldText === null ? [] : ["file.txt"]);
			if (oldText !== null) {
				expect(await readFile(path, "utf8")).toBe(oldText);
			}
		},
	);

	it("checks for conflicts after syncing the complete staging file", async () => {
		await writeFile(path, "old");
		const injected: AtomicWriteIo = {
			...io,
			open: async (...args) => {
				const handle = await open(...args);
				const sync = handle.sync.bind(handle);
				vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
					await sync();
					await writeFile(path, "external");
				});
				return handle;
			},
		};
		await expect(
			atomicWorkspaceWrite(
				{ path, oldText: "old", newText: "agent" },
				access(),
				injected,
			),
		).rejects.toThrow(/Stale snapshot/);
		expect(await readFile(path, "utf8")).toBe("external");
		expect(await readdir(cwd)).toEqual(["file.txt"]);
	});

	it("new-file publication cannot clobber a file created after the final check", async () => {
		const injected: AtomicWriteIo = {
			...io,
			link: async (source, destination) => {
				await writeFile(destination, "external");
				await link(source, destination);
			},
		};
		await expect(
			atomicWorkspaceWrite(
				{ path, oldText: null, newText: "agent" },
				access(),
				injected,
			),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(path, "utf8")).toBe("external");
		expect(await readdir(cwd)).toEqual(["file.txt"]);
	});

	it("does not publish a new file after cancellation during fsync", async () => {
		const injected: AtomicWriteIo = {
			...io,
			open: async (...args) => {
				const handle = await open(...args);
				vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
					controller.abort(new Error("cancelled during sync"));
				});
				return handle;
			},
		};
		await expect(
			atomicWorkspaceWrite(
				{ path, oldText: null, newText: "agent" },
				access(),
				injected,
			),
		).rejects.toThrow(/cancelled/);
		expect(await readdir(cwd)).toEqual([]);
	});
});
