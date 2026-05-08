// Exa-backed WebSearchProvider. Implements both the lightweight
// `search` surface (hits with full highlights) and the full-text
// `fetch` surface (extracted page bodies, no truncation). Construction
// is the moment the api-key precondition is checked: when neither an
// explicit `client` nor an `apiKey` is available, the factory returns
// a Result.error variant the shell can surface to the operator. The
// returned provider closes over a single client constructed once;
// there is no per-call cache to invalidate.

import { Exa } from "exa-js";

import { fail, ok, type Result } from "@d3r/core/result";
import {
	type WebDoc,
	type WebFetchParams,
	type WebFetchResult,
	type WebHit,
	type WebSearchParams,
	type WebSearchProvider,
	type WebSearchResult,
} from "../search.ts";

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
	// look at `apiKey` or construct an Exa instance; this is the seam
	// tests use to exercise abort and cancellation paths without
	// touching the network.
	client?: ExaLike;
	// Operator-supplied api key, parsed at the shell boundary. When
	// absent (and no `client` is supplied) the factory returns a
	// Result.error variant rather than throwing.
	apiKey?: string;
}

// Construction-time precondition signal: the provider could not be
// built because the operator did not supply an api key. A plain row,
// not a class, so callers compose it through the same Result vocabulary
// the rest of `tools/` uses.
export interface MissingApiKey {
	kind: "missing-api-key";
	envVar: string;
}

export const EXA_API_KEY_ENV = "EXA_API_KEY";

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
): Result<WebSearchProvider, MissingApiKey> => {
	// Resolve the client once at construction. The api-key is supplied
	// by the shell after parsing process.env at the boundary; this
	// module never reaches into env itself. When neither an explicit
	// client nor an api-key is available the precondition surfaces as
	// a Result.error variant and the caller never sees a half-
	// constructed provider.
	const client: ExaLike | undefined =
		options.client ?? (options.apiKey ? new Exa(options.apiKey) : undefined);
	if (!client) {
		return fail({ kind: "missing-api-key", envVar: EXA_API_KEY_ENV });
	}
	return ok({
		search: async (
			params: WebSearchParams,
			signal?: AbortSignal,
		): Promise<WebSearchResult> => {
			if (signal?.aborted) {
				throw abortError(signal);
			}
			const response = await raceWithSignal(
				client.searchAndContents(params.query, {
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
			const response = await raceWithSignal(
				client.getContents(params.urls, { text: true }),
				signal,
			);
			return mapFetchResponse(response);
		},
	});
};
