import type { z } from "zod";
import { FmReadParams, fmRead } from "./fm/read.ts";
import { FmWriteParams, fmWrite } from "./fm/write.ts";

export interface ToolEntry {
	name: string;
	label: string;
	description: string;
	schema: z.ZodTypeAny;
	fn: (...args: never[]) => unknown;
}

export const registry: ToolEntry[] = [
	{
		name: "fm_read",
		label: "Frontmatter read",
		description:
			"Parse a markdown string into its YAML frontmatter object and body text.",
		schema: FmReadParams,
		fn: fmRead as (...args: never[]) => unknown,
	},
	{
		name: "fm_write",
		label: "Frontmatter write",
		description:
			"Serialise a frontmatter object plus body back to a single markdown string.",
		schema: FmWriteParams,
		fn: fmWrite as (...args: never[]) => unknown,
	},
];
