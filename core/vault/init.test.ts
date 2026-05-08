// initVault unit coverage. memfs backs the destination + seed
// trees; the spawn recorder captures the exact `git` argv
// sequence so the commit subject and add/commit ordering are
// pinned at this tier (the integration test corroborates with a
// real git binary).

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Spawn } from "./git.ts";
import { initVault } from "./init.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

interface SpawnCall {
	cmd: string;
	args: readonly string[];
}

const makeRecorder = (
	overrides: Record<string, () => Promise<{ stdout: string }>> = {},
): { calls: SpawnCall[]; spawn: Spawn } => {
	const calls: SpawnCall[] = [];
	const spawn: Spawn = async (cmd, args) => {
		calls.push({ cmd, args });
		const key = `${cmd} ${args.join(" ")}`;
		const matches = Object.entries(overrides).filter(([m]) => key.includes(m));
		const results = await Promise.all(matches.map(([, run]) => run()));
		const [first] = results;
		if (first !== undefined) {
			return { stdout: first.stdout, stderr: "", exitCode: 0, signal: null };
		}
		return { stdout: "", stderr: "", exitCode: 0, signal: null };
	};
	return { calls, spawn };
};

const seedJson = {
	"/seed/AGENTS.md": "agents\n",
	"/seed/d3r.md": "d3r\n",
	"/seed/.gitattributes": "* text=auto\n",
	"/seed/notes/.gitkeep": "",
};

beforeEach(() => {
	vol.reset();
});
afterEach(() => {
	vol.reset();
});

describe("initVault — happy path", () => {
	it("copies the seed and runs git init / add / commit in order", async () => {
		vol.fromJSON({ ...seedJson, "/vault": null }, "/");
		const { calls, spawn } = makeRecorder({
			"rev-parse HEAD": async () => ({ stdout: "deadbeef\n" }),
		});

		const result = await initVault(
			{ vaultRoot: "/vault", seedDir: "/seed" },
			{ spawn },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value).toEqual({
			vaultRoot: "/vault",
			seedDir: "/seed",
			commit: "deadbeef",
		});
		expect(calls.map((c) => c.args)).toEqual([
			["-C", "/vault", "init"],
			["-C", "/vault", "add", "."],
			["-C", "/vault", "commit", "-m", "chore: initial vault seed"],
			["-C", "/vault", "rev-parse", "HEAD"],
		]);
	});
});

describe("initVault — refusals", () => {
	it("refuses a non-empty destination and writes nothing", async () => {
		vol.fromJSON({ ...seedJson, "/vault/leftover.txt": "old\n" }, "/");
		const { calls, spawn } = makeRecorder();

		const result = await initVault(
			{ vaultRoot: "/vault", seedDir: "/seed" },
			{ spawn },
		);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.kind).toBe("vault-not-empty");
		if (result.error.kind !== "vault-not-empty") {
			return;
		}
		expect(result.error.path).toBe("/vault");
		expect(result.error.entries).toEqual(["leftover.txt"]);
		expect(calls).toEqual([]);
		expect(vol.toJSON()["/vault/leftover.txt"]).toBe("old\n");
		expect(vol.toJSON()["/vault/AGENTS.md"]).toBeUndefined();
	});

	it("refuses when .git/ already exists, even on an otherwise-empty root", async () => {
		vol.fromJSON({ ...seedJson, "/vault/.git/HEAD": "ref\n" }, "/");
		const { calls, spawn } = makeRecorder();

		const result = await initVault(
			{ vaultRoot: "/vault", seedDir: "/seed" },
			{ spawn },
		);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.kind).toBe("git-already-initialized");
		if (result.error.kind !== "git-already-initialized") {
			return;
		}
		expect(result.error.path).toBe("/vault/.git");
		expect(calls).toEqual([]);
	});

	it("returns seed-missing when seedDir does not exist", async () => {
		vol.fromJSON({ "/vault": null }, "/");
		const { calls, spawn } = makeRecorder();

		const result = await initVault(
			{ vaultRoot: "/vault", seedDir: "/no/such/seed" },
			{ spawn },
		);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({
			kind: "seed-missing",
			path: "/no/such/seed",
		});
		expect(calls).toEqual([]);
	});

	it("treats a missing destination dir as empty (creates it via cp)", async () => {
		vol.fromJSON(seedJson, "/");
		const { spawn } = makeRecorder({
			"rev-parse HEAD": async () => ({ stdout: "cafebabe\n" }),
		});

		const result = await initVault(
			{ vaultRoot: "/fresh-vault", seedDir: "/seed" },
			{ spawn },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(vol.toJSON()["/fresh-vault/AGENTS.md"]).toBe("agents\n");
		expect(vol.toJSON()["/fresh-vault/notes/.gitkeep"]).toBe("");
	});

	it("refuses when vaultRoot exists as a regular file (not a directory)", async () => {
		vol.fromJSON({ ...seedJson, "/vault": "i am a file, not a dir\n" }, "/");
		const { calls, spawn } = makeRecorder();

		const result = await initVault(
			{ vaultRoot: "/vault", seedDir: "/seed" },
			{ spawn },
		);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({
			kind: "vault-not-a-directory",
			path: "/vault",
		});
		expect(calls).toEqual([]);
		// File contents preserved; no leakage into the path.
		expect(vol.toJSON()["/vault"]).toBe("i am a file, not a dir\n");
	});
});
