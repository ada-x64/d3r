// fm_read: split a markdown string into frontmatter and body. Pure
// string in / pure data out; harness wrapping (file read + path
// resolution) lives in adapters.

import { z } from "zod";
import { parseFm } from "./_lib.ts";

export const FmReadParams = z.object({
	text: z.string(),
});
export type FmReadParams = z.infer<typeof FmReadParams>;

export interface FmReadResult {
	data: Record<string, unknown>;
	body: string;
}

export const fmRead = async (params: FmReadParams): Promise<FmReadResult> => {
	const { data, body } = parseFm(params.text);
	return { data, body };
};
