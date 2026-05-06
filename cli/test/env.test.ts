// Boundary-parser tests for parseWebProviderConfig. The shell calls
// this once at startup with process.env; the rest of the system
// operates on the typed value. Tests pin: default provider when the
// selector is unset, override when set, exa-key passthrough, and
// graceful fallback when the env shape is unexpectedly polluted.

import { describe, expect, it } from "vitest";

import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	WEB_SEARCH_PROVIDER_ENV,
} from "@d3r/tools";

import { parseWebProviderConfig } from "../src/utils/env.ts";

describe("parseWebProviderConfig", () => {
	it("defaults providerId to the package default when the selector env is unset", () => {
		const cfg = parseWebProviderConfig({});
		expect(cfg.providerId).toBe(DEFAULT_WEB_SEARCH_PROVIDER);
		expect(cfg.exaApiKey).toBeUndefined();
	});

	it("propagates an explicit provider selector and exa key", () => {
		const cfg = parseWebProviderConfig({
			[WEB_SEARCH_PROVIDER_ENV]: "exa",
			EXA_API_KEY: "sk-test",
			HOME: "/somewhere",
		});
		expect(cfg.providerId).toBe("exa");
		expect(cfg.exaApiKey).toBe("sk-test");
	});

	it("treats an empty selector value as unset, falling back to the default", () => {
		const cfg = parseWebProviderConfig({
			[WEB_SEARCH_PROVIDER_ENV]: "",
		});
		expect(cfg.providerId).toBe(DEFAULT_WEB_SEARCH_PROVIDER);
	});
});
