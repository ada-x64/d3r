// Smoke tests for selectWebSearchProvider. The intent is to pin the
// d3r-owned routing logic (default provider, unknown-value rejection)
// the registry relies on, exercised through a hand-passed env so the
// test does not depend on process.env at run time. The provider
// interface itself is exercised via a DI fake in callers; those tests
// live next to those callers.

import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	WEB_SEARCH_PROVIDER_ENV,
	selectWebSearchProvider,
} from "./search.ts";

type WebSearchProvider = ReturnType<typeof selectWebSearchProvider>;

// Pin selector → Exa mapping by exercising the returned provider's
// lazy key-read path: only the Exa factory throws MissingApiKeyError
// for EXA_API_KEY, so a generic WebSearchProvider-shaped object would
// not satisfy this assertion.
const ORIGINAL_KEY = process.env.EXA_API_KEY;

afterEach(() => {
	if (ORIGINAL_KEY === undefined) {
		delete process.env.EXA_API_KEY;
	} else {
		process.env.EXA_API_KEY = ORIGINAL_KEY;
	}
});

describe("selectWebSearchProvider", () => {
	it(`returns the ${DEFAULT_WEB_SEARCH_PROVIDER} provider when ${WEB_SEARCH_PROVIDER_ENV} is unset`, async () => {
		delete process.env.EXA_API_KEY;
		const provider = selectWebSearchProvider({});
		expect(typeof provider.fetch).toBe("function");
		await expect(
			provider.search({ query: "ping", k: 1 }),
		).rejects.toMatchObject({
			name: "MissingApiKeyError",
			envVar: "EXA_API_KEY",
		});
	});

	it(`returns the ${DEFAULT_WEB_SEARCH_PROVIDER} provider when ${WEB_SEARCH_PROVIDER_ENV} is set to '${DEFAULT_WEB_SEARCH_PROVIDER}'`, async () => {
		delete process.env.EXA_API_KEY;
		const provider = selectWebSearchProvider({
			[WEB_SEARCH_PROVIDER_ENV]: DEFAULT_WEB_SEARCH_PROVIDER,
		});
		expect(typeof provider.search).toBe("function");
		await expect(
			provider.fetch({ urls: ["https://example.com"] }),
		).rejects.toMatchObject({
			name: "MissingApiKeyError",
			envVar: "EXA_API_KEY",
		});
	});

	it("throws a clear error naming the env var and value when the selector is unknown", () => {
		expect(() =>
			selectWebSearchProvider({ [WEB_SEARCH_PROVIDER_ENV]: "nope" }),
		).toThrow(
			new RegExp(`${WEB_SEARCH_PROVIDER_ENV}.*nope.*supported.*exa`, "i"),
		);
	});

	// Exercises the typing seam: a hand-written fake satisfies the
	// WebSearchProvider contract (both methods) without going near the
	// registry. This is the DI-fake-above-the-seam shape callers are
	// expected to use.
	it("accepts a hand-written fake as a WebSearchProvider", async () => {
		const fake: WebSearchProvider = {
			search: async (params) => ({
				hits: [
					{
						id: "https://x",
						title: params.query,
						url: "https://x",
						highlights: [],
					},
				],
			}),
			fetch: async (params) => ({
				docs: params.urls.map((url) => ({
					url,
					title: null,
					text: "body",
				})),
			}),
		};
		const search = await fake.search({ query: "ping", k: 1 });
		expect(search.hits[0]?.title).toBe("ping");
		const fetched = await fake.fetch({ urls: ["https://a", "https://b"] });
		expect(fetched.docs.map((d) => d.url)).toEqual(["https://a", "https://b"]);
	});
});
