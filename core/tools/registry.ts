import type { z } from "zod";

export interface ToolEntry {
	name: string;
	label: string;
	description: string;
	schema: z.ZodTypeAny;
	fn: (...args: never[]) => unknown;
}

export const registry: ToolEntry[] = [];
