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

// Pin selector -> Exa mapping by exercising the returned construction
// Result: only the Exa factory yields the missing-api-key variant for
// EXA_API_KEY when no key is available, so a generic factory would
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
	it(`returns the ${DEFAULT_WEB_SEARCH_PROVIDER} provider's missing-key Result when ${WEB_SEARCH_PROVIDER_ENV} is unset and no key is available`, () => {
		delete process.env.EXA_API_KEY;
		const result = selectWebSearchProvider({});
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({
			kind: "missing-api-key",
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
