// Every prescribed kind must be reachable by lookup and enforce its
// frontmatter requirements, regardless of schema object identity.

import { describe, expect, it } from "vitest";

import { getLintSchema, kindSchemas, lintSchemas } from "./index.ts";

/** Prescribed template kinds, independent of the schema table. */
const expectedKinds = [
	"task",
	"remember",
	"research",
	"design",
	"schema",
	"review",
	"note",
] as const;

/** Representative valid inputs isolate missing-field failures from other rules. */
const validFrontmatter = {
	task: { created: "2026-05-05" },
	remember: { created: "2026-05-05" },
	research: { created: "2026-05-05" },
	design: { created: "2026-05-05" },
	schema: {
		design: "design.md",
		branch: "feat/vault-init",
		status: "draft",
		created: "2026-05-05",
	},
	review: { created: "2026-05-05", round: 1 },
	note: {
		topic: "Vault initialization",
		repos: ["d3r"],
		created: "2026-05-05",
		updated: "2026-05-05",
		summary: "Preserve seed contents in the initial commit",
	},
} satisfies Record<(typeof expectedKinds)[number], Record<string, unknown>>;

describe("kindSchemas table", () => {
	it("covers every prescribed kind exactly once", () => {
		expect(kindSchemas.map((row) => row.kind).toSorted()).toEqual(
			[...expectedKinds].toSorted(),
		);
	});

	it.each(expectedKinds)(
		"accepts valid %s frontmatter through lookup",
		(kind) => {
			const fixture = validFrontmatter[kind];
			expect(lintSchemas[kind].safeParse(fixture).success).toBe(true);
			expect(getLintSchema(kind)?.safeParse(fixture).success).toBe(true);
		},
	);

	it("returns null from getLintSchema for unknown kinds", () => {
		expect(getLintSchema("nope")).toBeNull();
	});

	it.each(expectedKinds)(
		"rejects %s frontmatter when only created is missing",
		(kind) => {
			const fixture = validFrontmatter[kind];
			const schema = getLintSchema(kind);
			expect(schema?.safeParse(fixture).success).toBe(true);

			const { created: _created, ...withoutCreated } = fixture;
			expect(schema?.safeParse(withoutCreated).success).toBe(false);
		},
	);

	it.each([
		{ kind: "schema", invalid: { ...validFrontmatter.schema, design: null } },
		{ kind: "review", invalid: { ...validFrontmatter.review, round: 0 } },
		{ kind: "note", invalid: { ...validFrontmatter.note, repos: "d3r" } },
	])(
		"enforces $kind-specific validation through lookup",
		({ kind, invalid }) => {
			expect(lintSchemas[kind].safeParse(invalid).success).toBe(false);
			expect(getLintSchema(kind)?.safeParse(invalid).success).toBe(false);
		},
	);
});
