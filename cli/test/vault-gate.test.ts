// Behavioural tests for the per-verb refuse-to-run precondition.
// We pin the byte-exact stderr copy and exit code on the refusal
// path, and the admission paths for each shape of
// `~/.d3r/config.yaml` we accept. There is no verb-name allow-list
// to test: the gate is a plain function each verb opts in to, and
// "which verbs opt in" is verified by the per-verb dist tests
// (e.g. `vault-init-dist.test.ts` proves `vault init` does *not*
// gate; `tool` and the bare-launch path gate by virtue of calling
// `requireRegisteredVault` themselves).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireRegisteredVault } from "../src/vault-gate.ts";

interface Env {
	homeDir: string;
	workDir: string;
	savedHome: string | undefined;
}

const makeEnv = (): Env => {
	const homeDir = mkdtempSync(join(tmpdir(), "d3r-gate-home-"));
	const workDir = mkdtempSync(join(tmpdir(), "d3r-gate-cwd-"));
	const savedHome = process.env.HOME;
	process.env.HOME = homeDir;
	return { homeDir, workDir, savedHome };
};

const writeConfig = (homeDir: string, body: string): void => {
	const dir = join(homeDir, ".d3r");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yaml"), body, "utf8");
};

const silenceExitAndStderr = (): { writes: string[] } => {
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`exit:${code ?? 0}`);
	}) as never);
	const writes: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation(((
		chunk: string | Uint8Array,
	) => {
		writes.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
		);
		return true;
	}) as never);
	return { writes };
};

describe("requireRegisteredVault", () => {
	let env: Env = { homeDir: "", workDir: "", savedHome: undefined };

	beforeEach(() => {
		env = makeEnv();
	});

	afterEach(() => {
		if (env.savedHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = env.savedHome;
		}
		rmSync(env.homeDir, { recursive: true, force: true });
		rmSync(env.workDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("refuses when no config and no registered vault covers cwd", () => {
		const { writes } = silenceExitAndStderr();
		expect(() => requireRegisteredVault(env.workDir)).toThrow("exit:1");
		expect(writes.join("")).toBe(
			`error: no d3r vault registered for ${env.workDir}\nhint: run \`d3r vault init\`\n`,
		);
	});

	it("admits a workdir under a flat `consumer` root", () => {
		writeConfig(env.homeDir, `consumer: ${env.workDir}\n`);
		silenceExitAndStderr();
		expect(() => requireRegisteredVault(env.workDir)).not.toThrow();
	});

	it("admits a workdir under a nested `vaults[].root` entry", () => {
		writeConfig(
			env.homeDir,
			`vaults:\n  - root: ${env.workDir}\n  - path: /nonexistent/should/be/ignored\n`,
		);
		silenceExitAndStderr();
		expect(() => requireRegisteredVault(env.workDir)).not.toThrow();
	});

	it("admits a workdir under a nested `vaults[].path` entry", () => {
		writeConfig(env.homeDir, `vaults:\n  - path: ${env.workDir}\n`);
		silenceExitAndStderr();
		expect(() => requireRegisteredVault(env.workDir)).not.toThrow();
	});

	it("admits a top-level root when `vaults` is a malformed object map", () => {
		writeConfig(
			env.homeDir,
			`root: ${env.workDir}\nvaults:\n  primary:\n    root: /nonexistent/should/be/ignored\n`,
		);
		silenceExitAndStderr();
		expect(() => requireRegisteredVault(env.workDir)).not.toThrow();
	});

	it("refuses when ~/.d3r/config.yaml is malformed", () => {
		writeConfig(env.homeDir, ":\n\t- not: valid: yaml\n  ][\n");
		const { writes } = silenceExitAndStderr();
		expect(() => requireRegisteredVault(env.workDir)).toThrow("exit:1");
		expect(writes.join("")).toContain("no d3r vault registered");
	});

	it("refuses when ~/.d3r/config.yaml is absent", () => {
		const { writes } = silenceExitAndStderr();
		expect(() => requireRegisteredVault(env.workDir)).toThrow("exit:1");
		expect(writes.join("")).toContain("no d3r vault registered");
	});
});
