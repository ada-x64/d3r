// Exa-backed WebSearchProvider. Reads EXA_API_KEY lazily on first
// search() call so that the registry stays importable without the key
// set; throws a typed MissingApiKeyError when the key is absent so
// callers can surface a clear message.

import { Exa } from "exa-js";

import type {
	WebSearchParams,
	WebSearchProvider,
	WebSearchResult,
} from "../search.ts";

const SNIPPET_MAX_CHARS = 280;
const PROVIDER_NAME = "exa";
const ENV_VAR = "EXA_API_KEY";

export class MissingApiKeyError extends Error {
	override readonly name = "MissingApiKeyError";
	readonly envVar: string;
	constructor(envVar: string) {
		super(`Missing required environment variable: ${envVar}`);
		this.envVar = envVar;
	}
}

export const createExaProvider = (): WebSearchProvider => {
	let client: Exa | null = null;
	const getClient = (): Exa => {
		if (client) {
			return client;
		}
		const apiKey = process.env[ENV_VAR];
		if (!apiKey) {
			throw new MissingApiKeyError(ENV_VAR);
		}
		client = new Exa(apiKey);
		return client;
	};
	return {
		search: async (params: WebSearchParams): Promise<WebSearchResult> => {
			const c = getClient();
			const response = await c.searchAndContents(params.query, {
				numResults: params.k,
				text: { maxCharacters: SNIPPET_MAX_CHARS },
				highlights: true,
			});
			const hits = response.results.map((r) => ({
				title: r.title ?? r.url,
				url: r.url,
				snippet:
					r.highlights?.[0] ??
					(r.text ? r.text.slice(0, SNIPPET_MAX_CHARS) : ""),
			}));
			return { hits, provider: PROVIDER_NAME };
		},
	};
};
