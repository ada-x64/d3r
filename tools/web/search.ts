// web_search: harness-agnostic surface for the web_search tool. Owns
// the zod schema, result types, the provider interface, and the
// env-driven selector that picks a provider implementation. Vendor
// implementations live under ./providers and are wired in through the
// providers table below.

import { z } from "zod";

import { EXA_PROVIDER_ID, createExaProvider } from "./providers/exa.ts";

const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;

export const WebSearchParams = z.object({
	query: z
		.string()
		.min(1)
		.describe("Search query as a natural-language string."),
	k: z
		.number()
		.int()
		.positive()
		.max(MAX_RESULTS)
		.default(DEFAULT_RESULTS)
		.describe(`Maximum number of results to return (1-${MAX_RESULTS}).`),
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

export const WEB_SEARCH_PROVIDER_ENV = "D3R_WEB_SEARCH_PROVIDER";
export const DEFAULT_WEB_SEARCH_PROVIDER = EXA_PROVIDER_ID;

// Provider table: extending support to a new vendor is a one-line
// addition here plus the provider module under ./providers.
const providers: Record<string, () => WebSearchProvider> = {
	[EXA_PROVIDER_ID]: createExaProvider,
};

export const selectWebSearchProvider = (
	env: NodeJS.ProcessEnv = process.env,
): WebSearchProvider => {
	const id = env[WEB_SEARCH_PROVIDER_ENV] ?? DEFAULT_WEB_SEARCH_PROVIDER;
	const factory = providers[id];
	if (!factory) {
		const supported = Object.keys(providers).join(", ");
		throw new Error(
			`Unknown ${WEB_SEARCH_PROVIDER_ENV} value: ${id} (supported: ${supported})`,
		);
	}
	return factory();
};
