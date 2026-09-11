import { types } from "node:util";
import { z } from "zod";

/** Reporting categories do not prescribe retries, routing, or authorization policy. */
const categorySchema = z.enum([
	"auth",
	"access",
	"rate_limit",
	"quota",
	"invalid_request",
	"model_unavailable",
	"context_limit",
	"network",
	"timeout",
	"provider_error",
	"unknown",
]);

/** Only reviewed protocol codes can cross the reporting boundary; never free text. */
const codeSchema = z.enum([
	"auth",
	"oauth",
	"authentication_error",
	"invalid_api_key",
	"invalid_token",
	"invalid_grant",
	"token_expired",
	"unauthorized",
	"permission_error",
	"permission_denied",
	"access_denied",
	"forbidden",
	"insufficient_permissions",
	"rate_limit_error",
	"rate_limit_exceeded",
	"too_many_requests",
	"insufficient_quota",
	"quota_exceeded",
	"billing_hard_limit_reached",
	"usage_limit_reached",
	"usage_not_included",
	"invalid_request_error",
	"invalid_request_body",
	"invalid_request",
	"bad_request",
	"unsupported_parameter",
	"unsupported_value",
	"invalid_value",
	"invalid_function_parameters",
	"invalid_tool_schema",
	"model_not_found",
	"model_not_supported",
	"model_unavailable",
	"not_found_error",
	"context_length_exceeded",
	"context_window_exceeded",
	"prompt_too_long",
	"request_too_large",
	"timeout",
	"request_timeout",
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"ECONNRESET",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EPIPE",
	"UND_ERR_SOCKET",
	"network_error",
	"api_error",
	"server_error",
	"internal_error",
	"internal_server_error",
	"overloaded_error",
	"service_unavailable",
]);

/** Fixed details refine invalid requests without retaining schema or option payloads. */
const detailSchema = z.enum([
	"invalid_tool_schema",
	"invalid_thinking_options",
]);

/** Reject oversized identity values before regex or schema work. */
const maxIdentityLength = 160;

/** Identity comes from configured catalog metadata, never from an exception. */
const identitySchema = z
	.string()
	.max(maxIdentityLength)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:[/:][A-Za-z0-9][A-Za-z0-9._-]*)*$/)
	.refine((value) => !value.includes(".."));

/** The reporting shape is deliberately shallow and contains no diagnostic objects. */
const failureSchema = z
	.object({
		stage: z.enum(["model_request", "output"]),
		category: categorySchema,
		// oxlint-disable-next-line no-magic-numbers -- HTTP status range, including streaming success responses.
		httpStatus: z.number().int().min(100).max(599).optional(),
		provider: identitySchema.optional(),
		model: identitySchema.optional(),
		toolsStarted: z.boolean(),
		code: codeSchema.optional(),
		detail: detailSchema.optional(),
	})
	.readonly();

/** Safe, detached reporting data for one runtime invocation, not the whole workflow. */
export type RuntimeFailure = z.infer<typeof failureSchema>;
/** The failing boundary, independent of whether any model text was streamed. */
export type RuntimeFailureStage = RuntimeFailure["stage"];
/** Harness-neutral classification, including explicitly unavailable details. */
export type RuntimeFailureCategory = RuntimeFailure["category"];
/** Allowlisted error identifiers, not arbitrary provider-supplied strings. */
export type RuntimeFailureCode = NonNullable<RuntimeFailure["code"]>;
/** Fixed request incompatibilities that can be reported without echoing a payload. */
export type RuntimeFailureDetail = NonNullable<RuntimeFailure["detail"]>;

/** Read only named own data properties; do not execute accessors or coercion hooks. */
const ownValue = (value: unknown, key: string): unknown => {
	if (value === null || typeof value !== "object" || types.isProxy(value)) {
		return undefined;
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
};

/** Project a fixed number of fields before schema parsing, ignoring all extra data. */
const parseFailure = (value: unknown): RuntimeFailure | undefined => {
	const fields = Object.fromEntries(
		Object.keys(failureSchema.unwrap().shape).map((key) => [
			key,
			ownValue(value, key),
		]),
	);
	// Do not pass diagnostic-owned objects into a validator that may inspect them.
	for (const [key, field] of Object.entries(fields)) {
		if (key === "provider" || key === "model") {
			// Custom catalogs may use URLs or paths as IDs. Omit rather than display them.
			if (
				typeof field !== "string" ||
				field.length > maxIdentityLength ||
				!identitySchema.safeParse(field).success
			) {
				delete fields[key];
			}
		} else if (
			field !== undefined &&
			!["string", "boolean", "number"].includes(typeof field)
		) {
			return undefined;
		} else if (typeof field === "string" && field.length > maxIdentityLength) {
			return undefined;
		}
	}
	const parsed = failureSchema.safeParse(fields);
	return parsed.success ? parsed.data : undefined;
};

/** Fixed explanation and next step per category; unknown does not guess auth or retry. */
const guidance: Readonly<Record<RuntimeFailureCategory, string>> = {
	auth: "Provider authentication failed. Check the configured provider credentials or sign in again.",
	access:
		"The provider denied access. Check account permissions and access to the configured model.",
	rate_limit:
		"The provider reported a rate limit. Wait for the limit to reset before another request.",
	quota:
		"The provider reported an account quota or billing limit. Check usage allowance and billing with the provider.",
	invalid_request:
		"The provider rejected the request configuration. Check model options and tool definitions for compatibility.",
	model_unavailable:
		"The requested model or endpoint is unavailable. Check the configured model ID and provider availability.",
	context_limit:
		"The request exceeded the model's input or context limit. Reduce the conversation or attached content.",
	network:
		"The provider connection failed. Check network connectivity and provider availability.",
	timeout:
		"The provider request timed out. Check connectivity and provider status before another request.",
	provider_error:
		"The provider reported a service error. Check provider status before another request.",
	unknown:
		"Safe failure details are unavailable. Check the runtime and provider configuration; contact support if the problem persists.",
};

/** Details replace generic request advice only when the adapter has reliable evidence. */
const detailGuidance: Readonly<Record<RuntimeFailureDetail, string>> = {
	invalid_tool_schema:
		"The provider rejected a tool schema. Check tool definitions against the configured model's supported schema format.",
	invalid_thinking_options:
		"The provider rejected thinking or reasoning options. Check the configured thinking level and model option compatibility.",
};

/** Human-readable Markdown-compatible reporting; never a dump of diagnostic data. */
export const formatRuntimeFailure = (failure: RuntimeFailure): string => {
	const safe = parseFailure(failure);
	if (!safe) {
		return `Model request failed. ${guidance.unknown}`;
	}
	const prefix =
		safe.stage === "output"
			? "Runtime output delivery failed"
			: "Model request failed";
	const metadata = [
		...(safe.provider ? [`provider \`${safe.provider}\``] : []),
		...(safe.model ? [`model \`${safe.model}\``] : []),
		...(safe.httpStatus === undefined ? [] : [`HTTP ${safe.httpStatus}`]),
		...(safe.code ? [`code \`${safe.code}\``] : []),
	];
	let explanation = guidance[safe.category];
	if (safe.stage === "output") {
		explanation =
			"The client could not receive runtime output. Check the client connection before continuing.";
	} else if (safe.category === "invalid_request" && safe.detail) {
		explanation = detailGuidance[safe.detail];
	}
	const effects = safe.toolsStarted
		? "Tools started in this invocation and may have had effects. Review prior tool results before repeating work."
		: "No tool execution started in this invocation.";
	return `${prefix}${metadata.length ? ` (${metadata.join("; ")})` : ""}. ${explanation} ${effects}`;
};

/** Return an ordinary Error with only validated reporting data, never an original cause. */
export const createRuntimeFailure = (failure: RuntimeFailure): Error => {
	const safe = parseFailure(failure);
	if (!safe) {
		throw new Error("Invalid runtime failure data");
	}
	const error = new Error(formatRuntimeFailure(safe));
	// Even serializers that explicitly inspect Error properties must not expose paths.
	delete error.stack;
	Object.defineProperty(error, "runtimeFailure", {
		value: safe,
		enumerable: true,
	});
	return error;
};

/** Read tagged data only; a raw Error message is never a safe reporting contract. */
export const readRuntimeFailure = (
	error: unknown,
): RuntimeFailure | undefined =>
	parseFailure(ownValue(error, "runtimeFailure"));
