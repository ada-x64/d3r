// fm_write: serialise a frontmatter object plus body back to a single
// markdown string in canonical gray-matter shape. Pure data in / pure
// string out.

import { z } from "zod";
import { stringifyFm } from "./_lib.ts";

export const FmWriteParams = z.object({
	data: z.record(z.string(), z.unknown()),
	body: z.string(),
});
export type FmWriteParams = z.infer<typeof FmWriteParams>;

export interface FmWriteResult {
	text: string;
}

export const fmWrite = async (
	params: FmWriteParams,
): Promise<FmWriteResult> => ({
	text: stringifyFm(params.data, params.body),
});
