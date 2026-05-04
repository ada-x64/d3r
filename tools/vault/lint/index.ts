// Aggregator: maps each prescribed template kind to its frontmatter
// zod schema. Hand-authored per kind (see ../lint.ts for the tool that
// consumes this map). Adding a new kind means a new sibling file plus
// one entry in `modules` below.

import { type z } from "zod";

import {
	frontmatterSchema as designSchema,
	kind as designKind,
} from "./design.ts";
import { frontmatterSchema as noteSchema, kind as noteKind } from "./note.ts";
import {
	frontmatterSchema as rememberSchema,
	kind as rememberKind,
} from "./remember.ts";
import {
	frontmatterSchema as researchSchema,
	kind as researchKind,
} from "./research.ts";
import {
	frontmatterSchema as reviewSchema,
	kind as reviewKind,
} from "./review.ts";
import {
	frontmatterSchema as schemaSchema,
	kind as schemaKind,
} from "./schema.ts";
import { frontmatterSchema as taskSchema, kind as taskKind } from "./task.ts";

interface KindEntry {
	kind: string;
	frontmatterSchema: z.ZodTypeAny;
}

const modules: KindEntry[] = [
	{ kind: taskKind, frontmatterSchema: taskSchema },
	{ kind: rememberKind, frontmatterSchema: rememberSchema },
	{ kind: researchKind, frontmatterSchema: researchSchema },
	{ kind: designKind, frontmatterSchema: designSchema },
	{ kind: schemaKind, frontmatterSchema: schemaSchema },
	{ kind: reviewKind, frontmatterSchema: reviewSchema },
	{ kind: noteKind, frontmatterSchema: noteSchema },
];

export const lintSchemas: Record<string, z.ZodTypeAny> = Object.fromEntries(
	modules.map((m) => [m.kind, m.frontmatterSchema]),
);

export const getLintSchema = (kind: string): z.ZodTypeAny | null =>
	lintSchemas[kind] ?? null;
