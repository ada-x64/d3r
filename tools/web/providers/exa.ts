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
const ENV_VAR = "EXA_API_KEY";

export const EXA_PROVIDER_ID = "exa";

export class MissingApiKeyError extends Error {
	override readonly name = "MissingApiKeyError";
	readonly envVar: string;
	constructor(envVar: string) {
		super(`Missing required environment variable: ${envVar}`);
		this.envVar = envVar;
	}
}

// Race a promise against an AbortSignal. The Exa SDK does not accept a
// signal; this wrapper lets callers reject promptly when the agent
// loop cancels the tool call. The underlying request still runs to
// completion in the background, but the caller is unblocked.
const raceWithSignal = async <T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> => {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
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
		search: async (
			params: WebSearchParams,
			signal?: AbortSignal,
		): Promise<WebSearchResult> => {
			const c = getClient();
			const response = await raceWithSignal(
				c.searchAndContents(params.query, {
					numResults: params.k,
					text: { maxCharacters: SNIPPET_MAX_CHARS },
					highlights: true,
				}),
				signal,
			);
			const hits = response.results.map((r) => ({
				title: r.title ?? r.url,
				url: r.url,
				snippet:
					r.highlights?.[0] ??
					(r.text ? r.text.slice(0, SNIPPET_MAX_CHARS) : ""),
			}));
			return { hits, provider: EXA_PROVIDER_ID };
		},
	};
};
