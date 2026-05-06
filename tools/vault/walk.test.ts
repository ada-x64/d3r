// Pin the join shape produced by walkVaultDocs in both modes. The
// `includeNonMarkdown` flag covers the two existing call-site
// behaviours (markdown-only vs. all files) without forcing either
// to take the other's, and `filterRel` lets a caller drop relpaths
// before they get read.

import { fs as memfs, vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { walkVaultDocs } from "./_lib.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

const fixture = {
	"/vault/notes/post.md": "---\nkind: note\ntitle: hi\n---\nbody text\n",
	"/vault/raw.txt": "plain text\n",
};

beforeEach(() => {
	vol.reset();
	vol.fromJSON(fixture, "/");
});

afterEach(() => {
	vol.reset();
});

describe("walkVaultDocs", () => {
	it("defaults to markdown-only and parses frontmatter", async () => {
		const rows = await walkVaultDocs("/vault");
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row.rel).toBe("notes/post.md");
		expect(row.abs).toBe("/vault/notes/post.md");
		expect(row.body).toBe("body text\n");
		expect(row.frontmatter).toEqual({ kind: "note", title: "hi" });
	});

	it("surfaces non-markdown rows with raw body and no frontmatter when asked", async () => {
		const rows = await walkVaultDocs("/vault", { includeNonMarkdown: true });
		const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
		expect(Object.keys(byRel).toSorted()).toEqual(["notes/post.md", "raw.txt"]);
		expect(byRel["raw.txt"].body).toBe("plain text\n");
		expect(byRel["raw.txt"].frontmatter).toBeUndefined();
		expect(byRel["notes/post.md"].frontmatter).toEqual({
			kind: "note",
			title: "hi",
		});
	});

	it("skips reads for relpaths the filter rejects", async () => {
		const readSpy = vi.spyOn(memfs.promises, "readFile");
		const rows = await walkVaultDocs("/vault", {
			includeNonMarkdown: true,
			filterRel: (rel) => rel === "raw.txt",
		});
		expect(rows.map((r) => r.rel)).toEqual(["raw.txt"]);
		const readPaths = readSpy.mock.calls.map(([p]) => String(p));
		expect(readPaths).toEqual(["/vault/raw.txt"]);
		readSpy.mockRestore();
	});
});
