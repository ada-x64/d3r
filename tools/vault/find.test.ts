// Pin the walk-driven branches of vaultFind. The intent is to lock
// in the set of files visited and the join shape now that the walk
// routes through walkVaultDocs: glob filters by path, kind filters
// by parsed frontmatter, query filters by raw body, and non-`.md`
// files participate in the body-substring search but never carry a
// kind.

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultFind } from "./find.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

const accessor = { vaultRoot: "/vault" };

const fixture = {
	"/vault/notes/post.md": "---\nkind: note\n---\nhello world\n",
	"/vault/notes/other.md": "---\nkind: task\n---\nhello there\n",
	"/vault/raw.txt": "plain hello\n",
};

beforeEach(() => {
	vol.reset();
	vol.fromJSON(fixture, "/");
});

afterEach(() => {
	vol.reset();
});

describe("vaultFind", () => {
	it("returns every walked file when no filters are supplied", async () => {
		const result = await vaultFind({}, accessor);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.matches.map((m) => m.path).toSorted()).toEqual([
			"notes/other.md",
			"notes/post.md",
			"raw.txt",
		]);
	});

	it("filters by frontmatter kind, ignoring non-markdown rows", async () => {
		const result = await vaultFind({ kind: "note" }, accessor);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.matches).toEqual([
			{ path: "notes/post.md", kind: "note" },
		]);
	});

	it("matches body substrings in both markdown and non-markdown rows", async () => {
		const result = await vaultFind({ query: "hello" }, accessor);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const paths = result.value.matches.map((m) => m.path).toSorted();
		expect(paths).toEqual(["notes/other.md", "notes/post.md", "raw.txt"]);
	});

	it("composes glob and kind filters", async () => {
		const result = await vaultFind(
			{ glob: "notes/*.md", kind: "task" },
			accessor,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.matches).toEqual([
			{ path: "notes/other.md", kind: "task", matchedGlob: true },
		]);
	});
});
