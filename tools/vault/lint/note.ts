import { z } from "zod";

export const kind = "note";

export const frontmatterSchema = z
	.object({
		topic: z.string(),
		repos: z.array(z.string()),
		tags: z.array(z.string()).optional(),
		created: z.union([z.string(), z.date()]),
		updated: z.union([z.string(), z.date()]),
		summary: z.string(),
	})
	.passthrough();
