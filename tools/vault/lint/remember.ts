import { z } from "zod";

export const kind = "remember";

export const frontmatterSchema = z
	.object({
		created: z.union([z.string(), z.date()]),
	})
	.passthrough();
