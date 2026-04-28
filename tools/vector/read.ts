// vector_read: semantic search over the vault's vector index. The real
// indexing/retrieval pipeline lives in a separate (unwritten) design; this
// module ships the final exported shape with a stub body so callers, the
// registry, and the discriminated-union type are stable now. A future change
// swaps the body to return the kind: "ok" arm without touching the signature.

import { z } from "zod";

const MAX_K = 50;
const DEFAULT_K = 10;

export const VectorReadParams = z.object({
	query: z.string().min(1),
	k: z.number().int().positive().max(MAX_K).default(DEFAULT_K),
	scope: z.enum(["notes", "archive", "any"]).default("any"),
});
export type VectorReadParams = z.infer<typeof VectorReadParams>;

export interface VectorHit {
	path: string;
	score: number;
	excerpt: string;
}

export type VectorReadResult =
	| { kind: "ok"; hits: VectorHit[] }
	| { kind: "stub"; reason: string };

export const vectorRead = async (
	_params: VectorReadParams,
): Promise<VectorReadResult> => ({
	kind: "stub",
	reason: "vector store not implemented; see designs/recollection-store",
});
