// Pin the kindSchemas table contract: every prescribed template kind
// dispatches to a zod schema via lintSchemas / getLintSchema. The point
// is to catch a kind silently disappearing or being misnamed during
// future table edits.

import { describe, expect, it } from "vitest";

import { getLintSchema, kindSchemas, lintSchemas } from "./index.ts";

const expectedKinds = [
	"task",
	"remember",
	"research",
	"design",
	"schema",
	"review",
	"note",
] as const;

describe("kindSchemas table", () => {
	it("covers every prescribed kind exactly once", () => {
		expect(kindSchemas.map((row) => row.kind).toSorted()).toEqual(
			[...expectedKinds].toSorted(),
		);
	});

	it("exposes lintSchemas keyed by kind", () => {
		for (const kind of expectedKinds) {
			expect(lintSchemas[kind]).toBeDefined();
			expect(getLintSchema(kind)).toBe(lintSchemas[kind]);
		}
	});

	it("returns null from getLintSchema for unknown kinds", () => {
		expect(getLintSchema("nope")).toBeNull();
	});

	it("requires `created` on every kind", () => {
		for (const { kind, frontmatterSchema } of kindSchemas) {
			const result = frontmatterSchema.safeParse({});
			expect(result.success, `kind=${kind} must reject empty frontmatter`).toBe(
				false,
			);
		}
	});

	it("accepts a minimal valid frontmatter for the simple kinds", () => {
		for (const kind of ["task", "remember", "research", "design"] as const) {
			const schema = lintSchemas[kind];
			expect(schema.safeParse({ created: "2026-05-05" }).success).toBe(true);
		}
	});
});
