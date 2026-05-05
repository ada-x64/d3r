// Frontmatter schema table: one row per prescribed template kind. Adding a
// new kind, or a cross-cutting rule that applies to every kind, is a one-row
// (or one-column) edit here. See ../lint.ts for the consumer.
//
// Shape rationale: see docs/data-oriented-design.md (DOD-TABLES-OVER-FILES).
// The earlier per-kind sibling files differed only by `kind` and a small
// zod schema, so they collapse into the table below without losing anything.

import { z } from "zod";

interface KindRow {
	kind: string;
	frontmatterSchema: z.ZodTypeAny;
}

const created = z.union([z.string(), z.date()]);

export const kindSchemas: readonly KindRow[] = [
	{
		kind: "task",
		frontmatterSchema: z.object({ created }).passthrough(),
	},
	{
		kind: "remember",
		frontmatterSchema: z.object({ created }).passthrough(),
	},
	{
		kind: "research",
		frontmatterSchema: z.object({ created }).passthrough(),
	},
	{
		kind: "design",
		frontmatterSchema: z.object({ created }).passthrough(),
	},
	{
		kind: "schema",
		frontmatterSchema: z
			.object({
				design: z.string(),
				branch: z.string(),
				status: z.string(),
				created,
			})
			.passthrough(),
	},
	{
		kind: "review",
		frontmatterSchema: z
			.object({
				created,
				round: z.number().int().positive(),
			})
			.passthrough(),
	},
	{
		kind: "note",
		frontmatterSchema: z
			.object({
				topic: z.string(),
				repos: z.array(z.string()),
				tags: z.array(z.string()).optional(),
				created,
				updated: z.union([z.string(), z.date()]),
				summary: z.string(),
			})
			.passthrough(),
	},
];

export const lintSchemas: Record<string, z.ZodTypeAny> = Object.fromEntries(
	kindSchemas.map((row) => [row.kind, row.frontmatterSchema]),
);

export const getLintSchema = (kind: string): z.ZodTypeAny | null =>
	lintSchemas[kind] ?? null;
