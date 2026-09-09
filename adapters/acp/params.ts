import { RequestError } from "@agentclientprotocol/sdk";
import { type RuntimeContent } from "@d3r/core/runtime";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

/** Paths are local to the runtime host, never relative to server startup. */
const absolutePath = z
	.string()
	.refine((path) => !path.includes("\0") && isAbsolute(path))
	.transform(normalize);
/** ACP metadata is opaque, but its container must be well formed. */
const meta = z.record(z.unknown()).nullish();
/** Bound opaque identifiers independently of the store filename policy. */
const MAX_SESSION_ID_LENGTH = 256;
/** Opaque cursors must remain small enough for a single request. */
const MAX_CURSOR_LENGTH = 4096;
/** IDs are opaque at the protocol boundary; the store applies its own filename policy. */
const sessionId = z.string().min(1).max(MAX_SESSION_ID_LENGTH);
/** Optional presentation annotations do not change model content. */
const annotations = z
	.object({
		audience: z.array(z.enum(["user", "assistant"])).nullish(),
		lastModified: z.string().nullish(),
		priority: z.number().min(0).max(1).nullish(),
		_meta: meta,
	})
	.nullish();
/** Preserve encoded bytes rather than accepting malformed media. */
const base64 = z
	.string()
	.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** Shared content annotations are retained for history replay. */
const presentation = { annotations, _meta: meta };
/** Parse every supported block before the SDK can drop invalid array members. */
export const contentBlock = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string(), ...presentation }),
	z.object({
		type: z.literal("image"),
		data: base64,
		mimeType: z.string().regex(/^image\//),
		uri: z.string().nullish(),
		...presentation,
	}),
	z.object({
		type: z.literal("resource_link"),
		uri: z.string().min(1),
		name: z.string(),
		description: z.string().nullish(),
		mimeType: z.string().nullish(),
		title: z.string().nullish(),
		size: z.number().int().nonnegative().nullish(),
		...presentation,
	}),
	z.object({
		type: z.literal("resource"),
		resource: z.union([
			z.object({
				uri: z.string().min(1),
				text: z.string(),
				blob: z.never().optional(),
				mimeType: z.string().nullish(),
				_meta: meta,
			}),
			z.object({
				uri: z.string().min(1),
				blob: base64,
				text: z.never().optional(),
				mimeType: z.string().nullish(),
				_meta: meta,
			}),
		]),
		...presentation,
	}),
]);
/** MCP connection parameters are transient and passed intact to the runtime factory. */
const mcpServer = z.union([
	z.object({
		type: z.never().optional(),
		name: z.string().min(1),
		command: absolutePath,
		args: z.array(z.string()),
		env: z.array(z.object({ name: z.string().min(1), value: z.string() })),
	}),
	z.object({
		type: z.enum(["http", "sse"]),
		name: z.string().min(1),
		url: z
			.string()
			.url()
			.refine((url) => ["http:", "https:"].includes(new URL(url).protocol)),
		headers: z.array(z.object({ name: z.string().min(1), value: z.string() })),
	}),
]);
/** Workspace roots are replaced, not inherited, when a session is reopened. */
const setup = z.object({
	cwd: absolutePath,
	additionalDirectories: z.array(absolutePath).optional().default([]),
	mcpServers: z.array(mcpServer),
	_meta: meta,
});
/** Parse failures must never echo credentials or prompt contents. */
const parser =
	<T extends z.ZodTypeAny>(schema: T) =>
	(raw: unknown): z.infer<T> => {
		const result = schema.safeParse(raw);
		if (!result.success) {
			throw RequestError.invalidParams(
				undefined,
				"Malformed or unsupported parameters",
			);
		}
		return result.data;
	};
/** New sessions require an explicit MCP list. */
export const parseNewSession = parser(setup);
/** Loading replays the complete stored conversation. */
export const parseLoadSession = parser(setup.extend({ sessionId }));
/** Resume permits omission of the MCP list, as defined by ACP v1. */
export const parseResumeSession = parser(
	setup.extend({
		sessionId,
		mcpServers: z.array(mcpServer).optional().default([]),
	}),
);
/** Session-scoped lifecycle requests share one strict identifier boundary. */
export const parseSessionId = parser(z.object({ sessionId, _meta: meta }));
/** Pagination cursors are interpreted by the store, never as paths. */
export const parseListSessions = parser(
	z.object({
		cwd: absolutePath.nullish(),
		cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).nullish(),
		_meta: meta,
	}),
);
/** Select values are strings; unknown discriminators cannot normalize to a select. */
export const parseConfig = parser(
	z.object({
		sessionId,
		configId: z.string().min(1),
		value: z.string(),
		type: z.never().optional(),
		_meta: meta,
	}),
);
/** Terminal authentication is performed by a separate client-launched process. */
export const parseAuthenticate = parser(
	z.object({ methodId: z.string().min(1), _meta: meta }),
);
/** Empty method requests may carry protocol metadata only. */
export const parseEmpty = parser(z.object({ _meta: meta }));
/** Validate the capabilities used for security-sensitive client requests. */
export const parseInitialize = parser(
	z.object({
		protocolVersion: z.number().int().nonnegative(),
		clientInfo: z
			.object({
				name: z.string(),
				version: z.string(),
				title: z.string().nullish(),
				_meta: meta,
			})
			.nullish(),
		clientCapabilities: z
			.object({
				fs: z
					.object({
						readTextFile: z.boolean().optional(),
						writeTextFile: z.boolean().optional(),
						_meta: meta,
					})
					.optional(),
				terminal: z.boolean().optional(),
				auth: z
					.object({ terminal: z.boolean().optional(), _meta: meta })
					.optional(),
				elicitation: z
					.object({
						form: z.object({ _meta: meta }).nullish(),
						url: z.object({ _meta: meta }).nullish(),
						_meta: meta,
					})
					.nullish(),
				_meta: meta,
			})
			.optional(),
		_meta: meta,
	}),
);
/** Keep original blocks for replay and derive runtime input separately. */
export const parsePrompt = parser(
	z.object({ sessionId, prompt: z.array(contentBlock).min(1), _meta: meta }),
);
/** Typed input after parsing the raw protocol payload. */
export type PromptParams = ReturnType<typeof parsePrompt>;
/** Parsed session setup contains no defaulted-away malformed values. */
export type SessionParams = ReturnType<typeof parseNewSession>;
/** Embedded context is untrusted user text, not an instruction or resource fetch. */
export const runtimeContent = (
	block: PromptParams["prompt"][number],
): RuntimeContent => {
	switch (block.type) {
		case "text": {
			return { type: "text", text: block.text };
		}
		case "image": {
			return { type: "image", data: block.data, mimeType: block.mimeType };
		}
		case "resource_link": {
			return {
				type: "resource_link",
				uri: block.uri,
				name: block.name,
				description: block.description ?? undefined,
				mimeType: block.mimeType ?? undefined,
			};
		}
		case "resource": {
			return {
				type: "text",
				text: JSON.stringify({
					uri: block.resource.uri,
					mimeType: block.resource.mimeType ?? undefined,
					...(block.resource.text !== undefined
						? { text: block.resource.text }
						: { encoding: "base64", blob: block.resource.blob }),
				}),
			};
		}
	}
};
