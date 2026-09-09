// Refusals must preserve the filesystem and never invoke Git.
// Successful initialization is covered with real Git in the integration tests.

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Spawn } from "./git.ts";
import { initVault } from "./init.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

/** Keep unexpected Git calls observable even if initVault handles the failure. */
const makeRefusalSpawn = () =>
	vi.fn<Spawn>(async () => ({
		stdout: "",
		stderr: "Git must not run for a refused initialization",
		exitCode: 1,
		signal: null,
	}));

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

describe("initVault refusals", () => {
	it("refuses a non-empty destination and writes nothing", async () => {
		vol.fromJSON({ ...seedJson, "/vault/leftover.txt": "old\n" }, "/");
		const before = vol.toJSON();
		const spawn = makeRefusalSpawn();

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
		expect(spawn).not.toHaveBeenCalled();
		expect(vol.toJSON()).toEqual(before);
	});

	it("refuses when .git/ already exists, even on an otherwise-empty root", async () => {
		vol.fromJSON({ ...seedJson, "/vault/.git/HEAD": "ref\n" }, "/");
		const before = vol.toJSON();
		const spawn = makeRefusalSpawn();

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
		expect(spawn).not.toHaveBeenCalled();
		expect(vol.toJSON()).toEqual(before);
	});

	it("returns seed-missing when seedDir does not exist", async () => {
		vol.fromJSON({ "/vault": null }, "/");
		const before = vol.toJSON();
		const spawn = makeRefusalSpawn();

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
		expect(spawn).not.toHaveBeenCalled();
		expect(vol.toJSON()).toEqual(before);
	});

	it("refuses when vaultRoot exists as a regular file (not a directory)", async () => {
		vol.fromJSON({ ...seedJson, "/vault": "i am a file, not a dir\n" }, "/");
		const before = vol.toJSON();
		const spawn = makeRefusalSpawn();

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
		expect(spawn).not.toHaveBeenCalled();
		expect(vol.toJSON()).toEqual(before);
	});
});
