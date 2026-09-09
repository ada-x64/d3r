import { type ToolCall } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { redactSessionData } from "./store.ts";

/** Display copies accept JSON data, never arbitrary runtime objects. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Parse the untyped tool boundary before interpreting any fields. */
const jsonSchema: z.ZodType<Json> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(jsonSchema),
		z.record(jsonSchema),
	]),
);
/** This is an ACP view of D3R run_command, not a generic executable-shaped tool. */
const commandSchema = z
	.object({
		command: z
			.string()
			.min(1)
			.refine((value) => !value.includes("\0")),
		args: z
			.array(z.string().refine((value) => !value.includes("\0")))
			.default([]),
		cwd: z
			.string()
			.min(1)
			.refine((value) => !value.includes("\0"))
			.optional(),
		timeoutMs: z.number().int().positive().optional(),
	})
	.strict();
/** Titles are compact; the approval content is deliberately not truncated. */
const TITLE_LIMIT = 100;
/** JSON formatting uses a small, readable indent for generic permissions. */
const JSON_INDENT = 2;
/** Match credential suffixes without hiding settings such as TOKEN_LIMIT or PASSWORD_FILE. */
const credentialField = (name: string): boolean =>
	/(?:^|_)(?:authorization|cookie|password|passwd|secret|token|credentials?|signature|sig|apikey|key|auth)$/i.test(
		name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_"),
	);
/** Upstream MCP masks remain visible rather than disappearing with their field names. */
const mask = (value: Json): string =>
	value === "[REDACTED]" ? value : "[redacted]";
/** Preserve input shape, including environment plans; persistence redaction would remove them. */
const maskInput = (value: Json, secrets: readonly string[]): Json => {
	if (typeof value === "string") {
		return redactSessionData(value, secrets);
	}
	if (Array.isArray(value)) {
		return value.map((item) => maskInput(item, secrets));
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const namedCredential =
		typeof value.name === "string" && credentialField(value.name);
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			redactSessionData(key, secrets),
			credentialField(key) || (key === "value" && namedCredential)
				? mask(item)
				: maskInput(item, secrets),
		]),
	);
};
/** Unicode escapes distinguish UTF-16 units from full code points. */
const UNICODE_ESCAPE = { radix: 16, width: 4, codePointWidth: 8 };
/** Control and formatting characters must not rewrite or visually reorder an approval. */
const escapeControls = (text: string): string =>
	text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) =>
		// UTF-16 units, not spread code points: JSON requires surrogate-pair escapes.
		// oxlint-disable-next-line prefer-spread
		character
			.split("")
			.map(
				(unit) =>
					`\\u${unit.charCodeAt(0).toString(UNICODE_ESCAPE.radix).padStart(UNICODE_ESCAPE.width, "0")}`,
			)
			.join(""),
	);
/** JSON quoting distinguishes empty arguments, spaces, newlines and literal shell syntax. */
const quote = (value: Json, indent?: number): string =>
	JSON.stringify(value, null, indent)
		.split("\n")
		.map(escapeControls)
		.join("\n");
/** Bash-style notation is presentation only; execution still receives literal argv. */
const shellWord = (value: string): string => {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
		return value;
	}
	if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) {
		const escaped = [...value]
			.map((character) => {
				if (character === "\\") {
					return String.raw`\\`;
				}
				if (character === "'") {
					return String.raw`\'`;
				}
				if (character === "\n") {
					return String.raw`\n`;
				}
				if (character === "\r") {
					return String.raw`\r`;
				}
				if (character === "\t") {
					return String.raw`\t`;
				}
				if (!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(character)) {
					return character;
				}
				const code = character.codePointAt(0)!;
				const hex = code.toString(UNICODE_ESCAPE.radix);
				return hex.length <= UNICODE_ESCAPE.width
					? `\\u${hex.padStart(UNICODE_ESCAPE.width, "0")}`
					: `\\U${hex.padStart(UNICODE_ESCAPE.codePointWidth, "0")}`;
			})
			.join("");
		return `$'${escaped}'`;
	}
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
};
/** A longer fence keeps embedded Markdown, links and fence terminators inert. */
const codeBlock = (text: string): string => {
	const fence = "`".repeat(
		[...text.matchAll(/`+/g)].reduce(
			(length, [run]) => Math.max(length, run.length + 1),
			"```".length,
		),
	);
	return `${fence}text\n${text}\n${fence}`;
};
/** Only the title may elide text, and only after masking and control escaping. */
const compactTitle = (text: string): string => {
	const escaped = escapeControls(text);
	return escaped.length > TITLE_LIMIT
		? `${escaped.slice(0, TITLE_LIMIT - "...".length)}...`
		: escaped;
};
/** Keep literal keys such as __proto__; Zod's reconstructed objects omit those keys. */
const inputSchema = z.custom<Json>(
	(value) => jsonSchema.safeParse(value).success,
);
/** Non-JSON or recursive input cannot yield a reliable approval preview. */
const parseInput = (input: unknown): Json | undefined => {
	try {
		const result = inputSchema.safeParse(input);
		return result.success ? result.data : undefined;
	} catch {
		return undefined;
	}
};
/** Only normalized permission input is authoritative; the ACP session path may be a symlink. */
const commandCwd = (
	cwd: string | undefined,
	permission: boolean,
	secrets: readonly string[],
): string | undefined => {
	if (cwd === undefined) {
		return undefined;
	}
	const label = permission && isAbsolute(cwd) ? "cwd" : "requested cwd";
	return `# ${label}: ${shellWord(redactSessionData(cwd, secrets))}`;
};
/** Render a detached, display-only ACP card; no execution or permission policy lives here. */
export const toolCallPresentation = (
	{ title, kind, input }: { title: string; kind: string; input: unknown },
	{
		permission = false,
		secrets = [],
	}: { permission?: boolean; secrets?: readonly string[] } = {},
): Pick<ToolCall, "title" | "content" | "rawInput"> => {
	const orderedSecrets = secrets.toSorted((a, b) => b.length - a.length);
	const parsed = parseInput(input);
	const rawInput =
		parsed === undefined ? undefined : maskInput(parsed, orderedSecrets);
	const command =
		title === "run_command" && kind === "execute"
			? commandSchema.safeParse(parsed)
			: undefined;
	const safeTitle = redactSessionData(title, orderedSecrets);
	let displayTitle = safeTitle;
	let text =
		parsed === undefined
			? "Input cannot be represented as JSON. Do not approve without reviewing the request."
			: `Input (JSON; credential values may be redacted):\n${codeBlock(quote(rawInput!, JSON_INDENT))}`;
	if (command?.success) {
		const value = command.data;
		displayTitle = [value.command, ...value.args]
			.map((word) => shellWord(redactSessionData(word, orderedSecrets)))
			.join(" ");
		const cwd = commandCwd(value.cwd, permission, orderedSecrets);
		text = codeBlock(
			[displayTitle, ...(cwd === undefined ? [] : [cwd])].join("\n"),
		);
	}
	return {
		title: compactTitle(displayTitle),
		content: [{ type: "content", content: { type: "text", text } }],
		...(rawInput === undefined ? {} : { rawInput }),
	};
};
