/* oxlint-disable no-magic-numbers -- Boundary values, HTTP status codes and deadlines are test fixtures. */
import {
	type RuntimeClientServices,
	type RuntimeToolContext,
} from "@d3r/core/runtime";
import { type WebProviderConfig, type WebSearchProvider } from "@d3r/tools";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { compileTools } from "../../adapters/pi/embedded-tools.ts";
import { WEB_LIMITS } from "./web-exa.ts";
import { createWebTools } from "./web-tools.ts";

/** These are the production destinations, intercepted below the real provider boundary. */
const SEARCH = "https://api.exa.ai/search";
const CONTENTS = "https://api.exa.ai/contents";
const KEY = "test-exa-secret+/=";
const config: WebProviderConfig = { providerId: "exa", exaApiKey: KEY };
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
	server.resetHandlers();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
afterAll(() => server.close());

/** Direct execution represents the post-approval seam; runtime approval has separate tests. */
const context = (
	signal = new AbortController().signal,
): RuntimeToolContext => ({
	toolCallId: "web-test",
	cwd: "/workspace",
	roots: ["/workspace"],
	signal,
});

/** No shell/network implementation is hidden behind the optional provider seam. */
const fakeProvider = (): WebSearchProvider => ({
	search: vi.fn(async () => ({ hits: [] })),
	fetch: vi.fn(async () => ({ docs: [] })),
});

/** A started request can be cancelled deterministically without sleeping. */
const deferred = <T>() => {
	const state: { resolve?: (value: T) => void } = {};
	const promise = new Promise<T>((done) => {
		state.resolve = done;
	});
	return { promise, resolve: (value: T) => state.resolve!(value) };
};

describe("native web tool factory", () => {
	it("is inert at discovery, registers credentials, and exposes fixed independent scopes", () => {
		const network = vi.spyOn(globalThis, "fetch");
		const client: RuntimeClientServices = {
			requestPermission: vi.fn(),
			registerSecrets: vi.fn(),
		};
		const tools = createWebTools({ config, client });
		expect(
			tools.map(({ name, permission, permissionScope }) => ({
				name,
				permission,
				permissionScope,
			})),
		).toEqual([
			{
				name: "web_search",
				permission: "ask",
				permissionScope: {
					id: "exa:web_search",
					label: "web searches via Exa",
				},
			},
			{
				name: "web_fetch",
				permission: "ask",
				permissionScope: { id: "exa:web_fetch", label: "web fetches via Exa" },
			},
		]);
		expect(client.registerSecrets).toHaveBeenCalledWith(
			expect.arrayContaining([KEY, encodeURIComponent(KEY)]),
		);
		expect(JSON.stringify(tools)).not.toContain(KEY);
		expect(network).not.toHaveBeenCalled();
		expect(client.requestPermission).not.toHaveBeenCalled();
	});

	it("compiles model-visible schemas without authority or credential arguments", () => {
		const [search, fetch] = compileTools(createWebTools({ config }));
		expect(search.parameters).toMatchObject({
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: {
				query: { type: "string", maxLength: WEB_LIMITS.queryChars },
				k: { type: "integer", maximum: 20, default: 5 },
			},
		});
		expect(fetch.parameters).toMatchObject({
			type: "object",
			additionalProperties: false,
			required: ["urls"],
			properties: {
				urls: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: { type: "string", format: "uri" },
				},
			},
		});
		expect(search.parameters).toHaveProperty("properties", {
			query: expect.anything(),
			k: expect.anything(),
		});
		expect(fetch.parameters).toHaveProperty("properties", {
			urls: expect.anything(),
		});
	});

	it.each([undefined, "", "  "])(
		"keeps both tools available as safe configuration errors for key %s",
		async (exaApiKey) => {
			const provider = fakeProvider();
			const tools = createWebTools({
				config: { providerId: "exa", exaApiKey },
				provider,
			});
			const results = await Promise.all(
				tools.map((tool) => tool.execute({}, context())),
			);
			expect(tools.map((tool) => tool.permission)).toEqual(["none", "none"]);
			for (const result of results) {
				expect(result.isError).toBe(true);
				expect(result.text).toContain("configure EXA_API_KEY");
				expect(result.text).not.toMatch(/curl|shell/i);
			}
			expect(provider.search).not.toHaveBeenCalled();
			expect(provider.fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ providerId: KEY, exaApiKey: KEY },
		{ providerId: "__proto__", exaApiKey: KEY },
		{ providerId: "exa", exaApiKey: `${KEY}\r\nx-bad: value` },
	])(
		"does not throw or echo invalid provider configuration",
		async (invalid) => {
			const tools = createWebTools({ config: invalid });
			expect(tools.every((tool) => tool.permission === "none")).toBe(true);
			await Promise.all(
				tools.map(async (tool) => {
					const result = await tool.execute({}, context());
					expect(result.isError).toBe(true);
					expect(result.text).toContain("invalid web provider configuration");
					expect(result.text).not.toContain(KEY);
				}),
			);
		},
	);

	it("fails closed without blocking the session if secret registration fails", async () => {
		const provider = fakeProvider();
		const tools = createWebTools({
			config,
			provider,
			client: {
				requestPermission: vi.fn(),
				registerSecrets: () => {
					throw new Error(KEY);
				},
			},
		});
		expect(tools.every((tool) => tool.permission === "none")).toBe(true);
		expect(await tools[0].execute({ query: "test" }, context())).toEqual({
			isError: true,
			text: "Web tools unavailable: credential redaction could not be configured safely.",
		});
		expect(provider.search).not.toHaveBeenCalled();
	});

	it("keeps shared defaults/count bounds and rejects model-owned authority fields", async () => {
		const provider = fakeProvider();
		const [search, fetch] = createWebTools({ config, provider });
		expect(search.schema.parse({ query: "research" })).toEqual({
			query: "research",
			k: 5,
		});
		await Promise.all(
			[
				{ query: "" },
				{ query: "q", k: 0 },
				{ query: "q", k: 21 },
				{ query: "q", k: 1.5 },
				{ query: "q", roots: ["/"] },
				{ query: "q", permissionScope: { id: "arbitrary" } },
				{ query: "q", apiKey: KEY },
				{ query: "x".repeat(WEB_LIMITS.queryChars + 1) },
			].map(async (args) => {
				expect(search.schema.safeParse(args).success).toBe(false);
				const result = await search.execute(args, context());
				expect(result.isError).toBe(true);
			}),
		);
		await Promise.all(
			[
				{ urls: [] },
				{ urls: Array(21).fill("https://example.test") },
				{ urls: ["https://example.test"], roots: ["/"] },
			].map(async (args) => {
				expect(fetch.schema.safeParse(args).success).toBe(false);
				const result = await fetch.execute(args, context());
				expect(result.isError).toBe(true);
			}),
		);
		expect(search.schema.safeParse({ query: "q", k: 20 }).success).toBe(true);
		expect(
			fetch.schema.safeParse({ urls: Array(20).fill("https://example.test") })
				.success,
		).toBe(true);
		expect(provider.search).not.toHaveBeenCalled();
		expect(provider.fetch).not.toHaveBeenCalled();
	});

	it.each([
		"file:///etc/passwd",
		"ftp://example.test",
		// oxlint-disable-next-line no-script-url -- Rejected scheme fixture, never executed.
		"javascript:alert(1)",
		"data:text/plain,secret",
		"/relative",
		"//example.test",
		"https:example.test",
		"https://user:private-password@example.test",
		"https://user@example.test",
		"https://@example.test",
		"https://example.test/?api_key=private-password",
		"https://example.test/?accessToken=private-password",
		"https://example.test/with space",
		String.raw`https://example.test\@other.test`,
		"https://example.test/\0",
		"https:////example.test",
		`https://example.test/${"x".repeat(WEB_LIMITS.urlChars)}`,
	])(
		"rejects unsafe URL without network or credential echo %#",
		async (url) => {
			const provider = fakeProvider();
			const [, tool] = createWebTools({ config, provider });
			expect(tool.schema.safeParse({ urls: [url] }).success).toBe(false);
			const result = await tool.execute({ urls: [url] }, context());
			expect(result.isError).toBe(true);
			expect(result.text).not.toContain("private-password");
			expect(provider.fetch).not.toHaveBeenCalled();
		},
	);

	it("passes parsed arguments and an abort signal to the trusted provider seam", async () => {
		const provider = fakeProvider();
		const [search, fetch] = createWebTools({ config, provider });
		await search.execute({ query: "query" }, context());
		await fetch.execute(
			{ urls: ["http://example.test/?q=visible", "https://example.test/a"] },
			context(),
		);
		expect(provider.search).toHaveBeenCalledWith(
			{ query: "query", k: 5 },
			expect.any(AbortSignal),
		);
		expect(provider.fetch).toHaveBeenCalledWith(
			{ urls: ["http://example.test/?q=visible", "https://example.test/a"] },
			expect.any(AbortSignal),
		);
	});

	it("never starts a pre-cancelled request or exposes its cancellation reason", async () => {
		const provider = fakeProvider();
		const controller = new AbortController();
		controller.abort(new Error(KEY));
		const result = await createWebTools({ config, provider })[0].execute(
			{ query: "q" },
			context(controller.signal),
		);
		expect(result).toEqual({ isError: true, text: "Web request cancelled." });
		expect(provider.search).not.toHaveBeenCalled();
	});
});

describe("native Exa HTTP boundary", () => {
	it("posts search arguments only to Exa and reuses the existing response mapping", async () => {
		const requests: Request[] = [];
		server.use(
			http.post(SEARCH, async ({ request }) => {
				requests.push(request);
				expect(request.headers.get("x-api-key")).toBe(KEY);
				expect(request.redirect).toBe("error");
				expect(await request.json()).toEqual({
					query: "visible research query",
					numResults: 5,
					contents: { highlights: true },
				});
				return HttpResponse.json({
					requestId: KEY,
					results: [
						{
							url: "https://example.test/one",
							id: null,
							title: null,
							highlights: null,
						},
						{
							url: "https://example.test/two",
							id: "two",
							title: "A title",
							highlights: ["snippet"],
							score: 0.8,
							publishedDate: "2026-01-01",
						},
					],
				});
			}),
		);
		const mutableConfig = { ...config };
		const [search] = createWebTools({ config: mutableConfig });
		mutableConfig.exaApiKey = "changed-after-construction";
		const result = await search.execute(
			{ query: "visible research query" },
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.text)).toEqual({
			hits: [
				{
					id: "https://example.test/one",
					url: "https://example.test/one",
					title: "https://example.test/one",
					highlights: [],
				},
				{
					id: "two",
					url: "https://example.test/two",
					title: "A title",
					highlights: ["snippet"],
					score: 0.8,
					publishedDate: "2026-01-01",
				},
			],
		});
		expect(requests).toHaveLength(1);
		expect(result.text).not.toContain(KEY);
	});

	it("fetches bounded extracted text via Exa /contents, never directly from supplied URLs", async () => {
		server.use(
			http.post(CONTENTS, async ({ request }) => {
				expect(request.headers.get("x-api-key")).toBe(KEY);
				expect(request.redirect).toBe("error");
				expect(await request.json()).toEqual({
					urls: ["https://example.test/a", "http://example.test/b"],
					text: { maxCharacters: WEB_LIMITS.textChars },
				});
				return HttpResponse.json({
					results: [
						{
							url: "https://example.test/a",
							title: "Page",
							text: "Extracted text",
							author: "Author",
							publishedDate: "2026-01-01",
						},
						{ url: "http://example.test/b" },
					],
				});
			}),
		);
		const result = await createWebTools({ config })[1].execute(
			{ urls: ["https://example.test/a", "http://example.test/b"] },
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.text)).toEqual({
			docs: [
				{
					url: "https://example.test/a",
					title: "Page",
					text: "Extracted text",
					author: "Author",
					publishedDate: "2026-01-01",
				},
				{ url: "http://example.test/b", title: null, text: "" },
			],
		});
	});

	it("redacts raw and encoded credentials echoed in successful results", async () => {
		server.use(
			http.post(CONTENTS, () =>
				HttpResponse.json({
					results: [
						{
							url: "https://example.test",
							title: KEY,
							text: `raw ${KEY}; encoded ${encodeURIComponent(KEY)}`,
						},
					],
				}),
			),
		);
		const result = await createWebTools({ config })[1].execute(
			{ urls: ["https://example.test"] },
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(result.text).toContain("[REDACTED]");
		expect(result.text).not.toContain(KEY);
		expect(result.text).not.toContain(encodeURIComponent(KEY));
	});

	it.each([
		() => new HttpResponse(KEY, { status: 401 }),
		() => new HttpResponse(KEY, { status: 429 }),
		() => new HttpResponse(KEY, { status: 500 }),
		() =>
			new HttpResponse(KEY, {
				headers: { "content-type": "application/json" },
			}),
		() => new HttpResponse("{}", { headers: { "content-type": "text/html" } }),
		() =>
			HttpResponse.json({
				results: [{ url: "https://example.test", highlights: [123] }],
			}),
		() =>
			HttpResponse.json({
				results: [{ url: "https://user:private-password@example.test" }],
			}),
		() => HttpResponse.json({ results: [{ url: "file:///etc/passwd" }] }),
		() =>
			HttpResponse.json({
				results: [{ url: "https://example.test/?token=private-password" }],
			}),
		() => HttpResponse.json({ error: KEY }),
		() =>
			HttpResponse.json({
				results: Array(6).fill({ url: "https://example.test" }),
			}),
		() =>
			new HttpResponse(null, {
				status: 307,
				headers: { location: "https://other.test/stolen" },
			}),
		() => HttpResponse.error(),
		() =>
			HttpResponse.json(
				{ results: [] },
				{ headers: { "content-length": String(WEB_LIMITS.responseBytes + 1) } },
			),
		() =>
			new HttpResponse(new Uint8Array([255]), {
				headers: { "content-type": "application/json" },
			}),
	])(
		"returns safe errors for HTTP, redirect and JSON boundary failures %#",
		async (response) => {
			server.use(http.post(SEARCH, response));
			const result = await createWebTools({ config })[0].execute(
				{ query: "q" },
				context(),
			);
			expect(result.isError).toBe(true);
			expect(result.text).toContain("Exa web request failed");
			expect(result.text).not.toContain(KEY);
			expect(result.text).not.toContain("private-password");
		},
	);

	it("rejects an oversized chunked response and aborts its underlying request", async () => {
		const requestSignals: AbortSignal[] = [];
		server.use(
			http.post(SEARCH, ({ request }) => {
				requestSignals.push(request.signal);
				return new HttpResponse(
					new ReadableStream({
						start: (stream) => {
							stream.enqueue(new Uint8Array(WEB_LIMITS.responseBytes + 1));
							stream.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}),
		);
		const result = await createWebTools({ config })[0].execute(
			{ query: "q" },
			context(),
		);
		expect(result.isError).toBe(true);
		expect(requestSignals).toHaveLength(1);
		expect(requestSignals[0].aborted).toBe(true);
	});

	it("bounds aggregate UTF-8 output with an explicit truncation marker", async () => {
		server.use(
			http.post(CONTENTS, () =>
				HttpResponse.json({
					results: [
						{
							url: "https://example.test",
							text: "\u{1f600}".repeat(WEB_LIMITS.outputBytes),
						},
					],
				}),
			),
		);
		const result = await createWebTools({ config })[1].execute(
			{ urls: ["https://example.test"] },
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(
			WEB_LIMITS.outputBytes,
		);
		expect(result.text).toContain("[Output truncated]");
		expect(result.text).not.toContain("\ufffd");
	});

	it("aborts a stalled contents request before response headers arrive", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const started = deferred<AbortSignal>();
		server.use(
			http.post(CONTENTS, async ({ request }) => {
				const stopped = new Promise<void>((resolve) => {
					request.signal.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				started.resolve(request.signal);
				await stopped;
				return HttpResponse.json({ results: [] });
			}),
		);
		const pending = createWebTools({ config })[1].execute(
			{ urls: ["https://example.test"] },
			context(),
		);
		const signal = await started.promise;
		await vi.advanceTimersByTimeAsync(WEB_LIMITS.timeoutMs);
		expect(await pending).toEqual({
			isError: true,
			text: "Exa web request timed out.",
		});
		expect(signal.aborted).toBe(true);
	});

	it.each(["cancel", "timeout"] as const)(
		"%s aborts the actual HTTP request, including while reading its body",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const started = deferred<AbortSignal>();
			const aborted = deferred<void>();
			server.use(
				http.post(SEARCH, ({ request }) => {
					request.signal.addEventListener("abort", () => aborted.resolve(), {
						once: true,
					});
					started.resolve(request.signal);
					return new HttpResponse(
						new ReadableStream({
							start: (stream) => {
								stream.enqueue(new TextEncoder().encode('{"results":['));
								request.signal.addEventListener(
									"abort",
									() => stream.error(new Error(KEY)),
									{ once: true },
								);
							},
						}),
						{ headers: { "content-type": "application/json" } },
					);
				}),
			);
			const controller = new AbortController();
			const pending = createWebTools({ config })[0].execute(
				{ query: "q" },
				context(controller.signal),
			);
			const requestSignal = await started.promise;
			if (mode === "cancel") {
				controller.abort(new Error(KEY));
			} else {
				await vi.advanceTimersByTimeAsync(WEB_LIMITS.timeoutMs);
			}
			const result = await pending;
			await aborted.promise;
			expect(requestSignal.aborted).toBe(true);
			expect(result).toEqual({
				isError: true,
				text:
					mode === "cancel"
						? "Web request cancelled."
						: "Exa web request timed out.",
			});
		},
	);
});
