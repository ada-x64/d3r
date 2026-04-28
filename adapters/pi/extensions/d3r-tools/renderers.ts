// Default pi-tui renderers for tools registered by the d3r-tools
// factory. Each tool may override these via the optional `render`
// field on its registry entry; everything else gets the generic
// call/result views shipped here.
//
// Both factories close over the tool name so the call view can label
// itself without the registerTool caller threading the name through
// every invocation.

// oxlint-disable new-cap -- TypeBox / pi-tui factories use PascalCase by design.

import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text } from "@mariozechner/pi-tui";

const ARG_PREVIEW_LIMIT = 80;
const STRING_PREVIEW_LIMIT = 60;
const JSON_INDENT = 2;

interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface ResultLike {
	content?: { type: string; text?: string }[];
	details?: unknown;
}

interface RenderResultOpts {
	expanded?: boolean;
}

const truncate = (value: string, limit: number): string =>
	value.length > limit ? `${value.slice(0, limit - 1)}\u2026` : value;

const previewArgs = (args: Record<string, unknown>): string => {
	const trimmed: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(args)) {
		trimmed[key] =
			typeof raw === "string" ? truncate(raw, STRING_PREVIEW_LIMIT) : raw;
	}
	return truncate(JSON.stringify(trimmed), ARG_PREVIEW_LIMIT);
};

const firstText = (result: ResultLike): string => {
	if (!result.content) {
		return "";
	}
	for (const part of result.content) {
		if (part.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
};

export const defaultRenderCall =
	(name: string) =>
	(
		args: Record<string, unknown>,
		theme: ThemeLike,
		_context: unknown,
	): Text => {
		const title = theme.fg("toolTitle", theme.bold(name));
		const summary = theme.fg("accent", ` ${previewArgs(args ?? {})}`);
		return new Text(title + summary, 0, 0);
	};

interface RenderResultArgs {
	result: ResultLike;
	opts: RenderResultOpts;
	theme: ThemeLike;
	context: unknown;
}

const renderResultBody = (
	name: string,
	{ result, opts, theme }: RenderResultArgs,
): Text | Container => {
	const expanded = opts?.expanded === true;
	if (!expanded) {
		const text = firstText(result);
		return new Text(
			text === "" ? theme.fg("muted", "(no output)") : text,
			0,
			0,
		);
	}
	const container = new Container();
	const header = theme.fg("toolTitle", theme.bold(name));
	container.addChild(new Text(header, 0, 0));
	const body = JSON.stringify(result.details ?? null, null, JSON_INDENT);
	container.addChild(
		new Markdown(`\`\`\`json\n${body}\n\`\`\``, 0, 0, getMarkdownTheme()),
	);
	return container;
};

// pi calls renderResult with positional args; this adapter forwards
// them as a single bag so the body fits the project's max-params budget.
const applyRenderResult = (
	name: string,
	result: ResultLike,
	posArgs: [RenderResultOpts, ThemeLike, unknown],
): Text | Container => {
	const [opts, theme, context] = posArgs;
	return renderResultBody(name, { result, opts, theme, context });
};

// pi's renderResult ABI is positional, hence the four-arg arrow.
// oxlint-disable max-params
export const defaultRenderResult =
	(name: string) =>
	(
		result: ResultLike,
		opts: RenderResultOpts,
		theme: ThemeLike,
		context: unknown,
	): Text | Container =>
		applyRenderResult(name, result, [opts, theme, context]);
// oxlint-enable max-params
