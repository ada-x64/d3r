// Exa-backed WebSearchProvider. Implements both the lightweight
// `search` surface (hits with full highlights) and the full-text
// `fetch` surface (extracted page bodies, no truncation). Reads
// EXA_API_KEY lazily on first call so the registry stays importable
// without the key set; throws a typed MissingApiKeyError when the key
// is absent so callers can surface a clear message.

import { Exa } from "exa-js";

import type {
	WebDoc,
	WebFetchParams,
	WebFetchResult,
	WebHit,
	WebSearchParams,
	WebSearchProvider,
	WebSearchResult,
} from "../search.ts";

const ENV_VAR = "EXA_API_KEY";

export const EXA_PROVIDER_ID = "exa";

// Pure mappers from the exa-js response shapes to the result types the
// rest of the codebase consumes. Extracted so unit tests can pin the
// d3r-owned translation (id/url fallback, highlight passthrough,
// optional-field carry) without standing up the SDK or its HTTP
// boundary.

interface ExaSearchResult {
	id?: string | null;
	title?: string | null;
	url: string;
	highlights?: string[] | null;
	score?: number | null;
	publishedDate?: string | null;
}

export interface ExaSearchResponse {
	results: ExaSearchResult[];
}

interface ExaContentsResult {
	url: string;
	title?: string | null;
	text?: string | null;
	publishedDate?: string | null;
	author?: string | null;
}

export interface ExaContentsResponse {
	results: ExaContentsResult[];
}

export const mapSearchResponse = (
	response: ExaSearchResponse,
): WebSearchResult => ({
	hits: response.results.map((r): WebHit => {
		const hit: WebHit = {
			id: r.id ?? r.url,
			title: r.title ?? r.url,
			url: r.url,
			highlights: r.highlights ?? [],
		};
		if (r.score != null) {
			hit.score = r.score;
		}
		if (r.publishedDate != null) {
			hit.publishedDate = r.publishedDate;
		}
		return hit;
	}),
});

export const mapFetchResponse = (
	response: ExaContentsResponse,
): WebFetchResult => ({
	docs: response.results.map((r): WebDoc => {
		const doc: WebDoc = {
			url: r.url,
			title: r.title ?? null,
			text: r.text ?? "",
		};
		if (r.publishedDate != null) {
			doc.publishedDate = r.publishedDate;
		}
		if (r.author != null) {
			doc.author = r.author;
		}
		return doc;
	}),
});

// Minimal structural slice of the exa-js client that this provider
// actually invokes. Defined here so callers (notably tests) can pass
// a hand-written stub through the DI seam below without dragging in
// the SDK's full generic surface area.
export interface ExaLike {
	searchAndContents: Exa["searchAndContents"];
	getContents: Exa["getContents"];
}

export interface CreateExaProviderOptions {
	// Inject a client directly. When supplied, the provider will not
	// read EXA_API_KEY or construct an Exa instance; this is the seam
	// tests use to exercise abort and cancellation paths without
	// touching the network.
	client?: ExaLike;
}

export class MissingApiKeyError extends Error {
	override readonly name = "MissingApiKeyError";
	readonly envVar: string;
	constructor(envVar: string) {
		super(`Missing required environment variable: ${envVar}`);
		this.envVar = envVar;
	}
}

const abortError = (signal: AbortSignal): unknown =>
	signal.reason ?? new DOMException("Aborted", "AbortError");

// Race an in-flight promise against an AbortSignal. The Exa SDK does
// not accept a signal; this wrapper lets callers reject promptly when
// the agent loop cancels the tool call. The underlying request still
// runs to completion in the background, but the caller is unblocked.
// Callers are expected to short-circuit on `signal.aborted` *before*
// invoking the SDK so an already-cancelled call never hits the wire.
const raceWithSignal = async <T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> => {
	if (!signal) {
		return promise;
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
};

export const createExaProvider = (
	options: CreateExaProviderOptions = {},
): WebSearchProvider => {
	let client: ExaLike | null = options.client ?? null;
	const getClient = (): ExaLike => {
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
		search: async (
			params: WebSearchParams,
			signal?: AbortSignal,
		): Promise<WebSearchResult> => {
			if (signal?.aborted) {
				throw abortError(signal);
			}
			const c = getClient();
			const response = await raceWithSignal(
				c.searchAndContents(params.query, {
					numResults: params.k,
					highlights: true,
				}),
				signal,
			);
			return mapSearchResponse(response);
		},
		fetch: async (
			params: WebFetchParams,
			signal?: AbortSignal,
		): Promise<WebFetchResult> => {
			if (signal?.aborted) {
				throw abortError(signal);
			}
			const c = getClient();
			const response = await raceWithSignal(
				c.getContents(params.urls, { text: true }),
				signal,
			);
			return mapFetchResponse(response);
		},
	};
};
