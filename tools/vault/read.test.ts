// Smoke test for vaultRead. The intent is to pin the discriminated
// result shape (file vs dir) and the verbatim path round-trip the
// caller relies on. The filesystem is mocked to memfs so the test
// can run hermetically; the assertions are about the mapping
// vaultRead performs, not about node:fs or memfs themselves.

import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultRead } from "./read.ts";

vi.mock("node:fs");
vi.mock("node:fs/promises");

const accessor = { vaultRoot: "/vault" };

beforeEach(() => {
	vol.reset();
});

afterEach(() => {
	vol.reset();
});

describe("vaultRead", () => {
	it("returns a file result with verbatim path and decoded text", async () => {
		vol.fromJSON(
			{
				"/vault/notes/x.md": "hello",
				"/vault/notes/sub/y.md": "world",
			},
			"/",
		);

		const result = await vaultRead({ path: "notes/x.md" }, accessor);

		expect(result).toEqual({
			ok: true,
			value: { kind: "file", path: "notes/x.md", text: "hello" },
		});
	});

	it("returns a dir result whose entries distinguish file from dir", async () => {
		vol.fromJSON(
			{
				"/vault/notes/x.md": "hello",
				"/vault/notes/sub/y.md": "world",
			},
			"/",
		);

		const result = await vaultRead({ path: "notes" }, accessor);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.kind).toBe("dir");
		if (result.value.kind !== "dir") {
			return;
		}
		expect(result.value.path).toBe("notes");
		expect(result.value.entries.filter((e) => e.kind === "file")).toEqual([
			{ name: "x.md", kind: "file" },
		]);
		expect(result.value.entries.filter((e) => e.kind === "dir")).toEqual([
			{ name: "sub", kind: "dir" },
		]);
	});
});
