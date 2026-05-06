// Pin the join shape produced by walkVaultDocs in both modes. The
// flag controls whether non-`.md` rows participate at all; the
// behaviour difference is the audit-noted divergence between the
// vault find/lint call sites, surfaced here as one parameter.

import { vol } from "memfs";
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
});
