/* oxlint-disable init-declarations, no-magic-numbers -- Filesystem fixtures and explicit discovery-budget cases. */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverVaultRoot, isAncestorVaultRoot } from "./resource-vault.ts";

/** Only access faults are injected; lstat, realpath, directories, and symlinks remain real. */
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	const access = vi.fn(actual.access);
	return { ...actual, access, default: { ...actual, access } };
});

/** Real path checks distinguish absent candidates from hostile nearer vaults. */
describe("upward vault discovery", () => {
	let base: string;
	let cwd: string;
	let vault: string;
	beforeEach(async () => {
		base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "d3r-vault-")));
		cwd = join(base, "repo", "worktrees", "topic");
		vault = join(base, "repo", ".agents", "vault");
		await fs.mkdir(cwd, { recursive: true });
	});
	afterEach(async () => {
		vi.mocked(fs.access).mockReset();
		await fs.rm(base, { recursive: true, force: true });
	});

	it("selects the nearest actual ancestor with local precedence, not an empty .agents container", async () => {
		await Promise.all([
			fs.mkdir(vault, { recursive: true }),
			fs.mkdir(join(cwd, ".agents")),
		]);
		expect(await discoverVaultRoot(cwd)).toBe(vault);
		const nearer = join(dirname(cwd), ".agents", "vault");
		await fs.mkdir(nearer, { recursive: true });
		expect(await discoverVaultRoot(cwd)).toBe(nearer);
		const local = join(cwd, ".agents", "vault");
		await fs.mkdir(local);
		expect(await discoverVaultRoot(cwd)).toBe(local);
	});

	it("does not scan descendants or siblings and leaves the absent cwd candidate uncreated", async () => {
		await Promise.all([
			fs.mkdir(join(cwd, "child", ".agents", "vault"), { recursive: true }),
			fs.mkdir(join(dirname(cwd), "sibling", ".agents", "vault"), {
				recursive: true,
			}),
		]);
		expect(await discoverVaultRoot(cwd)).toBe(join(cwd, ".agents", "vault"));
		await expect(fs.lstat(join(cwd, ".agents"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it.each([".agents", ".agents/vault"])(
		"rejects a non-directory %s instead of selecting a farther vault",
		async (part) => {
			await fs.mkdir(vault, { recursive: true });
			const hostile = join(cwd, part);
			await fs.mkdir(dirname(hostile), { recursive: true });
			await fs.writeFile(hostile, "not a directory");
			await expect(discoverVaultRoot(cwd)).rejects.toThrow(
				/canonical directory/,
			);
		},
	);

	it.each([".agents", ".agents/vault"])(
		"rejects symlinked %s, even when the target is a valid directory",
		async (part) => {
			await fs.mkdir(vault, { recursive: true });
			const hostile = join(cwd, part);
			await fs.mkdir(dirname(hostile), { recursive: true });
			await fs.symlink(
				vault,
				hostile,
				process.platform === "win32" ? "junction" : "dir",
			);
			await expect(discoverVaultRoot(cwd)).rejects.toThrow(/symlink/);
		},
	);

	it("rejects a dangling nearer vault instead of treating it as absent", async () => {
		await fs.mkdir(vault, { recursive: true });
		await fs.mkdir(join(cwd, ".agents"));
		await fs.symlink(
			join(base, "missing"),
			join(cwd, ".agents", "vault"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(discoverVaultRoot(cwd)).rejects.toThrow(/symlink/);
	});

	it.each(["EACCES", "ENOENT"])(
		"propagates %s after observing a candidate instead of silently selecting another ancestor",
		async (code) => {
			await fs.mkdir(vault, { recursive: true });
			const nearer = join(cwd, ".agents", "vault");
			await fs.mkdir(nearer, { recursive: true });
			const { access } = await vi.importActual<typeof fs>("node:fs/promises");
			vi.mocked(fs.access).mockImplementation(async (path, mode) => {
				if (path === nearer) {
					throw Object.assign(new Error("vault inaccessible"), {
						code,
					});
				}
				return access(path, mode);
			});
			await expect(discoverVaultRoot(cwd)).rejects.toThrow(
				"vault inaccessible",
			);
		},
	);

	it("bounds ancestry and rejects normalized aliases in checkpoint candidates", () => {
		expect(isAncestorVaultRoot(cwd, vault)).toBe(true);
		expect(isAncestorVaultRoot(cwd, `${vault}/../vault`)).toBe(false);
		expect(
			isAncestorVaultRoot(cwd, join(cwd, "child", ".agents", "vault")),
		).toBe(false);
		expect(isAncestorVaultRoot(cwd, dirname(vault))).toBe(false);
		expect(() =>
			isAncestorVaultRoot(join(base, ...Array<string>(256).fill("x")), vault),
		).toThrow(/ancestry limit/);
	});

	it("rejects sensitive ancestor candidates", async () => {
		const privateCwd = join(base, ".git", "workspace");
		await fs.mkdir(privateCwd, { recursive: true });
		await fs.mkdir(join(base, ".git", ".agents", "vault"), { recursive: true });
		await expect(discoverVaultRoot(privateCwd)).rejects.toThrow(/Sensitive/);
	});

	it("cancels before IO and interrupts stalled candidate checks with a bounded deadline", async () => {
		await fs.mkdir(vault, { recursive: true });
		const access = vi.mocked(fs.access);
		await expect(
			discoverVaultRoot(cwd, {
				signal: AbortSignal.abort(new Error("cancelled")),
			}),
		).rejects.toThrow("cancelled");
		expect(access).not.toHaveBeenCalled();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		access.mockImplementation(() => {
			entered();
			return new Promise<void>(() => undefined);
		});
		const controller = new AbortController();
		const pending = discoverVaultRoot(cwd, { signal: controller.signal });
		const rejected = expect(pending).rejects.toThrow(
			"cancelled during discovery",
		);
		await started;
		controller.abort(new Error("cancelled during discovery"));
		await rejected;
		await expect(discoverVaultRoot(cwd, { timeoutMs: 20 })).rejects.toThrow(
			/timed out/,
		);
	});
});
