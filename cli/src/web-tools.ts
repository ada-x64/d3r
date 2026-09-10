import {
	type RuntimeClientServices,
	type RuntimeTool,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import {
	EXA_PROVIDER_ID,
	WebFetchParams,
	WebSearchParams,
	type WebProviderConfig,
	type WebSearchProvider,
} from "@d3r/tools";
import { z } from "zod";
import {
	createNativeExaProvider,
	isSafeWebUrl,
	WEB_LIMITS,
} from "./web-exa.ts";

/** The shell parses environment once; credentials never enter tool arguments. */
export interface CreateWebToolsOptions {
	readonly config: WebProviderConfig;
	readonly client?: RuntimeClientServices;
	/** Trusted seam: implementations must honor the supplied cancellation signal. */
	readonly provider?: WebSearchProvider;
}

/** Accept only header-safe credentials and the explicitly supported provider. */
const providerConfig = z.object({
	providerId: z.literal(EXA_PROVIDER_ID),
	exaApiKey: z
		.string()
		.trim()
		.min(1)
		.max(WEB_LIMITS.apiKeyChars)
		.regex(/^[!-~]+$/),
});

/** Preserve the shared result-count defaults and bounds while limiting request size. */
const searchSchema = WebSearchParams.extend({
	query: WebSearchParams.shape.query.max(WEB_LIMITS.queryChars),
}).strict();

/** Refinements run before permission in the tool bridge; failures never echo URLs. */
const fetchSchema = WebFetchParams.extend({
	urls: WebFetchParams.shape.urls.refine(
		(urls) => urls.every(isSafeWebUrl),
		"Use absolute HTTP(S) URLs without credentials or userinfo.",
	),
}).strict();

/** Errors deliberately exclude provider payloads, configuration values and thrown messages. */
const errorResult = (text: string): RuntimeToolResult => ({
	text,
	isError: true,
});

/** Redact individual strings before JSON escaping, then cap all model-visible output. */
const outputResult = (
	value: unknown,
	secrets: readonly string[],
): RuntimeToolResult => {
	const text = JSON.stringify(value, (_name, item: unknown) =>
		typeof item === "string"
			? secrets.reduce(
					(out, secret) => out.replaceAll(secret, "[REDACTED]"),
					item,
				)
			: item,
	);
	const bytes = Buffer.from(text);
	const suffix = "\n[Output truncated]";
	if (bytes.length <= WEB_LIMITS.outputBytes) {
		return { text };
	}
	const end = WEB_LIMITS.outputBytes - Buffer.byteLength(suffix);
	// Ignore an incomplete final UTF-8 character instead of adding replacement bytes.
	const clipped = new TextDecoder().decode(bytes.subarray(0, end), {
		stream: true,
	});
	return { text: clipped + suffix };
};

/** Cancellation aborts the actual native HTTP exchange, not just the waiting tool. */
const runWeb = async (
	operation: (signal: AbortSignal) => Promise<unknown>,
	signal: AbortSignal,
	secrets: readonly string[],
): Promise<RuntimeToolResult> => {
	if (signal.aborted) {
		return errorResult("Web request cancelled.");
	}
	const deadline = new AbortController();
	const active = AbortSignal.any([signal, deadline.signal]);
	const timer = setTimeout(() => deadline.abort(), WEB_LIMITS.timeoutMs);
	let onAbort: (() => void) | null = null;
	try {
		const cancelled = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new Error("Web request cancelled"));
			active.addEventListener("abort", onAbort, { once: true });
		});
		const value = await Promise.race([operation(active), cancelled]);
		active.throwIfAborted();
		return outputResult(value, secrets);
	} catch {
		if (signal.aborted) {
			return errorResult("Web request cancelled.");
		}
		if (deadline.signal.aborted) {
			return errorResult("Exa web request timed out.");
		}
		return errorResult(
			"Exa web request failed or returned an invalid or oversized response. Check the web provider configuration or try a smaller request.",
		);
	} finally {
		clearTimeout(timer);
		if (onAbort) {
			active.removeEventListener("abort", onAbort);
		}
	}
};

/**
 * Both names remain discoverable when unavailable, without network or approval.
 * The runtime bridge owns approval and optional thread grants; execute is called
 * only after that gate. No model argument can change the service or grant scope.
 * Pass the session client here to register credentials before any persistence.
 */
export const createWebTools = ({
	config,
	client,
	provider,
}: CreateWebToolsOptions): RuntimeTool[] => {
	const parsed = providerConfig.safeParse(config);
	const rawKey = typeof config?.exaApiKey === "string" ? config.exaApiKey : "";
	const secrets = [
		...new Set([
			rawKey,
			rawKey.trim(),
			...(parsed.success ? [encodeURIComponent(parsed.data.exaApiKey)] : []),
		]),
	]
		.filter(Boolean)
		.toSorted((a, b) => b.length - a.length);
	let unavailable: string | null = null;
	if (!parsed.success) {
		unavailable =
			config?.providerId === EXA_PROVIDER_ID && !rawKey.trim()
				? "Web tools unavailable: configure EXA_API_KEY in the D3R host environment. Do not put credentials in tool arguments."
				: "Web tools unavailable: invalid web provider configuration. Set D3R_WEB_SEARCH_PROVIDER to exa and configure EXA_API_KEY in the D3R host environment.";
	}
	try {
		if (secrets.length) {
			client?.registerSecrets?.(secrets);
		}
	} catch {
		unavailable =
			"Web tools unavailable: credential redaction could not be configured safely.";
	}
	const web =
		parsed.success && !unavailable
			? (provider ?? createNativeExaProvider(parsed.data.exaApiKey))
			: undefined;
	return [
		{
			name: "web_search",
			description:
				"Search the web via Exa for titled hits and highlight snippets. Sends the visible query to Exa after approval; output and request duration are bounded. Uses host-configured credentials, never tool arguments.",
			kind: "search",
			schema: searchSchema,
			permission: web ? "ask" : "none",
			permissionScope: { id: "exa:web_search", label: "web searches via Exa" },
			execute: async (args, context) => {
				if (!web) {
					return errorResult(unavailable!);
				}
				const input = searchSchema.safeParse(args);
				if (!input.success) {
					return errorResult(
						"Invalid web_search arguments. Supply a bounded query and k from 1 to 20.",
					);
				}
				return runWeb(
					async (signal) => {
						const result = await web.search(input.data, signal);
						if (
							result.hits.length > input.data.k ||
							result.hits.some((hit) => !isSafeWebUrl(hit.url))
						) {
							throw new Error("Invalid web search results");
						}
						return result;
					},
					context.signal,
					secrets,
				);
			},
		},
		{
			name: "web_fetch",
			description:
				"Retrieve bounded extracted page text through Exa, not by connecting directly to the supplied URLs. Sends the visible HTTP(S) URLs to Exa after approval. URLs must not contain credentials or userinfo; output and request duration are bounded.",
			kind: "fetch",
			schema: fetchSchema,
			permission: web ? "ask" : "none",
			permissionScope: { id: "exa:web_fetch", label: "web fetches via Exa" },
			execute: async (args, context) => {
				if (!web) {
					return errorResult(unavailable!);
				}
				const input = fetchSchema.safeParse(args);
				if (!input.success) {
					return errorResult(
						"Invalid web_fetch arguments. Supply 1 to 20 absolute HTTP(S) URLs without credentials or userinfo.",
					);
				}
				return runWeb(
					async (signal) => {
						const result = await web.fetch(input.data, signal);
						if (
							result.docs.length > input.data.urls.length ||
							result.docs.some((doc) => !isSafeWebUrl(doc.url))
						) {
							throw new Error("Invalid web fetch results");
						}
						return result;
					},
					context.signal,
					secrets,
				);
			},
		},
	];
};
