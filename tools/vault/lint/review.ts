import { z } from "zod";

export const kind = "review";

export const frontmatterSchema = z
	.object({
		created: z.union([z.string(), z.date()]),
		round: z.number().int().positive(),
	})
	.passthrough();
