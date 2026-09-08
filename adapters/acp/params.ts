import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { z } from "zod";

/** Unsupported collections must be empty, not normalized to empty by the SDK. */
const NewSessionParams = z.object({
	cwd: z.string().refine(isAbsolute, "Session cwd must be absolute"),
	mcpServers: z.array(z.never()),
	additionalDirectories: z.array(z.never()).nullish(),
});

/** Accept the current runtime's content subset without dropping malformed blocks. */
const PromptParams = z.object({
	sessionId: z.string(),
	prompt: z.array(
		z.discriminatedUnion("type", [
			z.object({ type: z.literal("text"), text: z.string() }),
			z.object({
				type: z.literal("resource_link"),
				uri: z.string(),
				name: z.string(),
				description: z
					.string()
					.nullish()
					.transform((value) => value ?? undefined),
				mimeType: z
					.string()
					.nullish()
					.transform((value) => value ?? undefined),
			}),
		]),
	),
});

/** Typed prompt input after parsing the raw protocol payload. */
export type PromptParams = z.infer<typeof PromptParams>;

/** Refuse unsupported or malformed setup rather than silently changing its meaning. */
export const parseNewSession = (
	raw: unknown,
): z.infer<typeof NewSessionParams> => {
	const result = NewSessionParams.safeParse(raw);
	if (!result.success) {
		throw RequestError.invalidParams(
			undefined,
			"Expected an absolute cwd and empty MCP/additional-root lists",
		);
	}
	return result.data;
};

/** Error messages intentionally omit payloads that may contain sensitive context. */
export const parsePrompt = (raw: unknown): PromptParams => {
	const result = PromptParams.safeParse(raw);
	if (!result.success) {
		throw RequestError.invalidParams(
			undefined,
			"Expected a session ID and text or resource-link prompt blocks",
		);
	}
	return result.data;
};
