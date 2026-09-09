import { execFile } from "node:child_process";
// oxlint-disable-next-line import/no-namespace -- Fault injection must spy on the same ESM bindings as the store.
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "./auth-store.ts";

/** A configurable module facade permits fault injection while retaining real filesystem IO. */
vi.mock(import("node:fs/promises"), async (importOriginal) => ({
	...(await importOriginal()),
}));

/** Filesystem tests always use disposable user-private state outside the checkout. */
const PRIVATE_MODE = 0o700;
/** Match the store's POSIX credential mode without changing the process umask. */
const SECRET_MODE = 0o600;
/** Stat includes file-type bits. */
const PERMISSIONS = 0o777;
/** Contended writers run in different Node processes, not just different instances. */
const WRITERS = 3;
/** Enough mutations to expose lost document updates. */
const UPDATES = 6;
/** Bound child failures, including an unexpected lock hang. */
const CHILD_TIMEOUT_MS = 15_000;
/** Execute real independent Node processes without putting credentials on the command line. */
const runWorker = async (script: string, stateDir: string): Promise<void> => {
	await promisify(execFile)(
		process.execPath,
		[
			"--import",
			pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
			"--input-type=module",
			"--eval",
			script,
			stateDir,
		],
		{ timeout: CHILD_TIMEOUT_MS },
	);
};

/** Fake expired token data never leaves the test's temporary directory. */
const fakeOAuth = {
	type: "oauth" as const,
	access: "fake-access",
	refresh: "fake-refresh",
	expires: 0,
};

/** Controllable callbacks make lock ownership and cancellation assertions deterministic. */
const deferred = () => {
	let resolve: (() => void) | undefined = undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve: () => resolve!() };
};

/** Keep permission assertions independent of filesystem stat type bits. */
const permissions = async (
	path: Parameters<typeof fs.stat>[0],
): Promise<number> => {
	const stat = await fs.stat(path);
	return stat.mode & PERMISSIONS;
};

describe.skipIf(process.platform === "win32")(
	"private credential store",
	() => {
		let root = "";
		let stateDir = "";
		let path = "";
		beforeEach(async () => {
			root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "d3r-auth-"));
			stateDir = join(root, "private");
			path = join(stateDir, "credentials.json");
		});
		afterEach(async () => {
			vi.restoreAllMocks();
			await fs.rm(root, { recursive: true, force: true });
		});

		it("implements missing/read/list/modify/delete without exposing secret metadata", async () => {
			const store = await createCredentialStore({ stateDir });
			expect(await store.read("openai")).toBeUndefined();
			expect(await store.list()).toEqual([]);
			const credential = {
				type: "api_key" as const,
				key: "fake-key",
				env: { ACCOUNT: "fake-account" },
			};
			expect(await store.modify("openai", async () => credential)).toEqual(
				credential,
			);
			expect(await store.modify("openai", async () => undefined)).toEqual(
				credential,
			);
			expect(await store.list()).toEqual([
				{ providerId: "openai", type: "api_key" },
			]);
			await store.delete("openai");
			expect(await store.read("openai")).toBeUndefined();
		});

		it("reloads disk across instances and preserves other providers", async () => {
			const first = await createCredentialStore({ stateDir });
			const second = await createCredentialStore({ stateDir });
			await Promise.all([
				first.modify("openai", async () => ({
					type: "api_key",
					key: "fake-a",
				})),
				second.modify("anthropic", async () => fakeOAuth),
			]);
			expect(await first.read("anthropic")).toEqual(fakeOAuth);
			expect(await second.read("openai")).toEqual({
				type: "api_key",
				key: "fake-a",
			});
			await second.delete("anthropic");
			expect(await first.read("anthropic")).toBeUndefined();
		});

		it("uses atomic replacement and private temporary/lock files", async () => {
			const store = await createCredentialStore({ stateDir });
			await store.modify("openai", async () => ({
				type: "api_key",
				key: "old-fake-key",
			}));
			const previous = await fs.readFile(path, "utf8");
			const originalRename = fs.rename;
			const rename = vi
				.spyOn(fs, "rename")
				.mockImplementationOnce(async (source, destination) => {
					expect(await fs.readFile(path, "utf8")).toBe(previous);
					expect(
						JSON.parse(await fs.readFile(source, "utf8")).credentials.openai
							.key,
					).toBe("new-fake-key");
					if (process.platform !== "win32") {
						expect(await permissions(source)).toBe(SECRET_MODE);
						expect(await permissions(`${path}.lock`)).toBe(PRIVATE_MODE);
					}
					await originalRename(source, destination);
				});
			await store.modify("openai", async () => ({
				type: "api_key",
				key: "new-fake-key",
			}));
			expect(rename).toHaveBeenCalledOnce();
			expect(await fs.readdir(stateDir)).toEqual(["credentials.json"]);
			if (process.platform !== "win32") {
				expect(await permissions(stateDir)).toBe(PRIVATE_MODE);
				expect(await permissions(path)).toBe(SECRET_MODE);
			}
		});

		it("preserves the previous document and removes temp files after a failed rename", async () => {
			const store = await createCredentialStore({ stateDir });
			await store.modify("openai", async () => ({
				type: "api_key",
				key: "old-fake-key",
			}));
			const before = await fs.readFile(path, "utf8");
			vi.spyOn(fs, "rename").mockRejectedValueOnce(
				new Error("fake-secret-in-filesystem-error"),
			);
			const failure = await store
				.modify("openai", async () => ({ type: "api_key", key: "replacement" }))
				.catch((error) => error);
			expect(String(failure)).not.toContain("fake-secret");
			expect(failure.cause).toBeUndefined();
			expect(await fs.readFile(path, "utf8")).toBe(before);
			expect(await fs.readdir(stateDir)).toEqual(["credentials.json"]);
		});

		it.each([
			'{"fake-secret":',
			JSON.stringify({ version: 99, credentials: {} }),
			JSON.stringify({
				version: 1,
				credentials: { openai: { type: "oauth", access: "fake-secret" } },
			}),
			JSON.stringify({
				version: 1,
				credentials: { openai: { type: "api_key", env: { API_KEY: 1 } } },
			}),
		])(
			"fails closed on malformed state without overwriting or echoing it (%#)",
			async (contents) => {
				const store = await createCredentialStore({ stateDir });
				await fs.writeFile(path, contents, { mode: SECRET_MODE });
				const callback = vi.fn(async () => ({
					type: "api_key" as const,
					key: "replacement",
				}));
				await expect(createCredentialStore({ stateDir })).rejects.toThrow(
					"Private credential operation failed",
				);
				await expect(store.read("openai")).rejects.toThrow(
					"Private credential operation failed",
				);
				await expect(store.modify("openai", callback)).rejects.not.toThrow(
					"fake-secret",
				);
				expect(callback).not.toHaveBeenCalled();
				expect(await fs.readFile(path, "utf8")).toBe(contents);
			},
		);

		it("redacts callback failures and invalid credential/provider input", async () => {
			const store = await createCredentialStore({ stateDir });
			const failure = await store
				.modify("openai", async () => {
					throw new Error("fake-refresh-token");
				})
				.catch((error) => error);
			expect(String(failure)).not.toContain("fake-refresh-token");
			expect(failure.cause).toBeUndefined();
			await expect(store.read("../fake-secret")).rejects.not.toThrow(
				"fake-secret",
			);
			expect(await store.list()).toEqual([]);
		});

		it("serializes delete after an active refresh callback", async () => {
			const store = await createCredentialStore({ stateDir });
			const other = await createCredentialStore({ stateDir });
			await store.modify("openai", async () => fakeOAuth);
			const entered = deferred();
			const resume = deferred();
			const refresh = store.modify("openai", async () => {
				entered.resolve();
				await resume.promise;
				return { ...fakeOAuth, access: "rotated-fake-token" };
			});
			await entered.promise;
			const logout = other.delete("openai");
			resume.resolve();
			await Promise.all([refresh, logout]);
			expect(await store.read("openai")).toBeUndefined();
		});

		it("cancels a lock waiter without running its callback or unlocking active work", async () => {
			const store = await createCredentialStore({ stateDir });
			const entered = deferred();
			const resume = deferred();
			const active = store.modify("openai", async () => {
				entered.resolve();
				await resume.promise;
				return fakeOAuth;
			});
			await entered.promise;
			const controller = new AbortController();
			const callback = vi.fn(async () => fakeOAuth);
			const waiting = store.modify("openai", callback, {
				signal: controller.signal,
			});
			controller.abort(new Error("fake-secret-abort-reason"));
			await expect(waiting).rejects.not.toThrow("fake-secret");
			expect(callback).not.toHaveBeenCalled();
			const lock = await fs.stat(`${path}.lock`);
			expect(lock.isDirectory()).toBe(true);
			resume.resolve();
			await active;
		});

		it("keeps the lock until an aborted callback settles", async () => {
			const store = await createCredentialStore({ stateDir });
			const entered = deferred();
			const resume = deferred();
			const controller = new AbortController();
			const active = store.modify(
				"openai",
				async () => {
					entered.resolve();
					await resume.promise;
					return fakeOAuth;
				},
				{ signal: controller.signal },
			);
			const rejected = expect(active).rejects.toThrow(
				"Private credential operation failed",
			);
			await entered.promise;
			controller.abort();
			const lock = await fs.stat(`${path}.lock`);
			expect(lock.isDirectory()).toBe(true);
			resume.resolve();
			await rejected;
			expect(await store.read("openai")).toBeUndefined();
		});

		it.skipIf(process.platform === "win32")(
			"refuses symlink directories, credentials and lock paths without touching targets",
			async () => {
				await fs.mkdir(join(root, "target"), { mode: PRIVATE_MODE });
				await fs.symlink(join(root, "target"), stateDir);
				await expect(createCredentialStore({ stateDir })).rejects.toThrow(
					"Private credential operation failed",
				);
				await fs.unlink(stateDir);
				const store = await createCredentialStore({ stateDir });
				const target = join(root, "target", "secret");
				await fs.writeFile(target, "untouched", { mode: SECRET_MODE });
				await fs.symlink(target, path);
				await expect(
					store.modify("openai", async () => fakeOAuth),
				).rejects.toThrow("Private credential operation failed");
				expect(await fs.readFile(target, "utf8")).toBe("untouched");
				await fs.unlink(path);
				await fs.symlink(join(root, "target"), `${path}.lock`);
				await expect(store.list()).rejects.toThrow(
					"Private credential operation failed",
				);
			},
		);

		it.skipIf(process.platform === "win32")(
			"refuses hard-linked credentials and insecure modes without broad chmod",
			async () => {
				const store = await createCredentialStore({ stateDir });
				await store.modify("openai", async () => fakeOAuth);
				await fs.link(path, join(root, "linked"));
				await expect(store.read("openai")).rejects.toThrow(
					"Private credential operation failed",
				);
				await fs.unlink(join(root, "linked"));
				const insecure = 0o644;
				await fs.chmod(path, insecure);
				await expect(store.read("openai")).rejects.toThrow(
					"Private credential operation failed",
				);
				expect(await permissions(path)).toBe(insecure);
				const publicDirectory = 0o755;
				await fs.chmod(stateDir, publicDirectory);
				await expect(createCredentialStore({ stateDir })).rejects.toThrow(
					"Private credential operation failed",
				);
			},
		);

		it("refuses versioned state and relative paths", async () => {
			await fs.mkdir(join(root, ".git"));
			await expect(createCredentialStore({ stateDir })).rejects.toThrow(
				"Private credential operation failed",
			);
			await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(
				createCredentialStore({ stateDir: ".agents/private" }),
			).rejects.toThrow("Private credential operation failed");
		});

		it(
			"serializes read-modify-write across processes, including provider-independent updates",
			async () => {
				const store = await createCredentialStore({ stateDir });
				await store.modify("shared", async () => ({ ...fakeOAuth, count: 0 }));
				const moduleUrl = new URL("auth-store.ts", import.meta.url).href;
				await Promise.all(
					Array.from({ length: WRITERS }, async (_, index) => {
						const script = `
				import { createCredentialStore } from ${JSON.stringify(moduleUrl)};
				const store = await createCredentialStore({ stateDir: process.argv[1] });
				await Promise.all(Array.from({ length: ${UPDATES} }, () => store.modify("shared", async current => {
					await new Promise(resolve => setTimeout(resolve, 5));
					return { ...current, count: current.count + 1 };
				})));
				await store.modify("worker-${index}", async () => ({ type: "api_key", key: "fake-worker-key" }));
			`;
						await runWorker(script, stateDir);
					}),
				);
				expect(await store.read("shared")).toMatchObject({
					count: WRITERS * UPDATES,
				});
				expect(await store.list()).toHaveLength(WRITERS + 1);
			},
			CHILD_TIMEOUT_MS,
		);

		it(
			"refreshes a rotated OAuth token only once across processes",
			async () => {
				const store = await createCredentialStore({ stateDir });
				await store.modify("fake", async () => ({
					...fakeOAuth,
					rotations: 0,
				}));
				const moduleUrl = new URL("auth.ts", import.meta.url).href;
				const script = `
		import { createModelRuntime } from ${JSON.stringify(moduleUrl)};
		globalThis.fetch = async () => { throw new Error("No provider network in tests"); };
		const models = await createModelRuntime({ stateDir: process.argv[1] });
		models.setProvider({
			id: "fake", name: "Fake", getModels: () => [],
			stream: () => { throw new Error("No requests in tests"); },
			streamSimple: () => { throw new Error("No requests in tests"); },
			auth: { oauth: {
				name: "Fake OAuth", login: async () => { throw new Error("No login in tests"); },
				refresh: async credential => {
					await new Promise(resolve => setTimeout(resolve, 50));
					return { ...credential, rotations: credential.rotations + 1, access: "fake-rotated", expires: Date.now() + 3600000 };
				},
				toAuth: async credential => ({ apiKey: credential.access }),
			} },
		});
		await models.getAuth("fake");
	`;
				await Promise.all(
					Array.from({ length: WRITERS }, () => runWorker(script, stateDir)),
				);
				expect(await store.read("fake")).toMatchObject({
					rotations: 1,
					access: "fake-rotated",
				});
			},
			CHILD_TIMEOUT_MS,
		);
	},
);
