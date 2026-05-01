// Smoke tests for the Exa-backed WebSearchProvider. These pin the
// d3r-side seams: the response mapper (snippet selection, title
// fallback, provider tag), the typed MissingApiKeyError contract
// callers rely on, and the AbortSignal cancellation wrapper. The
// mapper is exercised as a pure unit because the SDK boundary itself
// is upstream and not what the tests should be pinning.

import { afterEach, describe, expect, it } from "vitest";

import {
	MissingApiKeyError,
	createExaProvider,
	mapExaResponse,
} from "./exa.ts";

const ORIGINAL_KEY = process.env.EXA_API_KEY;

afterEach(() => {
	if (ORIGINAL_KEY === undefined) {
		delete process.env.EXA_API_KEY;
	} else {
		process.env.EXA_API_KEY = ORIGINAL_KEY;
	}
});

describe("mapExaResponse", () => {
	it("prefers highlights[0] over text for the snippet", () => {
		const result = mapExaResponse({
			results: [
				{
					title: "First",
					url: "https://a.example/",
					text: "ignored when highlights are present",
					highlights: ["highlight wins", "second"],
				},
			],
		});
		expect(result.provider).toBe("exa");
		expect(result.hits[0]).toEqual({
			title: "First",
			url: "https://a.example/",
			snippet: "highlight wins",
		});
	});

	it("falls back to text when highlights are empty or missing", () => {
		const result = mapExaResponse({
			results: [
				{
					title: "Empty highlights",
					url: "https://b.example/",
					text: "fallback body",
					highlights: [],
				},
				{
					title: "Missing highlights",
					url: "https://c.example/",
					text: "another fallback",
				},
			],
		});
		expect(result.hits.map((h) => h.snippet)).toEqual([
			"fallback body",
			"another fallback",
		]);
	});

	it("emits an empty snippet when neither highlights nor text are present", () => {
		const result = mapExaResponse({
			results: [{ title: "Bare", url: "https://d.example/" }],
		});
		expect(result.hits[0]?.snippet).toBe("");
	});

	it("substitutes the URL when an Exa result has no title", () => {
		const result = mapExaResponse({
			results: [
				{ url: "https://untitled.example/page", text: "body" },
				{ title: null, url: "https://null-title.example/", text: "x" },
			],
		});
		expect(result.hits.map((h) => h.title)).toEqual([
			"https://untitled.example/page",
			"https://null-title.example/",
		]);
	});

	it("truncates the text fallback at 280 characters", () => {
		const LIMIT = 280;
		const LONG_INPUT = 1000;
		const result = mapExaResponse({
			results: [
				{
					title: "Long",
					url: "https://long.example/",
					text: "x".repeat(LONG_INPUT),
				},
			],
		});
		expect(result.hits[0]?.snippet.length).toBe(LIMIT);
		expect(result.hits[0]?.snippet).toBe("x".repeat(LIMIT));
	});

	it("tags every result with the exa provider id", () => {
		const result = mapExaResponse({ results: [] });
		expect(result).toEqual({ hits: [], provider: "exa" });
	});
});

describe("createExaProvider", () => {
	it("throws MissingApiKeyError lazily when EXA_API_KEY is unset", async () => {
		delete process.env.EXA_API_KEY;
		const provider = createExaProvider();

		await expect(
			provider.search({ query: "ping", k: 1 }),
		).rejects.toBeInstanceOf(MissingApiKeyError);
		await expect(
			provider.search({ query: "ping", k: 1 }),
		).rejects.toMatchObject({
			name: "MissingApiKeyError",
			envVar: "EXA_API_KEY",
		});
	});

	it("does not read EXA_API_KEY at construction time", () => {
		delete process.env.EXA_API_KEY;
		expect(() => createExaProvider()).not.toThrow();
	});

	it("rejects synchronously when the caller's signal is already aborted", async () => {
		process.env.EXA_API_KEY = "test-key";
		const provider = createExaProvider();
		const ac = new AbortController();
		ac.abort();

		await expect(
			provider.search({ query: "q", k: 1 }, ac.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects promptly when the caller's signal fires mid-flight", async () => {
		process.env.EXA_API_KEY = "test-key";
		const provider = createExaProvider();
		const ac = new AbortController();
		const pending = provider.search({ query: "q", k: 1 }, ac.signal);
		// Swallow the eventual upstream rejection so the unhandled
		// rejection does not pollute later tests; the assertion below
		// checks the abort wrapper rejected first.
		pending.catch(() => undefined);
		ac.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});
});
