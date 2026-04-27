import { z } from "zod";

export const kind = "design";

export const frontmatterSchema = z
	.object({
		created: z.union([z.string(), z.date()]),
	})
	.passthrough();
