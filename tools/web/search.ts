// Web research surface: harness-agnostic types, zod params, and the
// env-driven provider selector for both web_search and web_fetch.
// Owns the WebSearchProvider interface (search + fetch), the result
// shapes consumers depend on, and the provider table that picks an
// implementation. Vendor implementations live under ./providers and
// are wired in through the providers table below.

import { z } from "zod";

import { type Result } from "../common/result.ts";
import {
	EXA_PROVIDER_ID,
	createExaProvider,
	type MissingApiKey,
} from "./providers/exa.ts";

const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
const MAX_FETCH_URLS = 20;

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

export const WebFetchParams = z.object({
	urls: z
		.array(z.string().url())
		.min(1)
		.max(MAX_FETCH_URLS)
		.describe(
			`URLs to retrieve full extracted text for (1-${MAX_FETCH_URLS} per call).`,
		),
});
export type WebFetchParams = z.infer<typeof WebFetchParams>;

export interface WebHit {
	id: string;
	title: string;
	url: string;
	highlights: string[];
	score?: number;
	publishedDate?: string;
}

export interface WebSearchResult {
	hits: WebHit[];
}

export interface WebDoc {
	url: string;
	title: string | null;
	text: string;
	publishedDate?: string;
	author?: string;
}

export interface WebFetchResult {
	docs: WebDoc[];
}

export interface WebSearchProvider {
	search(
		params: WebSearchParams,
		signal?: AbortSignal,
	): Promise<WebSearchResult>;
	fetch(params: WebFetchParams, signal?: AbortSignal): Promise<WebFetchResult>;
}

export const WEB_SEARCH_PROVIDER_ENV = "D3R_WEB_SEARCH_PROVIDER";
export const DEFAULT_WEB_SEARCH_PROVIDER = EXA_PROVIDER_ID;

// Provider table: extending support to a new vendor is a one-line
// addition here plus the provider module under ./providers. Each
// factory takes the parsed shell config and returns a Result so
// missing-credential preconditions stay in the same vocabulary the
// rest of `tools/` uses.
const providers: Record<
	string,
	(config: WebProviderConfig) => Result<WebSearchProvider, MissingApiKey>
> = {
	[EXA_PROVIDER_ID]: (config) =>
		createExaProvider({ apiKey: config.exaApiKey }),
};

// Typed view of the env-derived web-search configuration the shell
// hands in. Parsing happens in the shell (cli/src/utils/env.ts);
// this module operates on the typed value thereafter and never
// reaches into process.env.
export interface WebProviderConfig {
	providerId: string;
	exaApiKey?: string;
}

export const selectWebSearchProvider = (
	config: WebProviderConfig,
): Result<WebSearchProvider, MissingApiKey> => {
	const factory = providers[config.providerId];
	if (!factory) {
		const supported = Object.keys(providers).join(", ");
		throw new Error(
			`Unknown ${WEB_SEARCH_PROVIDER_ENV} value: ${config.providerId} (supported: ${supported})`,
		);
	}
	return factory(config);
};

// Accessor handed to the registry's web rows: carries the constructed
// provider Result so the registry stays importable without an api key
// set, and `web_*` dispatch surfaces the missing-key precondition
// only when actually invoked. Same shape as `VaultAccessor` for
// vault-aware tools.
export interface WebSearchAccessor {
	provider: Result<WebSearchProvider, MissingApiKey>;
}
