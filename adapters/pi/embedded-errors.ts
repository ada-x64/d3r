import { types } from "node:util";
import {
	type RuntimeFailure,
	type RuntimeFailureCategory,
	type RuntimeFailureCode,
	type RuntimeFailureDetail,
} from "@d3r/core/runtime";

/** Only safe observations leave the classifier; model identity is supplied by the turn. */
export type PiFailureClassification = Pick<
	RuntimeFailure,
	"category" | "httpStatus" | "code" | "detail"
>;

/** Protocol vocabulary, not a search over arbitrary provider prose. */
const codeGroups: readonly {
	readonly category: RuntimeFailureCategory;
	readonly codes: readonly RuntimeFailureCode[];
}[] = [
	{
		category: "auth",
		codes: [
			"auth",
			"oauth",
			"authentication_error",
			"invalid_api_key",
			"invalid_token",
			"invalid_grant",
			"token_expired",
			"unauthorized",
		],
	},
	{
		category: "access",
		codes: [
			"permission_error",
			"permission_denied",
			"access_denied",
			"forbidden",
			"insufficient_permissions",
		],
	},
	{
		category: "quota",
		codes: [
			"insufficient_quota",
			"quota_exceeded",
			"billing_hard_limit_reached",
			"usage_limit_reached",
			"usage_not_included",
		],
	},
	{
		category: "rate_limit",
		codes: ["rate_limit_error", "rate_limit_exceeded", "too_many_requests"],
	},
	{
		category: "context_limit",
		codes: [
			"context_length_exceeded",
			"context_window_exceeded",
			"prompt_too_long",
			"request_too_large",
		],
	},
	{
		category: "model_unavailable",
		codes: [
			"model_not_found",
			"model_not_supported",
			"model_unavailable",
			"not_found_error",
		],
	},
	{
		category: "timeout",
		codes: [
			"timeout",
			"request_timeout",
			"ETIMEDOUT",
			"ESOCKETTIMEDOUT",
			"UND_ERR_CONNECT_TIMEOUT",
			"UND_ERR_HEADERS_TIMEOUT",
			"UND_ERR_BODY_TIMEOUT",
		],
	},
	{
		category: "network",
		codes: [
			"ECONNRESET",
			"ECONNREFUSED",
			"ENOTFOUND",
			"EAI_AGAIN",
			"ENETUNREACH",
			"EHOSTUNREACH",
			"EPIPE",
			"UND_ERR_SOCKET",
			"network_error",
		],
	},
	{
		category: "invalid_request",
		codes: [
			"invalid_function_parameters",
			"invalid_tool_schema",
			"unsupported_parameter",
			"unsupported_value",
			"invalid_value",
			"invalid_request_error",
			"invalid_request_body",
			"invalid_request",
			"bad_request",
		],
	},
	{
		category: "provider_error",
		codes: [
			"api_error",
			"server_error",
			"internal_error",
			"internal_server_error",
			"overloaded_error",
			"service_unavailable",
		],
	},
];

/** Limits apply before trimming, regex matching, JSON parsing, or walking nested data. */
const limits = {
	nodes: 64,
	depth: 8,
	text: 16_384,
	totalText: 65_536,
	prefix: 256,
	diagnostics: 8,
	minHttpStatus: 100,
	maxHttpStatus: 599,
} as const;

/** Skip accessors, prototypes, and proxies rather than running diagnostic-owned code. */
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

/** HTTP observations are never inferred from token counts or arbitrary numeric codes. */
const httpStatus = (value: unknown): number | undefined => {
	const number =
		typeof value === "string" && /^[1-5][0-9]{2}$/.test(value)
			? Number(value)
			: value;
	return typeof number === "number" &&
		Number.isInteger(number) &&
		number >= limits.minHttpStatus &&
		number <= limits.maxHttpStatus
		? number
		: undefined;
};

/** Return the literal from our vocabulary, not the original string. */
const knownCode = (value: unknown): RuntimeFailureCode | undefined => {
	if (typeof value !== "string" || value.length > limits.prefix) {
		return undefined;
	}
	return codeGroups
		.flatMap((group) => group.codes)
		.find((code) => code.toLowerCase() === value.toLowerCase());
};

/** Status-only evidence stays conservative: a 403 says access, not content policy. */
const statusCategory = (status: number | undefined): RuntimeFailureCategory => {
	// oxlint-disable no-magic-numbers -- HTTP protocol status codes.
	switch (status) {
		case 401: {
			return "auth";
		}
		case 403: {
			return "access";
		}
		case 402: {
			return "quota";
		}
		case 429: {
			return "rate_limit";
		}
		case 400:
		case 422: {
			return "invalid_request";
		}
		case 404:
		case 410: {
			return "model_unavailable";
		}
		case 413: {
			return "context_limit";
		}
		case 408:
		case 504: {
			return "timeout";
		}
		default: {
			return status !== undefined && status >= 500
				? "provider_error"
				: "unknown";
		}
	}
	// oxlint-enable no-magic-numbers
};

/** Only recognizable request-rejection markers produce specific configuration advice. */
const requestDetail = (text: string): RuntimeFailureDetail | undefined => {
	if (
		/\binvalid (?:json )?schema for (?:function|tool)\b/i.test(text) ||
		/\binvalid json schema:\s*regex lookaround is not supported\b/i.test(
			text,
		) ||
		/\binvalid (?:tool|function)(?: input)? schema\b/i.test(text) ||
		/\btools?(?:\.[0-9]+|\[[0-9]+\])?\.(?:input_schema|function\.parameters)\b[^\n]{0,160}\b(?:invalid|must|should|not supported)\b/i.test(
			text,
		)
	) {
		return "invalid_tool_schema";
	}
	if (
		/\b(?:thinking(?:\.budget_tokens|\.type)?|reasoning_effort|reasoning\.effort|output_config\.effort)\b[^\n]{0,120}\b(?:not supported|unsupported|invalid|must be|cannot be|not allowed)\b/i.test(
			text,
		) ||
		/\b(?:unsupported|invalid) (?:parameter|value|option)[^\n]{0,80}\b(?:thinking|reasoning_effort|reasoning\.effort|output_config\.effort)\b/i.test(
			text,
		)
	) {
		return "invalid_thinking_options";
	}
	return undefined;
};

/** These prefixes are emitted by the pinned library even after private auth redaction. */
const textCategory = (text: string): RuntimeFailureCategory | undefined => {
	if (
		/^(?:Provider authentication failed\b|Provider is not configured:|No API key for provider:|API key auth(?: check)? failed for provider\b|OAuth (?:refresh failed|auth derivation failed|refresh returned a token that expires too soon)\b|Credential store (?:read|modify|delete) failed for\b|Failed to extract accountId from token\b)/i.test(
			text,
		)
	) {
		return "auth";
	}
	if (
		/^(?:Connection error\.?$|fetch failed\b|Failed to fetch\b|connect (?:ECONNREFUSED|ECONNRESET|ENETUNREACH)\b|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)\b|Provider finish_reason: network_error\b)/i.test(
			text,
		)
	) {
		return "network";
	}
	if (
		/^(?:Request timed out\b|Connection timed out\b|WebSocket (?:connect|idle) timeout after\b|Codex SSE response headers timed out after\b)/i.test(
			text,
		)
	) {
		return "timeout";
	}
	if (
		/^(?:prompt is too long\b|request exceeds the maximum context|maximum context length|Your input exceeds the context window)/i.test(
			text,
		)
	) {
		return "context_limit";
	}
	if (
		/^(?:Your credit balance is too low\b|You exceeded your current quota\b|Monthly usage limit reached\b)/i.test(
			text,
		)
	) {
		return "quota";
	}
	return undefined;
};

/** Only local evidence is accumulated, and raw text is discarded on return. */
interface Evidence {
	httpStatus?: number;
	codes: RuntimeFailureCode[];
	category?: RuntimeFailureCategory;
	detail?: RuntimeFailureDetail;
	textChars: number;
}

/** Parse one bounded JSON object, allowing SDK prose before and after the body. */
const jsonBody = (text: string): unknown => {
	const start = text.indexOf("{");
	if (start === -1 || start > limits.prefix) {
		return undefined;
	}
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				quoted = false;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, index + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
};

/** Extract only a status, literal code, or fixed explanation from a bounded string. */
const inspectText = (value: string, evidence: Evidence): unknown => {
	const prefix = value.slice(0, limits.prefix).trimStart();
	const status =
		/^(?:(?:Error|APIError|OpenAI API error|Anthropic API error):?\s*)?(?:\(?(?:HTTP(?: status)?\s*)?)([1-5][0-9]{2})(?=[\s:)]|$)/i.exec(
			prefix,
		);
	evidence.httpStatus ??= httpStatus(status?.[1]);
	if (
		value.length > limits.text ||
		evidence.textChars + value.length > limits.totalText
	) {
		return undefined;
	}
	evidence.textChars += value.length;
	const trimmed = value.trim();
	const text = status
		? trimmed.slice(status[0].length).replace(/^[\s:)]*/, "")
		: trimmed.replace(/^(?:Error|ModelsError):\s*/, "");
	evidence.category ??= textCategory(text);
	const body = jsonBody(text);
	if (body !== undefined) {
		return body;
	}
	const code =
		knownCode(text) ??
		knownCode(/^(?:Error Code )?([A-Za-z_]+):/.exec(text)?.[1]) ??
		knownCode(
			/^(?:(?:connect|getaddrinfo|read|write) )?(E[A-Z_]+|UND_ERR_[A-Z_]+)(?=[:\s]|$)/.exec(
				text,
			)?.[1],
		);
	if (code) {
		evidence.codes.push(code);
	}
	evidence.detail ??= requestDetail(text);
	return undefined;
};

/* oxlint-disable no-continue -- Skip unsupported nodes in a bounded diagnostic walk. */
/** Walk only diagnostic fields, with fixed branching and a cycle/node/depth budget. */
const collectEvidence = (input: unknown): Evidence => {
	const evidence: Evidence = { codes: [], textChars: 0 };
	const pending = [{ value: input, depth: 0 }];
	const seen = new Set<object>();
	for (
		let index = 0;
		index < pending.length && index < limits.nodes;
		index += 1
	) {
		const { value, depth } = pending[index];
		if (depth > limits.depth) {
			continue;
		}
		if (typeof value === "string") {
			const body = inspectText(value, evidence);
			if (body !== undefined) {
				pending.push({ value: body, depth: depth + 1 });
			}
			continue;
		}
		if (
			value === null ||
			typeof value !== "object" ||
			types.isProxy(value) ||
			seen.has(value)
		) {
			continue;
		}
		seen.add(value);
		for (const key of [
			"status",
			"statusCode",
			"httpStatus",
			"httpStatusCode",
		]) {
			evidence.httpStatus ??= httpStatus(ownValue(value, key));
		}
		for (const key of ["code", "type"]) {
			const code = knownCode(ownValue(value, key));
			if (code) {
				evidence.codes.push(code);
			}
		}
		const name = ownValue(value, "name");
		if (name === "APIConnectionTimeoutError" || name === "TimeoutError") {
			evidence.category ??= "timeout";
		} else if (name === "APIConnectionError") {
			evidence.category ??= "network";
		}
		for (const key of [
			"errorMessage",
			"message",
			"error",
			"response",
			"body",
			"data",
			"details",
			"cause",
		]) {
			const child = ownValue(value, key);
			if (child !== undefined && pending.length < limits.nodes) {
				pending.push({ value: child, depth: depth + 1 });
			}
		}
	}
	return evidence;
};

/** Specific codes refine generic invalid-request and service-error wrappers. */
const classifyEvidence = (evidence: Evidence): PiFailureClassification => {
	const matches = evidence.codes.map((code) => ({
		code,
		category: codeGroups.find((group) => group.codes.includes(code))!.category,
	}));
	const specific = matches.find(
		({ category }) =>
			category !== "invalid_request" && category !== "provider_error",
	);
	const match = specific ?? matches[0];
	const detail = evidence.codes.some(
		(code) =>
			code === "invalid_function_parameters" || code === "invalid_tool_schema",
	)
		? "invalid_tool_schema"
		: evidence.detail;
	const category =
		specific?.category ??
		evidence.category ??
		(detail ? "invalid_request" : undefined) ??
		match?.category ??
		statusCategory(evidence.httpStatus);
	return {
		category,
		...(evidence.httpStatus === undefined
			? {}
			: { httpStatus: evidence.httpStatus }),
		...(match ? { code: match.code } : {}),
		...(category === "invalid_request" && detail ? { detail } : {}),
	};
};

/** A diagnostic code can narrow generic HTTP evidence, never an explicit terminal reason. */
const canRefineHttpCategory = (
	evidence: Evidence,
	diagnostic: PiFailureClassification,
): boolean => {
	if (
		evidence.codes.length > 0 ||
		evidence.category !== undefined ||
		evidence.detail !== undefined ||
		diagnostic.code === undefined
	) {
		return false;
	}
	const category = statusCategory(evidence.httpStatus);
	return (
		(category === "rate_limit" && diagnostic.category === "quota") ||
		(category === "invalid_request" && diagnostic.category === "context_limit")
	);
};

/** Terminal evidence wins; unrecovered diagnostics may supply missing compatible details. */
export const classifyPiFailure = (error: unknown): PiFailureClassification => {
	const primaryEvidence = collectEvidence(error);
	const primary = classifyEvidence(primaryEvidence);
	const diagnostics = ownValue(error, "diagnostics");
	if (
		!diagnostics ||
		types.isProxy(diagnostics) ||
		!Array.isArray(diagnostics)
	) {
		return primary;
	}
	const length = ownValue(diagnostics, "length");
	if (typeof length !== "number") {
		return primary;
	}
	for (
		let offset = 0;
		offset < Math.min(length, limits.diagnostics);
		offset += 1
	) {
		const diagnostic = ownValue(diagnostics, String(length - offset - 1));
		// A fallback diagnostic describes a recovered transport, not the terminal failure.
		if (
			ownValue(ownValue(diagnostic, "details"), "fallbackTransport") !==
			undefined
		) {
			continue;
		}
		const classified = classifyEvidence(collectEvidence(diagnostic));
		if (
			classified.category !== "unknown" &&
			(primary.category === "unknown" ||
				primary.category === classified.category ||
				canRefineHttpCategory(primaryEvidence, classified))
		) {
			return {
				...classified,
				...primary,
				category: classified.category,
				httpStatus: primary.httpStatus ?? classified.httpStatus,
				code: primary.code ?? classified.code,
				detail: primary.detail ?? classified.detail,
			};
		}
	}
	return primary;
};
