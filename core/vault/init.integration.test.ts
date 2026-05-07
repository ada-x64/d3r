// initVault integration coverage. Real `git`, real `mkdtemp`,
// real `core/seed/`. Pinning byte-equivalence of the produced
// vault tree (excluding `.git/`) against the seed source guards
// against the `fs.cp` Node #58947 footgun and any future drift
// in the seed enumeration.

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { initVault } from "./init.ts";
import { SEED_ROOT } from "./seed-root.ts";

/** Number of `.gitkeep` markers in the canonical seed; checked by the
 * happy-path test to catch accidental drops on copy. */
const SEED_GITKEEP_COUNT = 12;

beforeAll(() => {
	process.env.GIT_AUTHOR_NAME = "d3r-test";
	process.env.GIT_AUTHOR_EMAIL = "test@d3r.invalid";
	process.env.GIT_COMMITTER_NAME = "d3r-test";
	process.env.GIT_COMMITTER_EMAIL = "test@d3r.invalid";
});

let workdir = "";

beforeEach(async () => {
	workdir = await mkdtemp(path.join(tmpdir(), "d3r-init-it-"));
});

afterEach(async () => {
	await rm(workdir, { recursive: true, force: true });
});

const collectFiles = async (
	root: string,
	skip: ReadonlySet<string> = new Set(),
	prefix = "",
): Promise<string[]> => {
	const entries = await readdir(root, { withFileTypes: true });
	const considered = entries.filter(
		(entry) => !(skip.has(entry.name) && prefix === ""),
	);
	const childLists = await Promise.all(
		considered.map(async (entry) => {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				return collectFiles(path.join(root, entry.name), skip, rel);
			}
			return [rel];
		}),
	);
	return childLists.flat().toSorted();
};

describe("initVault integration", () => {
	it("seeds an empty vault with a single chore commit and the canonical tree", async () => {
		const vaultRoot = path.join(workdir, "vault");
		const result = await initVault({ vaultRoot });
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.vaultRoot).toBe(vaultRoot);
		expect(result.value.commit).toMatch(/^[0-9a-f]{40}$/);

		// Tree byte-equivalence (excluding .git/) against the seed.
		const vaultFiles = await collectFiles(vaultRoot, new Set([".git"]));
		const seedFiles = await collectFiles(SEED_ROOT);
		expect(vaultFiles).toEqual(seedFiles);

		// .git/HEAD exists and points at the commit subject.
		await stat(path.join(vaultRoot, ".git", "HEAD"));
		const log = execFileSync(
			"git",
			["-C", vaultRoot, "--no-pager", "log", "--oneline"],
			{ encoding: "utf8" },
		);
		const lines = log.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/chore: initial vault seed$/);

		// All seed `.gitkeep` markers are tracked in the first commit.
		const tracked = execFileSync(
			"git",
			["-C", vaultRoot, "ls-tree", "-r", "--name-only", "HEAD"],
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n");
		const trackedKeeps = tracked.filter((p) => p.endsWith(".gitkeep"));
		expect(trackedKeeps).toHaveLength(SEED_GITKEEP_COUNT);
	});

	it("refuses a non-empty vault root", async () => {
		const vaultRoot = path.join(workdir, "vault");
		await mkdir(vaultRoot, { recursive: true });
		await writeFile(path.join(vaultRoot, "preexisting"), "hi\n");

		const result = await initVault({ vaultRoot });
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.kind).toBe("vault-not-empty");

		// Nothing copied in.
		const after = await readdir(vaultRoot);
		expect(after).toEqual(["preexisting"]);
	});

	it("refuses a vault root with a pre-existing .git/", async () => {
		const vaultRoot = path.join(workdir, "vault");
		await mkdir(path.join(vaultRoot, ".git"), { recursive: true });

		const result = await initVault({ vaultRoot });
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.kind).toBe("git-already-initialized");
	});
});
