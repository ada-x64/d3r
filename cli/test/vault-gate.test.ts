// Behavioural tests for the refuse-to-run gate. We pin three
// things: that the allow-list is sourced from the verb registry
// (no parallel list of verb names lives in the test fixture),
// that an allow-listed verb passes through cleanly, and that a
// gated verb in a directory with no registered vault produces the
// byte-exact stderr copy and a non-zero exit. The latter mirrors
// the `HOME=$(mktemp -d) ... || echo $?` smoke documented in the
// task notes.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALLOW_LIST, gate } from "../src/vault-gate.ts";
import { VERBS, gateExemptVerbs } from "../src/verbs/registry.ts";

const exemptName = (): string => {
	const first = VERBS.find((v) => v.gateExempt);
	if (!first) {
		throw new Error("registry has no gate-exempt verbs");
	}
	return first.name;
};

const gatedName = (): string => {
	const first = VERBS.find((v) => !v.gateExempt);
	if (!first) {
		throw new Error("registry has no gated verbs");
	}
	return first.name;
};

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

describe("vault-gate", () => {
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

	it("derives ALLOW_LIST from the verb registry", () => {
		expect([...ALLOW_LIST].toSorted()).toEqual(
			[...gateExemptVerbs()].toSorted(),
		);
	});

	it("passes through when the verb is allow-listed", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			throw new Error(`process.exit(${code ?? 0})`);
		}) as never);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		await expect(gate(exemptName(), env.workDir)).resolves.toBeUndefined();
		expect(exit).not.toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("refuses a gated verb outside any registered vault", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
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

		await expect(gate(gatedName(), env.workDir)).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(writes.join("")).toBe(
			`error: no d3r vault registered for ${env.workDir}\nhint: run \`d3r init\`\n`,
		);
	});

	it("admits a workdir under a flat `consumer` root", async () => {
		writeConfig(env.homeDir, `consumer: ${env.workDir}\n`);
		silenceExitAndStderr();
		await expect(gate(gatedName(), env.workDir)).resolves.toBeUndefined();
	});

	it("admits a workdir under a nested `vaults[].root` entry", async () => {
		writeConfig(
			env.homeDir,
			`vaults:\n  - root: ${env.workDir}\n  - path: /nonexistent/should/be/ignored\n`,
		);
		silenceExitAndStderr();
		await expect(gate(gatedName(), env.workDir)).resolves.toBeUndefined();
	});

	it("admits a workdir under a nested `vaults[].path` entry", async () => {
		writeConfig(env.homeDir, `vaults:\n  - path: ${env.workDir}\n`);
		silenceExitAndStderr();
		await expect(gate(gatedName(), env.workDir)).resolves.toBeUndefined();
	});

	it("admits a top-level root when `vaults` is a malformed object map", async () => {
		writeConfig(
			env.homeDir,
			`root: ${env.workDir}\nvaults:\n  primary:\n    root: /nonexistent/should/be/ignored\n`,
		);
		silenceExitAndStderr();
		await expect(gate(gatedName(), env.workDir)).resolves.toBeUndefined();
	});

	it("refuses a gated verb when ~/.d3r/config.yaml is malformed", async () => {
		writeConfig(env.homeDir, ":\n\t- not: valid: yaml\n  ][\n");
		const { writes } = silenceExitAndStderr();
		await expect(gate(gatedName(), env.workDir)).rejects.toThrow("exit:1");
		expect(writes.join("")).toContain("no d3r vault registered");
	});

	it("refuses a gated verb when ~/.d3r/config.yaml is absent", async () => {
		const { writes } = silenceExitAndStderr();
		await expect(gate(gatedName(), env.workDir)).rejects.toThrow("exit:1");
		expect(writes.join("")).toContain("no d3r vault registered");
	});

	it("refuses when no verb is supplied (bare-launch path)", async () => {
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

		await expect(gate(undefined, env.workDir)).rejects.toThrow("exit:1");
		expect(writes.join("")).toBe(
			`error: no d3r vault registered for ${env.workDir}\nhint: run \`d3r init\`\n`,
		);
	});
});
