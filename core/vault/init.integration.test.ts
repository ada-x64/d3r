// Real Git verifies that initialization preserves the seed bytes in both
// the working tree and the returned commit, including hidden files.

import { execFileSync } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { initVault } from "./init.ts";
import { SEED_ROOT } from "./seed-root.ts";

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
	it.each(["existing-empty", "missing"])(
		"seeds a %s destination with one commit containing the seed bytes",
		async (destination) => {
			const vaultRoot = path.join(workdir, "vault");
			if (destination === "existing-empty") {
				await mkdir(vaultRoot);
			}
			const seedFiles = await collectFiles(SEED_ROOT);
			const seedContents = await Promise.all(
				seedFiles.map(async (file) => ({
					file,
					bytes: await readFile(path.join(SEED_ROOT, file)),
				})),
			);

			const result = await initVault({ vaultRoot });
			expect(result.ok).toBe(true);
			if (!result.ok) {
				return;
			}
			expect(result.value.vaultRoot).toBe(vaultRoot);
			expect(result.value.seedDir).toBe(SEED_ROOT);
			const head = execFileSync(
				"git",
				["--no-pager", "-C", vaultRoot, "rev-parse", "HEAD"],
				{ encoding: "utf8" },
			).trim();
			expect(result.value.commit).toBe(head);

			const vaultFiles = await collectFiles(vaultRoot, new Set([".git"]));
			expect(vaultFiles).toEqual(seedFiles);
			const tracked = execFileSync(
				"git",
				[
					"--no-pager",
					"-C",
					vaultRoot,
					"ls-tree",
					"-r",
					"--name-only",
					"-z",
					head,
				],
				{ encoding: "utf8" },
			)
				.split("\0")
				.filter(Boolean)
				.toSorted();
			expect(tracked).toEqual(seedFiles);

			await Promise.all(
				seedContents.map(async ({ file, bytes }) => {
					const copied = await readFile(path.join(vaultRoot, file));
					expect(copied, `working tree: ${file}`).toEqual(bytes);
					const committed = execFileSync("git", [
						"--no-pager",
						"-C",
						vaultRoot,
						"show",
						`${result.value.commit}:${file}`,
					]);
					expect(committed, `commit: ${file}`).toEqual(bytes);
				}),
			);

			const subjects = execFileSync(
				"git",
				["--no-pager", "-C", vaultRoot, "log", "--format=%s"],
				{ encoding: "utf8" },
			);
			expect(subjects.trim().split("\n")).toEqual([
				"chore: initial vault seed",
			]);
		},
	);

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
