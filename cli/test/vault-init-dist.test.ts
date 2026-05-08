// Dist-tier regression for `d3r vault init`. Execs the built
// CLI from `cli/dist/cli.js` so the test exercises the
// dist-shipped seed (`core/dist/seed/`) and the resolved
// `defaultSeedDir()`.
//
// If `cli/dist/cli.js` is absent the test fails loudly rather
// than skipping silently — a green CI on a missing build would
// hide breakage.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const distCli = path.join(repoRoot, "cli", "dist", "cli.js");
const seedRoot = path.join(repoRoot, "core", "seed");

let workdir = "";

beforeAll(() => {
	process.env.GIT_AUTHOR_NAME = "d3r-test";
	process.env.GIT_AUTHOR_EMAIL = "test@d3r.invalid";
	process.env.GIT_COMMITTER_NAME = "d3r-test";
	process.env.GIT_COMMITTER_EMAIL = "test@d3r.invalid";
});

beforeEach(() => {
	workdir = mkdtempSync(path.join(tmpdir(), "d3r-init-dist-"));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

const requireDistCli = (): void => {
	if (!existsSync(distCli)) {
		expect.fail(
			`cli/dist/cli.js missing at ${distCli}; run \`pnpm -r build\` first`,
		);
	}
};

/** Number of `.gitkeep` markers in the canonical seed. */
const SEED_GITKEEP_COUNT = 12;

describe("d3r vault init (dist)", () => {
	it("seeds a fresh vault and produces one chore commit", () => {
		requireDistCli();
		const vaultRoot = path.join(workdir, "v");
		execFileSync(
			process.execPath,
			[distCli, "vault", "init", "--vault-root", vaultRoot],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		statSync(path.join(vaultRoot, ".git", "HEAD"));
		statSync(path.join(vaultRoot, "AGENTS.md"));
		statSync(path.join(vaultRoot, ".misc", "templates", "design.md"));

		const log = execFileSync(
			"git",
			["-C", vaultRoot, "--no-pager", "log", "--oneline"],
			{ encoding: "utf8" },
		);
		const lines = log.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/chore: initial vault seed$/);

		// All 12 seed `.gitkeep` markers are tracked in the first commit.
		const tracked = execFileSync(
			"git",
			["-C", vaultRoot, "ls-tree", "-r", "--name-only", "HEAD"],
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n");
		expect(tracked.filter((p) => p.endsWith(".gitkeep"))).toHaveLength(
			SEED_GITKEEP_COUNT,
		);
	});

	it("byte-equals the seed tree (excluding .git/)", () => {
		requireDistCli();
		const vaultRoot = path.join(workdir, "v");
		execFileSync(
			process.execPath,
			[distCli, "vault", "init", "--vault-root", vaultRoot],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		// `diff -r` exits 0 only when trees are identical.
		execFileSync("diff", ["-r", "--exclude=.git", seedRoot, vaultRoot], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	});

	it("refuses a non-empty vault root", () => {
		requireDistCli();
		const vaultRoot = path.join(workdir, "v");
		execFileSync("mkdir", [vaultRoot]);
		execFileSync("touch", [path.join(vaultRoot, "preexisting")]);

		let exitCode: number | null = 0;
		let stderr = "";
		try {
			execFileSync(
				process.execPath,
				[distCli, "vault", "init", "--vault-root", vaultRoot],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (error) {
			const e = error as { status: number | null; stderr: Buffer };
			exitCode = e.status;
			stderr = e.stderr.toString("utf8");
		}
		expect(exitCode).not.toBe(0);
		expect(stderr).toMatch(/vault-not-empty/);
	});

	it("refuses a vault root with a pre-existing .git/", () => {
		requireDistCli();
		const vaultRoot = path.join(workdir, "v");
		// First init succeeds and produces a .git/.
		execFileSync(
			process.execPath,
			[distCli, "vault", "init", "--vault-root", vaultRoot],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		statSync(path.join(vaultRoot, ".git", "HEAD"));

		// Second init refuses with the more-specific error than
		// `vault-not-empty` (the `.git/` precondition wins).
		let exitCode: number | null = 0;
		let stderr = "";
		try {
			execFileSync(
				process.execPath,
				[distCli, "vault", "init", "--vault-root", vaultRoot],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (error) {
			const e = error as { status: number | null; stderr: Buffer };
			exitCode = e.status;
			stderr = e.stderr.toString("utf8");
		}
		expect(exitCode).not.toBe(0);
		expect(stderr).toMatch(/git-already-initialized/);
	});
});
