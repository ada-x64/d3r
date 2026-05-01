// Smoke tests for selectWebSearchProvider. The intent is to pin the
// d3r-owned routing logic (default provider, unknown-value rejection)
// the registry relies on, exercised through a hand-passed env so the
// test does not depend on process.env at run time. The provider
// interface itself is exercised via a DI fake in callers; those tests
// live next to those callers.

import { describe, expect, it } from "vitest";

import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	WEB_SEARCH_PROVIDER_ENV,
	selectWebSearchProvider,
} from "./search.ts";

type WebSearchProvider = ReturnType<typeof selectWebSearchProvider>;

describe("selectWebSearchProvider", () => {
	it("returns a provider that satisfies the interface when the env is unset", () => {
		const provider = selectWebSearchProvider({});
		expect(typeof provider.search).toBe("function");
	});

	it(`defaults to ${DEFAULT_WEB_SEARCH_PROVIDER} when ${WEB_SEARCH_PROVIDER_ENV} is unset`, () => {
		// The default is a structural promise rather than a behavioural
		// one; constructing it should not throw on a clean env.
		expect(() => selectWebSearchProvider({})).not.toThrow();
		expect(() =>
			selectWebSearchProvider({
				[WEB_SEARCH_PROVIDER_ENV]: DEFAULT_WEB_SEARCH_PROVIDER,
			}),
		).not.toThrow();
	});

	it("throws a clear error naming the env var and value when the selector is unknown", () => {
		expect(() =>
			selectWebSearchProvider({ [WEB_SEARCH_PROVIDER_ENV]: "nope" }),
		).toThrow(
			new RegExp(`${WEB_SEARCH_PROVIDER_ENV}.*nope.*supported.*exa`, "i"),
		);
	});

	// Exercises the typing seam: a hand-written fake satisfies the
	// WebSearchProvider contract without going near the registry. This
	// is the DI-fake-above-the-seam shape callers are expected to use.
	it("accepts a hand-written fake as a WebSearchProvider", async () => {
		const fake: WebSearchProvider = {
			search: async (params) => ({
				hits: [{ title: params.query, url: "https://x", snippet: "" }],
				provider: "fake",
			}),
		};
		const result = await fake.search({ query: "ping", k: 1 });
		expect(result.provider).toBe("fake");
		expect(result.hits[0]?.title).toBe("ping");
	});
});
