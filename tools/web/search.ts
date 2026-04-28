// web_search: harness-agnostic router that delegates to a swappable
// WebSearchProvider. Vendor implementations live under ./providers.
// Callers parse params with the exported zod schema before invoking.

import { z } from "zod";

const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;

export const WebSearchParams = z.object({
	query: z.string().min(1),
	k: z.number().int().positive().max(MAX_RESULTS).default(DEFAULT_RESULTS),
});
export type WebSearchParams = z.infer<typeof WebSearchParams>;

export interface WebSearchHit {
	title: string;
	url: string;
	snippet: string;
}

export interface WebSearchResult {
	hits: WebSearchHit[];
	provider: string;
}

export interface WebSearchProvider {
	search(
		params: WebSearchParams,
		signal?: AbortSignal,
	): Promise<WebSearchResult>;
}

export const webSearch = async (
	params: WebSearchParams,
	provider: WebSearchProvider,
	signal?: AbortSignal,
): Promise<WebSearchResult> => provider.search(params, signal);
