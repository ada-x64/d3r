// Dist-tier regression that pins the *negative* side of the
// per-verb vault-gate contract: verbs which opt in to
// `requireRegisteredVault` must refuse with the canonical
// stderr/exit-code pair when invoked outside any registered
// vault. If a future change deletes the gate call from one of
// these entry points, this test fails loudly -- the unit test
// in `vault-gate.test.ts` cannot catch that regression because
// it tests the function in isolation.
//
// HOME is repointed at an empty tmpdir so no `~/.d3r/config.yaml`
// can admit the cwd, and cwd is a fresh tmpdir for the same reason.
// The complementary positive case (that `vault init` does NOT
// gate) lives in `vault-init-dist.test.ts`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const distCli = path.join(repoRoot, "cli", "dist", "cli.js");

let homeDir = "";
let cwdDir = "";

beforeEach(() => {
	homeDir = mkdtempSync(path.join(tmpdir(), "d3r-refusal-home-"));
	cwdDir = mkdtempSync(path.join(tmpdir(), "d3r-refusal-cwd-"));
});

afterEach(() => {
	rmSync(homeDir, { recursive: true, force: true });
	rmSync(cwdDir, { recursive: true, force: true });
});

const requireDistCli = (): void => {
	if (!existsSync(distCli)) {
		expect.fail(
			`cli/dist/cli.js missing at ${distCli}; run \`pnpm -r build\` first`,
		);
	}
};

interface RunResult {
	exitCode: number | null;
	stderr: string;
	stdout: string;
}

const runDist = (argv: readonly string[]): RunResult => {
	try {
		const stdout = execFileSync(process.execPath, [distCli, ...argv], {
			cwd: cwdDir,
			env: { ...process.env, HOME: homeDir },
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		});
		return { exitCode: 0, stderr: "", stdout };
	} catch (error) {
		const e = error as {
			status: number | null;
			stderr: Buffer;
			stdout: Buffer;
		};
		return {
			exitCode: e.status,
			stderr: e.stderr.toString("utf8"),
			stdout: e.stdout.toString("utf8"),
		};
	}
};

describe("d3r refuse-to-run gate (dist)", () => {
	// Each row is one verb that calls `requireRegisteredVault` from its
	// own `run` handler. Membership in this table IS the contract --
	// adding a row forces the test author to confirm the new verb opts
	// in, and removing a `requireRegisteredVault` call from any listed
	// verb fails this test. The bare-launch path is included as
	// `__bare__`-via-no-verb because it gates inside `bare.ts`.
	const cases: readonly { name: string; argv: readonly string[] }[] = [
		{ name: "tool", argv: ["tool", "vault_ls"] },
		{ name: "bare-launch", argv: ["--some-flag"] },
	];

	it.each(cases)("$name refuses outside any registered vault", ({ argv }) => {
		requireDistCli();
		const { exitCode, stderr } = runDist(argv);
		expect(exitCode).toBe(1);
		expect(stderr).toMatch(new RegExp(`no d3r vault registered for ${cwdDir}`));
		expect(stderr).toContain("hint: run `d3r vault init`");
	});
});
