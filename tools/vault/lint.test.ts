// Pin the walk-driven and path-list branches of vaultLint. The walk
// branch routes through walkVaultDocs (markdown-only); the path-list
// branch resolves caller-supplied paths through acceptRoot and reads
// each one explicitly. Both produce findings via the same kind/schema
// dispatch.

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultLint } from "./lint.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

const accessor = { vaultRoot: "/vault" };

const fixture = {
	"/vault/notes/good.md":
		"---\nkind: task\ncreated: 2026-05-05\n---\nbody\n",
	"/vault/notes/no-kind.md": "---\ntitle: hi\n---\nbody\n",
	"/vault/notes/unknown.md": "---\nkind: bogus\n---\nbody\n",
	"/vault/raw.txt": "plain text\n",
};

beforeEach(() => {
	vol.reset();
	vol.fromJSON(fixture, "/");
});

afterEach(() => {
	vol.reset();
});

describe("vaultLint", () => {
	it("walks markdown-only and reports per-file findings", async () => {
		const result = await vaultLint({}, accessor);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const byPath = Object.fromEntries(
			result.value.findings.map((f) => [f.path, f]),
		);
		expect(Object.keys(byPath).toSorted()).toEqual([
			"notes/good.md",
			"notes/no-kind.md",
			"notes/unknown.md",
		]);
		expect(byPath["notes/good.md"].ok).toBe(true);
		expect(byPath["notes/no-kind.md"].reason).toBe("no-kind");
		expect(byPath["notes/unknown.md"].reason).toBe("unknown-kind");
		expect(result.value.summary).toEqual({ total: 3, ok: 1, failed: 2 });
	});

	it("lints only the supplied paths when params.paths is set", async () => {
		const result = await vaultLint(
			{ paths: ["notes/good.md", "notes/no-kind.md"] },
			accessor,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.findings.map((f) => f.path)).toEqual([
			"notes/good.md",
			"notes/no-kind.md",
		]);
		expect(result.value.summary).toEqual({ total: 2, ok: 1, failed: 1 });
	});

	it("propagates a path resolution error from the path-list branch", async () => {
		const result = await vaultLint({ paths: ["../escape.md"] }, accessor);
		expect(result.ok).toBe(false);
	});
});
