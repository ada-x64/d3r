// Smoke tests for selectWebSearchProvider. Pin selector -> Exa
// mapping by exercising the missing-api-key Result variant the Exa
// factory yields when the parsed config carries no key. A generic
// factory would not satisfy this assertion. The test never touches
// process.env: the typed config is supplied directly, mirroring how
// the shell threads it in.

import { describe, expect, it } from "vitest";

import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	WEB_SEARCH_PROVIDER_ENV,
	selectWebSearchProvider,
} from "./search.ts";

describe("selectWebSearchProvider", () => {
	it(`returns the ${DEFAULT_WEB_SEARCH_PROVIDER} provider's missing-key Result when the config carries no api key`, () => {
		const result = selectWebSearchProvider({
			providerId: DEFAULT_WEB_SEARCH_PROVIDER,
		});
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
		expect(() => selectWebSearchProvider({ providerId: "nope" })).toThrow(
			new RegExp(`${WEB_SEARCH_PROVIDER_ENV}.*nope.*supported.*exa`, "i"),
		);
	});
});
