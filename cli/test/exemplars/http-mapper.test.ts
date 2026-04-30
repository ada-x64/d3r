// Smoke test for fetchAndMapVersion. The intent is to pin the
// d3r-side mapping (`version` → `latest`) and the error
// translation (HTTP 5xx → typed throw) the rest of the codebase
// will rely on. MSW intercepts the network so the test stays
// hermetic; the assertions are about the mapper's behaviour, not
// about fetch or MSW themselves.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { fetchAndMapVersion } from "./http-mapper.ts";

const ENDPOINT = "https://example.test/v.json";

const server = setupServer();

beforeAll(() => {
	server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
	server.resetHandlers();
});

afterAll(() => {
	server.close();
});

describe("fetchAndMapVersion", () => {
	it("renames `version` to `latest` on a 200 response", async () => {
		server.use(
			http.get(ENDPOINT, () => HttpResponse.json({ version: "1.2.3" })),
		);

		const result = await fetchAndMapVersion(ENDPOINT);

		expect(result).toMatchInlineSnapshot(`
			{
			  "latest": "1.2.3",
			}
		`);
	});

	it("rejects with a typed error when the upstream returns 5xx", async () => {
		server.use(
			http.get(ENDPOINT, () => new HttpResponse(null, { status: 500 })),
		);

		await expect(fetchAndMapVersion(ENDPOINT)).rejects.toThrow(/http 500/);
	});

	it("rejects with a ZodError when the body is missing `version`", async () => {
		server.use(http.get(ENDPOINT, () => HttpResponse.json({ ver: "1.2.3" })));

		await expect(fetchAndMapVersion(ENDPOINT)).rejects.toBeInstanceOf(ZodError);
	});
});
