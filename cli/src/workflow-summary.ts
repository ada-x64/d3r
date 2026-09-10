import { type ExecutionRecord } from "@d3r/core/engine";
import { type RuntimeContent } from "@d3r/core/runtime";
import { z } from "zod";

/** Detached completed evidence only; the composition root owns the tool-free request. */
export interface WorkflowSummaryInput {
	readonly command: string;
	readonly description: string;
	readonly input: readonly RuntimeContent[];
	readonly history: readonly RuntimeContent[];
	readonly records: readonly ExecutionRecord[];
}

/** Bound the single human-facing message independently of internal report sizes. */
const MAX_SUMMARY_LENGTH = 8192;

/** JSON values are data reports, not a human-facing synthesis. */
const isJson = (text: string): boolean => {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
};

/** Markdown fences require at least three identical marker characters. */
const MIN_FENCE_LENGTH = 3;

/** Only matching markers of sufficient length can close an active code fence. */
interface Fence {
	readonly marker: string;
	readonly length: number;
	readonly info: string;
}

/** Strip quote/list containers once so their fences and report lines remain visible. */
const contentLine = (line: string): { text: string; quotes: number } => {
	let index = 0;
	let quotes = 0;
	while (index < line.length) {
		const char = line[index];
		if (char === ">") {
			quotes++;
			index++;
		} else if (char === " " || char === "\t") {
			index++;
		} else if (
			["-", "*", "+"].includes(char) &&
			[" ", "\t"].includes(line[index + 1])
		) {
			index++;
		} else {
			break;
		}
	}
	return { text: line.slice(index).trimEnd(), quotes };
};

/** Remove only the fence's quote containers; operators and list-like code are body content. */
const codeLine = (line: string, quotes: number): string => {
	let index = 0;
	for (let quote = 0; quote < quotes; quote++) {
		while (line[index] === " " || line[index] === "\t") {
			index++;
		}
		if (line[index] !== ">") {
			break;
		}
		index++;
	}
	return line.slice(index);
};

/** Count a fence run directly; no regex may backtrack across marker runs or code bodies. */
const readFence = (line: string): Fence | null => {
	const [marker] = line;
	if (marker !== "`" && marker !== "~") {
		return null;
	}
	let length = 1;
	while (line[length] === marker) {
		length++;
	}
	return length < MIN_FENCE_LENGTH
		? null
		: { marker, length, info: line.slice(length).trim() };
};

/** Match only the info label, not a fence run or the potentially unmatched body. */
const jsonFence = (info: string): boolean =>
	/^(?:json\w*|ndjson|application\/json)\b/i.test(info);

/** Every report array contains an object; square brackets alone may be links or notation. */
const containsJsonObject = (text: string): boolean => {
	const starts: number[] = [];
	let quoted = false;
	let escaped = false;
	let budget = text.length;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				quoted = false;
			}
		} else if (char === '"' && starts.length) {
			quoted = true;
		} else if (char === "{") {
			starts.push(index);
		} else if (char === "}" && starts.length) {
			const start = starts.pop()!;
			const length = index - start + 1;
			// Nested malformed candidates must not cause quadratic parsing; fail closed at the budget.
			if (length > budget) {
				return true;
			}
			budget -= length;
			if (isJson(text.slice(start, index + 1))) {
				return true;
			}
		}
	}
	return false;
};

/** Each line belongs to prose or one fenced body, and each block is inspected only once. */
const containsReports = (text: string): boolean => {
	const prose: string[] = [];
	let fence: (Fence & { body: string[]; quotes: number }) | null = null;
	for (const rawLine of text.split("\n")) {
		const line = contentLine(rawLine);
		const bodyLine = fence ? codeLine(rawLine, fence.quotes) : line.text;
		const edge = readFence(bodyLine.trim());
		if (fence) {
			if (
				edge?.marker === fence.marker &&
				edge.length >= fence.length &&
				!edge.info
			) {
				if (isJson(fence.body.join("\n"))) {
					return true;
				}
				fence = null;
			} else {
				fence.body.push(bodyLine);
			}
		} else if (edge) {
			if (jsonFence(edge.info) || containsJsonObject(prose.join("\n"))) {
				return true;
			}
			prose.length = 0;
			fence = { ...edge, body: [], quotes: line.quotes };
		} else {
			// Preserve rejection of truncated raw reports, but never apply this heuristic inside code.
			if (line.text.startsWith("{")) {
				return true;
			}
			prose.push(line.text);
		}
	}
	return fence
		? isJson(fence.body.join("\n"))
		: containsJsonObject(prose.join("\n"));
};

/** Length is checked before trimming, parsing, or scanning, independent of Zod refinement order. */
const isSummary = (value: string): boolean => {
	if (value.length > MAX_SUMMARY_LENGTH) {
		return false;
	}
	const text = value.trim();
	return Boolean(text) && !isJson(text) && !containsReports(text);
};

/** Apply the same prose boundary to callback results and persisted summaries. */
export const WorkflowSummary = z
	.string()
	.refine(isSummary, "Expected a concise Markdown synthesis, not JSON reports")
	.transform((text) => text.trim());

/** Known phase handoffs are suggestions, never automatic workflow execution. */
const NEXT_PHASE: Readonly<Record<string, string>> = {
	design: "delegate",
	delegate: "develop",
	develop: "summarize",
};

/** Report completion without inventing a synthesis or exposing individual role reports. */
export const fallbackWorkflowSummary = (
	command: string,
	commands: readonly string[],
): string => {
	const next = Object.hasOwn(NEXT_PHASE, command)
		? NEXT_PHASE[command]
		: undefined;
	return [
		`**Workflow /${command} completed.**`,
		"Summary unavailable; the completed workflow results have been retained.",
		next && commands.includes(next)
			? `**Next:** Review the results, then use \`/${next}\` when ready.`
			: "**Next:** Review the results in routing and choose the next task.",
	].join("\n\n");
};
