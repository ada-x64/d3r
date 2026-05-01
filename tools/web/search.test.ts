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

	it("throws a clear error naming the env var and value when the selector is unknown", () => {
		expect(() =>
			selectWebSearchProvider({ [WEB_SEARCH_PROVIDER_ENV]: "nope" }),
		).toThrow(
			new RegExp(`${WEB_SEARCH_PROVIDER_ENV}.*nope.*supported.*exa`, "i"),
		);
	});
});
