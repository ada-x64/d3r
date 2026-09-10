/* oxlint-disable init-declarations, no-magic-numbers -- Real filesystem fixtures and explicit IO deadline assertions. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeVaultContext } from "./native-vault-status.ts";
import { type WorkspaceAccess } from "./resource-paths.ts";

/** Inject access faults without relying on OS privileges; all path checks use real files. */
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	const access = vi.fn(actual.access);
	return { ...actual, access, default: { ...actual, access } };
});

/** The installed entry point avoids depending on a d3r executable on PATH. */
const CLI_SCRIPT = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Live status must not create artifacts or confuse denied paths with absent vaults. */
describe("native pinned vault context", () => {
	let base: string;
	let cwd: string;
	let vault: string;
	let access: WorkspaceAccess;
	beforeEach(async () => {
		base = await fs.realpath(
			await fs.mkdtemp(join(tmpdir(), "d3r-native-vault-status-")),
		);
		cwd = join(base, "workspace");
		vault = join(cwd, ".agents", "vault");
		await fs.mkdir(cwd);
		access = {
			cwd,
			roots: [cwd],
			excludedDirectories: [join(cwd, "native-state")],
			signal: new AbortController().signal,
		};
	});
	afterEach(async () => {
		vi.mocked(fs.access).mockReset();
		vi.useRealTimers();
		await fs.rm(base, { recursive: true, force: true });
	});

	it("asks for approved initialization at the exact pin without creating any files", async () => {
		const context = await nativeVaultContext(vault, access);
		expect(context).toContain("Native vault status: missing.");
		expect(context).toContain(`Pinned vault root: ${JSON.stringify(vault)}`);
		expect(context).toContain("Ask the operator whether to run d3r vault init");
		expect(context).toContain("run_command");
		expect(context).toContain(
			JSON.stringify({
				command: process.execPath,
				args: [CLI_SCRIPT, "vault", "init", "--vault-root", vault],
				cwd,
			}),
		);
		expect(context).toContain("seeded templates and directories");
		expect(context).toContain("separate Git repository and initial commit");
		expect(context).toContain("no pushes");
		expect(context).toContain(
			"explicit user direction and normal command approval",
		);
		expect(context).toContain(
			"Do not auto-initialize, run mkdir, or use vault_write",
		);
		expect(context).toContain("declines or requests no vault artifacts");
		expect(context).toContain(
			"inline no-document audits and code work without a vault",
		);
		expect(context).toContain("do not repeatedly ask");
		expect(context).toContain(
			"recheck with vault_ls before any document phases within this turn",
		);
		expect(context).toContain("next router turn refreshes this status");
		expect(await fs.readdir(base, { recursive: true })).toEqual(["workspace"]);
		expect(fs.access).not.toHaveBeenCalled();
	});

	it("uses valid literal command arguments for paths with spaces, quotes, and metacharacters", async () => {
		cwd = join(base, "operator's workspace & notes");
		await fs.mkdir(cwd);
		vault = join(cwd, ".agents", "vault");
		const context = await nativeVaultContext(vault, {
			...access,
			cwd,
			roots: [cwd],
		});
		const commandLine = context
			.split("\n")
			.find((line) => line.includes("use run_command"))!;
		const command: unknown = JSON.parse(
			commandLine.slice(commandLine.indexOf("{")),
		);
		expect(command).toEqual({
			command: process.execPath,
			args: [CLI_SCRIPT, "vault", "init", "--vault-root", vault],
			cwd,
		});
		expect(isAbsolute(process.execPath)).toBe(true);
		expect(isAbsolute(CLI_SCRIPT)).toBe(true);
		const script = await fs.lstat(CLI_SCRIPT);
		expect(script.isFile()).toBe(true);
		expect(context).toContain("without assuming d3r is on PATH");
	});

	it("uses an existing directory without asking or seeding it", async () => {
		await fs.mkdir(vault, { recursive: true });
		const context = await nativeVaultContext(vault, access);
		expect(context).toContain("Native vault status: available.");
		expect(context).toContain("Use the native vault tools");
		expect(context).not.toMatch(/ask|init|run_command/i);
		expect(fs.access).toHaveBeenCalledWith(
			vault,
			constants.R_OK | constants.X_OK,
		);
		expect(await fs.readdir(vault)).toEqual([]);
	});

	it("refreshes missing, created, and removed status without discovering another vault", async () => {
		const other = join(base, ".agents", "vault");
		await fs.mkdir(other, { recursive: true });
		const missing = await nativeVaultContext(vault, access);
		expect(missing).toContain("Native vault status: missing.");
		expect(missing).not.toContain(JSON.stringify(other));
		await fs.mkdir(vault, { recursive: true });
		expect(await nativeVaultContext(vault, access)).toContain(
			"Native vault status: available.",
		);
		await fs.rm(vault, { recursive: true });
		expect(await nativeVaultContext(vault, access)).toBe(missing);
		expect(await fs.readdir(other)).toEqual([]);
	});

	it("accepts only explicitly trusted external vault roots", async () => {
		const external = join(base, "external-vault");
		await fs.mkdir(external);
		expect(await nativeVaultContext(external, access)).toContain(
			"Native vault status: unavailable.",
		);
		const context = await nativeVaultContext(external, {
			...access,
			roots: [cwd, external],
		});
		expect(context).toContain("Native vault status: available.");
		expect(context).toContain(JSON.stringify(external));
		expect(context).not.toMatch(/ask|init|run_command/i);
	});

	it.each([".agents", ".agents/vault"])(
		"treats a file at %s as unavailable, never as an initialization candidate",
		async (part) => {
			const path = join(cwd, part);
			await fs.mkdir(dirname(path), { recursive: true });
			await fs.writeFile(path, "keep this file");
			const context = await nativeVaultContext(vault, access);
			expect(context).toContain("Native vault status: unavailable.");
			expect(context).toContain("Inspect permissions, path type, symlinks");
			expect(context).toContain("Do not initialize, overwrite, or repoint");
			expect(context).not.toContain("d3r vault init");
			expect(context).not.toContain("run_command");
			expect(await fs.readFile(path, "utf8")).toBe("keep this file");
		},
	);

	it.each([
		{ part: ".agents", targetExists: true },
		{ part: ".agents", targetExists: false },
		{ part: ".agents/vault", targetExists: true },
		{ part: ".agents/vault", targetExists: false },
	])(
		"rejects symlink $part with targetExists=$targetExists even with a missing leaf",
		async ({ part, targetExists }) => {
			const target = join(base, "target");
			if (targetExists) {
				await fs.mkdir(target);
			}
			const link = join(cwd, part);
			await fs.mkdir(dirname(link), { recursive: true });
			await fs.symlink(
				target,
				link,
				process.platform === "win32" ? "junction" : "dir",
			);
			const context = await nativeVaultContext(vault, access);
			expect(context).toContain("Native vault status: unavailable.");
			expect(context).not.toContain("d3r vault init");
			expect(context).not.toContain("run_command");
			expect(fs.access).not.toHaveBeenCalled();
			const info = await fs.lstat(link);
			expect(info.isSymbolicLink()).toBe(true);
		},
	);

	it.each([".git", "native-state", ".agents/private"])(
		"rejects denied ancestor %s before suggesting initialization for a missing leaf",
		async (part) => {
			const denied = join(cwd, part);
			await fs.mkdir(denied, { recursive: true });
			const context = await nativeVaultContext(join(denied, "vault"), access);
			expect(context).toContain("Native vault status: unavailable.");
			expect(context).not.toContain("d3r vault init");
			expect(context).not.toContain("run_command");
			expect(await fs.readdir(denied)).toEqual([]);
		},
	);

	it("does not interpret ENOENT from a missing workspace root as a missing vault", async () => {
		const missingCwd = join(base, "missing-workspace");
		const context = await nativeVaultContext(
			join(missingCwd, ".agents", "vault"),
			{
				...access,
				cwd: missingCwd,
				roots: [missingCwd],
			},
		);
		expect(context).toContain("Native vault status: unavailable.");
		expect(context).not.toContain("d3r vault init");
		expect(context).not.toContain("run_command");
	});

	it.each(["EACCES", "EPERM", "EIO", "ENOENT"])(
		"treats %s after observing the directory as unavailable, regardless of OS privileges",
		async (code) => {
			await fs.mkdir(vault, { recursive: true });
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("access failed"), { code }),
			);
			const context = await nativeVaultContext(vault, access);
			expect(context).toContain("Native vault status: unavailable.");
			expect(context).not.toContain("d3r vault init");
			expect(context).not.toContain("run_command");
			expect(await fs.readdir(vault)).toEqual([]);
		},
	);

	it("propagates a pre-aborted signal rather than returning initialization guidance", async () => {
		const reason = new Error("cancelled before probe");
		await expect(
			nativeVaultContext(vault, {
				...access,
				signal: AbortSignal.abort(reason),
			}),
		).rejects.toBe(reason);
		expect(fs.access).not.toHaveBeenCalled();
		expect(await fs.readdir(cwd)).toEqual([]);
	});

	it.each(["abort", "deadline"])(
		"interrupts stalled filesystem access on %s",
		async (interruption) => {
			await fs.mkdir(vault, { recursive: true });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			vi.mocked(fs.access).mockImplementationOnce(() => {
				entered();
				return new Promise<void>(() => undefined);
			});
			const controller = new AbortController();
			const pending = nativeVaultContext(vault, {
				...access,
				signal: controller.signal,
			});
			if (interruption === "abort") {
				const reason = new Error("cancelled during probe");
				const rejected = expect(pending).rejects.toBe(reason);
				await started;
				controller.abort(reason);
				await rejected;
			} else {
				await started;
				await vi.advanceTimersByTimeAsync(30_000);
				const context = await pending;
				expect(context).toContain("Native vault status: unavailable.");
				expect(context).not.toContain("run_command");
			}
		},
	);
});
