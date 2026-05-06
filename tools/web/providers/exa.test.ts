// Smoke tests for the Exa-backed WebSearchProvider. These pin the
// d3r-side seams: the search and fetch response mappers (id/url
// fallback, highlight passthrough, optional-field carry, full-text
// passthrough), the missing-api-key construction-time precondition
// callers rely on, and the AbortSignal cancellation wrapper. The mappers are
// exercised as pure units because the SDK boundary itself is
// upstream and not what the tests should be pinning.

import { afterEach, describe, expect, it } from "vitest";

import {
	createExaProvider,
	mapFetchResponse,
	mapSearchResponse,
} from "./exa.ts";

// Tiny helper: tests that exercise the search/fetch surfaces want a
// constructed provider, not the Result wrapper. Centralised here so
// any future shape change to createExaProvider's return type touches
// one site.
const makeProvider = (
	options: Parameters<typeof createExaProvider>[0] = {},
) => {
	const result = createExaProvider(options);
	if (!result.ok) {
		throw new Error(`expected provider, got ${JSON.stringify(result.error)}`);
	}
	return result.value;
};

const ORIGINAL_KEY = process.env.EXA_API_KEY;

afterEach(() => {
	if (ORIGINAL_KEY === undefined) {
		delete process.env.EXA_API_KEY;
	} else {
		process.env.EXA_API_KEY = ORIGINAL_KEY;
	}
});

describe("mapSearchResponse", () => {
	it("passes every highlight through, not just the first", () => {
		const result = mapSearchResponse({
			results: [
				{
					id: "exa-id-1",
					title: "First",
					url: "https://a.example/",
					highlights: ["one", "two", "three"],
				},
			],
		});
		expect(result.hits[0]?.highlights).toEqual(["one", "two", "three"]);
	});

	it("emits an empty highlights array when the field is missing or null", () => {
		const result = mapSearchResponse({
			results: [
				{ id: "x", url: "https://x.example/" },
				{ id: "y", url: "https://y.example/", highlights: null },
				{ id: "z", url: "https://z.example/", highlights: [] },
			],
		});
		expect(result.hits.map((h) => h.highlights)).toEqual([[], [], []]);
	});

	it("substitutes the URL when an Exa result has no title", () => {
		const result = mapSearchResponse({
			results: [
				{ id: "a", url: "https://untitled.example/page" },
				{ id: "b", title: null, url: "https://null-title.example/" },
			],
		});
		expect(result.hits.map((h) => h.title)).toEqual([
			"https://untitled.example/page",
			"https://null-title.example/",
		]);
	});

	it("falls back to the URL when Exa omits an id", () => {
		const result = mapSearchResponse({
			results: [{ url: "https://no-id.example/" }],
		});
		expect(result.hits[0]?.id).toBe("https://no-id.example/");
	});

	it.each([
		{
			label: "carries through score and publishedDate when present",
			input: {
				id: "with-extras",
				url: "https://e.example/",
				score: 0.87,
				publishedDate: "2025-01-02T00:00:00Z",
			},
			expected: { score: 0.87, publishedDate: "2025-01-02T00:00:00Z" },
			omitted: false,
		},
		{
			label: "omits score and publishedDate when Exa returns null/undefined",
			input: {
				id: "no-extras",
				url: "https://n.example/",
				score: null,
				publishedDate: null,
			},
			expected: {},
			omitted: true,
		},
	])("$label", ({ input, expected, omitted }) => {
		const result = mapSearchResponse({ results: [input] });
		if (omitted) {
			expect(result.hits[0]).not.toHaveProperty("score");
			expect(result.hits[0]).not.toHaveProperty("publishedDate");
		} else {
			expect(result.hits[0]).toMatchObject(expected);
		}
	});
});

describe("mapFetchResponse", () => {
	it("passes the full extracted text through with no truncation", () => {
		const LONG = 5000;
		const text = "x".repeat(LONG);
		const result = mapFetchResponse({
			results: [{ url: "https://long.example/", title: "Long", text }],
		});
		expect(result.docs[0]?.text).toBe(text);
		expect(result.docs[0]?.text.length).toBe(LONG);
	});

	it("preserves a null title (distinguishing it from the URL fallback used in search)", () => {
		const result = mapFetchResponse({
			results: [{ url: "https://no-title.example/", text: "body" }],
		});
		expect(result.docs[0]?.title).toBeNull();
	});

	it.each([
		{
			label: "carries through publishedDate and author when present",
			input: {
				url: "https://withmeta.example/",
				title: "Meta",
				text: "body",
				publishedDate: "2024-12-31",
				author: "Some Author",
			},
			expected: { publishedDate: "2024-12-31", author: "Some Author" },
			omitted: false,
		},
		{
			label: "omits publishedDate and author when null/undefined",
			input: {
				url: "https://bare.example/",
				title: "Bare",
				text: "body",
				publishedDate: null,
				author: null,
			},
			expected: {},
			omitted: true,
		},
	])("$label", ({ input, expected, omitted }) => {
		const result = mapFetchResponse({ results: [input] });
		if (omitted) {
			expect(result.docs[0]).not.toHaveProperty("publishedDate");
			expect(result.docs[0]).not.toHaveProperty("author");
		} else {
			expect(result.docs[0]).toMatchObject(expected);
		}
	});

	it("substitutes an empty string when text is missing or null", () => {
		const result = mapFetchResponse({
			results: [
				{ url: "https://no-text.example/" },
				{ url: "https://null-text.example/", text: null },
			],
		});
		expect(result.docs.map((d) => d.text)).toEqual(["", ""]);
	});
});

describe("createExaProvider - search()", () => {
	it("returns a missing-api-key Result when EXA_API_KEY is unset", () => {
		delete process.env.EXA_API_KEY;
		const result = createExaProvider();
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({
			kind: "missing-api-key",
			envVar: "EXA_API_KEY",
		});
	});

	it("rejects synchronously when the caller's signal is already aborted", async () => {
		// Stub client whose methods throw if invoked. The short-circuit
		// on `signal.aborted` happens before the SDK call, so reaching
		// either method indicates a regression.
		const provider = makeProvider({
			client: {
				searchAndContents: () => {
					throw new Error("searchAndContents must not be invoked when aborted");
				},
				getContents: () => {
					throw new Error("getContents must not be invoked when aborted");
				},
			},
		});
		const ac = new AbortController();
		ac.abort();

		await expect(
			provider.search({ query: "q", k: 1 }, ac.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects promptly when the caller's signal fires mid-flight", async () => {
		// Stub returns a promise that never resolves, so the only way
		// the test completes is via the abort race rejecting.
		const provider = makeProvider({
			client: {
				searchAndContents: () => new Promise(() => {}),
				getContents: () => new Promise(() => {}),
			},
		});
		const ac = new AbortController();
		const pending = provider.search({ query: "q", k: 1 }, ac.signal);
		ac.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("createExaProvider - fetch()", () => {
	it("returns a missing-api-key Result when EXA_API_KEY is unset", () => {
		delete process.env.EXA_API_KEY;
		const result = createExaProvider();
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toEqual({
			kind: "missing-api-key",
			envVar: "EXA_API_KEY",
		});
	});

	it("rejects synchronously when the caller's signal is already aborted", async () => {
		const provider = makeProvider({
			client: {
				searchAndContents: () => {
					throw new Error("searchAndContents must not be invoked when aborted");
				},
				getContents: () => {
					throw new Error("getContents must not be invoked when aborted");
				},
			},
		});
		const ac = new AbortController();
		ac.abort();

		await expect(
			provider.fetch({ urls: ["https://x.example/"] }, ac.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects promptly when the caller's signal fires mid-flight", async () => {
		const provider = makeProvider({
			client: {
				searchAndContents: () => new Promise(() => {}),
				getContents: () => new Promise(() => {}),
			},
		});
		const ac = new AbortController();
		const pending = provider.fetch({ urls: ["https://x.example/"] }, ac.signal);
		ac.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});
});
