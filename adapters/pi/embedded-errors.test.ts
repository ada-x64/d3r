import { ModelsError } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeFailure,
	formatRuntimeFailure,
	readRuntimeFailure,
} from "@d3r/core/runtime";
import { classifyPiFailure } from "./embedded-errors.ts";

/** Synthetic credential-bearing data is deliberately present in both keys and values. */
const secret =
	"Bearer fake-token https://private.invalid/token /private/credentials.json";

/** Codex emits this same friendly text for rate_limit_exceeded and any other HTTP 429. */
const codexUsageLimit =
	"You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.";

/** Match Pi's diagnostic envelope without retaining real provider data. */
const providerDiagnostic = (code: string) => ({
	type: "provider_transport_failure",
	timestamp: 0,
	error: { name: "Error", code, message: `${code}: ${secret}` },
	details: {
		configuredTransport: "websocket",
		eventsEmitted: false,
		phase: "before_message_stream_start",
	},
});

/** Provider dialects meet only at this adapter-owned, bounded classification boundary. */
describe("Pi failure classifier", () => {
	it.each([
		[
			'401 {"error":{"type":"authentication_error","message":"secret"}}',
			{ category: "auth", httpStatus: 401, code: "authentication_error" },
		],
		[
			'403: {"error":{"code":"permission_denied","message":"secret"}}',
			{ category: "access", httpStatus: 403, code: "permission_denied" },
		],
		[
			'OpenAI API error (429): {"error":{"type":"invalid_request_error","code":"insufficient_quota"}}',
			{ category: "quota", httpStatus: 429, code: "insufficient_quota" },
		],
		[
			'429 {"error":{"type":"rate_limit_error"}}',
			{ category: "rate_limit", httpStatus: 429, code: "rate_limit_error" },
		],
		[
			'400 {"error":{"type":"invalid_request_error","code":"context_length_exceeded"}}',
			{
				category: "context_limit",
				httpStatus: 400,
				code: "context_length_exceeded",
			},
		],
		[
			'404 {"error":{"code":"model_not_found"}}',
			{
				category: "model_unavailable",
				httpStatus: 404,
				code: "model_not_found",
			},
		],
		[
			'529 {"error":{"type":"overloaded_error"}}',
			{ category: "provider_error", httpStatus: 529, code: "overloaded_error" },
		],
		[
			"Error Code rate_limit_exceeded: private",
			{ category: "rate_limit", code: "rate_limit_exceeded" },
		],
		[
			{ statusCode: 422, error: { code: "unsupported_parameter" } },
			{
				category: "invalid_request",
				httpStatus: 422,
				code: "unsupported_parameter",
			},
		],
		[{ response: { status: 504 } }, { category: "timeout", httpStatus: 504 }],
		[{ status: 451 }, { category: "unknown", httpStatus: 451 }],
		[new ModelsError("auth", "private"), { category: "auth", code: "auth" }],
		[new ModelsError("oauth", "private"), { category: "auth", code: "oauth" }],
		[
			new Error("fetch failed", { cause: { code: "ECONNRESET" } }),
			{ category: "network", code: "ECONNRESET" },
		],
		[
			{ code: "UND_ERR_HEADERS_TIMEOUT" },
			{ category: "timeout", code: "UND_ERR_HEADERS_TIMEOUT" },
		],
		[{ code: "ETIMEDOUT" }, { category: "timeout", code: "ETIMEDOUT" }],
		[
			"connect ECONNREFUSED private.invalid",
			{ category: "network", code: "ECONNREFUSED" },
		],
		[
			"getaddrinfo ENOTFOUND private.invalid",
			{ category: "network", code: "ENOTFOUND" },
		],
		["ETIMEDOUT private.invalid", { category: "timeout", code: "ETIMEDOUT" }],
		[{ code: "ENOTFOUND" }, { category: "network", code: "ENOTFOUND" }],
		[
			{ name: "APIConnectionTimeoutError", message: "private" },
			{ category: "timeout" },
		],
		[
			{ name: "APIConnectionError", message: "private" },
			{ category: "network" },
		],
	])("retains only known category/status/code (%j)", (error, expected) => {
		expect(classifyPiFailure(error)).toEqual(expected);
	});

	it.each([
		"Provider authentication failed",
		"API key auth failed for provider test: Provider authentication failed",
		"OAuth refresh failed for test: Provider authentication failed",
		"OAuth auth derivation failed for test: Provider authentication failed",
		"Credential store read failed for test: private",
		"Provider is not configured: test",
		"No API key for provider: test",
	])("recognizes redacted library authentication text: %s", (message) => {
		expect(classifyPiFailure({ errorMessage: message }).category).toBe("auth");
	});

	it.each([
		[
			"Invalid schema for function 'private-tool': private",
			"invalid_tool_schema",
		],
		[
			"tools.0.input_schema: must be a valid JSON schema",
			"invalid_tool_schema",
		],
		[
			"thinking.budget_tokens: must be less than max_tokens",
			"invalid_thinking_options",
		],
		["Unsupported parameter: 'reasoning_effort'", "invalid_thinking_options"],
		["thinking is not supported on this model", "invalid_thinking_options"],
	])("reports fixed incompatibility details: %s", (message, detail) => {
		expect(
			classifyPiFailure({
				status: 400,
				error: { type: "invalid_request_error", message },
			}),
		).toEqual({
			category: "invalid_request",
			httpStatus: 400,
			code: "invalid_request_error",
			detail,
		});
	});

	it("prefers terminal failure over a recovered diagnostic and reads unrecovered diagnostic codes", () => {
		const diagnostic = {
			type: "provider_transport_failure",
			error: { message: secret, code: "ETIMEDOUT" },
		};
		expect(
			classifyPiFailure({ errorMessage: "opaque", diagnostics: [diagnostic] }),
		).toEqual({ category: "timeout", code: "ETIMEDOUT" });
		expect(
			classifyPiFailure({
				errorMessage: '401 {"error":{"code":"invalid_api_key"}}',
				diagnostics: [diagnostic],
			}),
		).toEqual({ category: "auth", httpStatus: 401, code: "invalid_api_key" });
		expect(
			classifyPiFailure({
				errorMessage: "opaque",
				diagnostics: [{ ...diagnostic, details: { fallbackTransport: "sse" } }],
			}),
		).toEqual({ category: "unknown" });
	});

	it.each([
		[{ errorMessage: codexUsageLimit }, { category: "unknown" }],
		[
			{ errorMessage: `429 ${codexUsageLimit}` },
			{ category: "rate_limit", httpStatus: 429 },
		],
		[
			{ status: 429, errorMessage: codexUsageLimit },
			{ category: "rate_limit", httpStatus: 429 },
		],
		...(["rate_limit_exceeded", "insufficient_quota"] as const).map(
			(code) =>
				[
					{
						errorMessage: `429 ${JSON.stringify({ error: { code, message: codexUsageLimit } })}`,
					},
					{
						category: code === "insufficient_quota" ? "quota" : "rate_limit",
						httpStatus: 429,
						code,
					},
				] as const,
		),
	] as const)(
		"does not infer quota from ambiguous Codex usage-limit text (%j)",
		(error, expected) => {
			expect(classifyPiFailure(error)).toEqual(expected);
		},
	);

	it.each([
		[
			"429 Too Many Requests",
			"insufficient_quota",
			{ category: "quota", httpStatus: 429, code: "insufficient_quota" },
		],
		[
			`429 ${codexUsageLimit}`,
			"insufficient_quota",
			{ category: "quota", httpStatus: 429, code: "insufficient_quota" },
		],
		[
			"OpenAI API error (400): 400 status code (no body)",
			"context_length_exceeded",
			{
				category: "context_limit",
				httpStatus: 400,
				code: "context_length_exceeded",
			},
		],
	] as const)(
		"refines a generic HTTP failure using an explicit diagnostic code (%s)",
		(errorMessage, code, expected) => {
			expect(
				classifyPiFailure({
					errorMessage,
					diagnostics: [providerDiagnostic(code)],
				}),
			).toEqual(expected);
		},
	);

	it.each([
		[
			'429 {"error":{"code":"rate_limit_exceeded"}}',
			"insufficient_quota",
			{ category: "rate_limit", httpStatus: 429, code: "rate_limit_exceeded" },
		],
		[
			'429 {"error":{"code":"insufficient_quota"}}',
			"rate_limit_exceeded",
			{ category: "quota", httpStatus: 429, code: "insufficient_quota" },
		],
		[
			'400 {"error":{"code":"invalid_function_parameters"}}',
			"context_length_exceeded",
			{
				category: "invalid_request",
				httpStatus: 400,
				code: "invalid_function_parameters",
				detail: "invalid_tool_schema",
			},
		],
		[
			'400 {"error":{"code":"context_length_exceeded"}}',
			"invalid_function_parameters",
			{
				category: "context_limit",
				httpStatus: 400,
				code: "context_length_exceeded",
			},
		],
		[
			"429 Too Many Requests",
			"invalid_api_key",
			{ category: "rate_limit", httpStatus: 429 },
		],
		[
			"400 Invalid schema for function 'write'",
			"context_length_exceeded",
			{
				category: "invalid_request",
				httpStatus: 400,
				detail: "invalid_tool_schema",
			},
		],
		[
			"400 Provider authentication failed",
			"context_length_exceeded",
			{ category: "auth", httpStatus: 400 },
		],
	] as const)(
		"preserves terminal codes/markers and rejects incompatible diagnostics (%s)",
		(errorMessage, code, expected) => {
			expect(
				classifyPiFailure({
					errorMessage,
					diagnostics: [providerDiagnostic(code)],
				}),
			).toEqual(expected);
		},
	);

	it.each([
		[
			"429 Too Many Requests",
			"insufficient_quota",
			{ category: "rate_limit", httpStatus: 429 },
		],
		[
			"OpenAI API error (400): 400 status code (no body)",
			"context_length_exceeded",
			{ category: "invalid_request", httpStatus: 400 },
		],
	] as const)(
		"does not refine HTTP categories using a recovered fallback diagnostic (%s)",
		(errorMessage, code, expected) => {
			const diagnostic = providerDiagnostic(code);
			expect(
				classifyPiFailure({
					errorMessage,
					diagnostics: [
						{
							...diagnostic,
							details: { ...diagnostic.details, fallbackTransport: "sse" },
						},
					],
				}),
			).toEqual(expected);
		},
	);

	it("retains compatible diagnostic codes and details alongside a status-only failure", () => {
		expect(
			classifyPiFailure({
				errorMessage: "400 bad request",
				diagnostics: [
					{ error: { code: "invalid_function_parameters", message: secret } },
				],
			}),
		).toEqual({
			category: "invalid_request",
			httpStatus: 400,
			code: "invalid_function_parameters",
			detail: "invalid_tool_schema",
		});
	});

	it.each([
		["400 Your credit balance is too low to access the API", "quota"],
		[
			'400 {"error":{"type":"invalid_request_error","message":"prompt is too long: private"}}',
			"context_limit",
		],
		[
			'400 {"error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}',
			"quota",
		],
	])(
		"refines generic status/type using a reliable provider marker (%s)",
		(message, category) => {
			expect(classifyPiFailure(message)).toMatchObject({
				category,
				httpStatus: 400,
			});
		},
	);

	it("never echoes diagnostics, credential-bearing header keys, causes or payload identities", () => {
		const raw = {
			status: 403,
			error: { type: "permission_error", message: secret },
			provider: "attacker-provider",
			model: "attacker-model",
			headers: { Authorization: secret, "x-api-key": secret, [secret]: secret },
			request: { status: 401, payload: secret },
			stack: secret,
			cause: { code: "unrecognized-secret-code", message: secret },
		};
		const error = createRuntimeFailure({
			stage: "model_request",
			...classifyPiFailure(raw),
			provider: "configured",
			model: "configured",
			toolsStarted: false,
		});
		expect(readRuntimeFailure(error)).toMatchObject({
			category: "access",
			httpStatus: 403,
			code: "permission_error",
		});
		const text = `${JSON.stringify(error)} ${error.message} ${formatRuntimeFailure(readRuntimeFailure(error)!)}`;
		expect(text).not.toMatch(
			/Bearer|fake-token|private|Authorization|x-api-key|headers|cause|stack|payload|attacker|unrecognized/,
		);
	});

	it.each([
		secret,
		"unknown auth retry secret",
		"content policy maybe",
		{ headers: { code: "invalid_api_key" }, request: { status: 401 } },
		{ message: "opaque", code: secret },
		{ status: Number.NaN },
		{ status: 999 },
		{ message: "thinking about tool schema" },
	])("does not guess from opaque text or unrelated fields (%j)", (input) => {
		expect(classifyPiFailure(input)).toEqual({ category: "unknown" });
	});

	it("skips getters, proxies, coercion hooks and cycles without executing diagnostic code", () => {
		const getter = vi.fn(() => {
			throw new Error("must not run");
		});
		const error = Object.defineProperties(
			{ status: 429 },
			Object.fromEntries(
				[
					"message",
					"errorMessage",
					"headers",
					"cause",
					"diagnostics",
					"code",
					"type",
					"toString",
					"toJSON",
				].map((key) => [key, { get: getter }]),
			),
		);
		expect(classifyPiFailure(error)).toEqual({
			category: "rate_limit",
			httpStatus: 429,
		});
		const proxy = new Proxy(
			{},
			{ get: getter, getOwnPropertyDescriptor: getter },
		);
		expect(classifyPiFailure(proxy)).toEqual({ category: "unknown" });
		const cycle = { status: 503, cause: {} };
		cycle.cause = cycle;
		expect(classifyPiFailure(cycle)).toEqual({
			category: "provider_error",
			httpStatus: 503,
		});
		expect(getter).not.toHaveBeenCalled();
	});

	it("bounds huge strings, sparse diagnostics and deeply nested JSON while keeping an available status", () => {
		const hugeLength = 1_000_000;
		const hugeDepth = 1000;
		const huge = "x".repeat(hugeLength);
		const sparse: unknown[] = [];
		sparse.length = hugeLength;
		expect(classifyPiFailure(`429 ${huge}`)).toEqual({
			category: "rate_limit",
			httpStatus: 429,
		});
		expect(classifyPiFailure({ status: 400, errorMessage: huge })).toEqual({
			category: "invalid_request",
			httpStatus: 400,
		});
		expect(classifyPiFailure({ diagnostics: sparse })).toEqual({
			category: "unknown",
		});
		expect(
			classifyPiFailure(
				`${'{"error":'.repeat(hugeDepth)}{}${"}".repeat(hugeDepth)}`,
			),
		).toEqual({ category: "unknown" });
	});
});
