/* oxlint-disable no-await-in-loop -- Streaming reads enforce the byte ceiling before buffering the next chunk. */
import {
	mapFetchResponse,
	mapSearchResponse,
	type WebSearchProvider,
} from "@d3r/tools";
import { z } from "zod";

/** Independent wire, model-output and deadline budgets; no unlimited-text requests. */
export const WEB_LIMITS = {
	apiKeyChars: 4096,
	queryChars: 8192,
	urlChars: 8192,
	responseBytes: 1_048_576,
	outputBytes: 65_536,
	textChars: 16_384,
	timeoutMs: 30_000,
} as const;

/** Credential-bearing URLs are not suitable for visible tool arguments or citations. */
export const isSafeWebUrl = (value: string): boolean => {
	const [, authority] = /^https?:\/\/([^/?#]+)/i.exec(value) ?? [];
	if (
		!authority ||
		value.length > WEB_LIMITS.urlChars ||
		/[\s\\\p{Cc}]/u.test(value) ||
		!URL.canParse(value)
	) {
		return false;
	}
	const url = new URL(value);

	return (
		Boolean(url.hostname) &&
		!authority.includes("@") &&
		!url.username &&
		!url.password &&
		![...url.searchParams.keys()].some((name) =>
			/(?:^|[_-])(?:authorization|cookie|password|passwd|secret|token|credentials?|signature|sig|apikey|api_key|key|auth)$/i.test(
				name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
			),
		)
	);
};

/** Parse provider URLs before they can become model-visible citations. */
const responseUrl = z.string().refine(isSafeWebUrl);

/** Unknown Exa metadata is stripped; only checked fields reach the existing mappers. */
const searchRow = z.object({
	url: responseUrl,
	id: z.string().nullish(),
	title: z.string().nullish(),
	highlights: z.array(z.string()).nullish(),
	score: z.number().finite().nullish(),
	publishedDate: z.string().nullish(),
});

/** Exa may omit extracted text or titles; the shared mapper owns those fallbacks. */
const contentsRow = z.object({
	url: responseUrl,
	title: z.string().nullish(),
	text: z.string().nullish(),
	publishedDate: z.string().nullish(),
	author: z.string().nullish(),
});

/** Never read an unlimited body, including chunked responses or decompression expansion. */
const readJson = async (response: Response): Promise<unknown> => {
	if (
		!response.ok ||
		!/^application\/json(?:\s*;|$)/i.test(
			response.headers.get("content-type") ?? "",
		) ||
		Number(response.headers.get("content-length")) > WEB_LIMITS.responseBytes ||
		!response.body
	) {
		throw new Error("Exa response unavailable");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			bytes += chunk.value.byteLength;
			if (bytes > WEB_LIMITS.responseBytes) {
				throw new Error("Exa response exceeded the byte limit");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
	) as unknown;
};

/**
 * The SDK only races cancellation, leaving HTTP running. Native tools instead use
 * abortable fetch to these fixed endpoints, never to model-provided URLs. The
 * caller owns the deadline signal; the local controller also stops rejected or
 * oversized response bodies. Redirects cannot forward the credential elsewhere.
 */
export const createNativeExaProvider = (apiKey: string): WebSearchProvider => {
	const request = async (
		endpoint: "search" | "contents",
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> => {
		const controller = new AbortController();
		const active = AbortSignal.any([
			controller.signal,
			...(signal ? [signal] : []),
		]);
		active.throwIfAborted();
		try {
			const response = await fetch(`https://api.exa.ai/${endpoint}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify(body),
				redirect: "error",
				signal: active,
			});
			return await readJson(response);
		} finally {
			controller.abort();
		}
	};
	return {
		search: async (params, signal) => {
			const response = await request(
				"search",
				{
					query: params.query,
					numResults: params.k,
					contents: { highlights: true },
				},
				signal,
			);
			return mapSearchResponse(
				z.object({ results: z.array(searchRow).max(params.k) }).parse(response),
			);
		},
		fetch: async (params, signal) => {
			const response = await request(
				"contents",
				{ urls: params.urls, text: { maxCharacters: WEB_LIMITS.textChars } },
				signal,
			);
			return mapFetchResponse(
				z
					.object({ results: z.array(contentsRow).max(params.urls.length) })
					.parse(response),
			);
		},
	};
};
