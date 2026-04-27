import { z } from "zod";

export const kind = "schema";

export const frontmatterSchema = z
	.object({
		design: z.string(),
		branch: z.string(),
		status: z.string(),
		created: z.union([z.string(), z.date()]),
	})
	.passthrough();
