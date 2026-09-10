/* oxlint-disable no-magic-numbers -- Lengths describe the public summary boundary. */
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
	fallbackWorkflowSummary,
	WorkflowSummary,
} from "./workflow-summary.ts";

/** A concise synthesis can use ordinary Markdown without a prescribed template. */
const markdown =
	"## Completed\n\nChose a bounded queue to avoid races.\n\n**Next:** Run `/develop`.";

describe("workflow summary text boundary", () => {
	it.each([
		markdown,
		"Finished the design. Next: review the tradeoffs.",
		"- [x] Design completed\n- [ ] Review the results",
		"See [the design](design.md) for the rationale.",
		"Updated the guard:\n```ts\nif (done) return;\n```\nNext: verify.",
		"x".repeat(8192),
	])("accepts bounded prose (case %#)", (value) => {
		expect(WorkflowSummary.parse(value)).toBe(value);
	});
	it("trims surrounding whitespace", () => {
		expect(WorkflowSummary.parse(` \n${markdown}\n `)).toBe(markdown);
	});
	it.each([
		undefined,
		null,
		42,
		{},
		"",
		" \n\t ",
		"x".repeat(8193),
		`${" ".repeat(8192)}x`,
		'{"status":"completed","summary":"done"}',
		'[{"role":"planner","outcome":{"summary":"done"}}]',
		'"A JSON string is not Markdown"',
		"null",
		"true",
		"42",
		"{}\n{}",
		"{truncated report",
		'Workflow outcomes:\n[{"summary":"done"}]',
		'Completed.\n```json\n{"summary":"done"}\n```',
		'Completed.\n~~~JSON\n{"summary":"done"}\n~~~',
		"```jsonc\n// report\n{}\n```",
		'```\n{"summary":"done"}\n```',
		"```\ntrue\n```",
		'> {"summary":"done"}',
		'- {"summary":"done"}',
	])("rejects missing, oversized, or JSON report output (case %#)", (value) => {
		expect(WorkflowSummary.safeParse(value).success).toBe(false);
	});
});

describe("workflow summary bounded scanning", () => {
	it("finishes maximum-length marker runs and unmatched mixed fences promptly", () => {
		const inputs = [
			"`".repeat(8192),
			`\`\`\`\`c\n~~~\nif (done)\n{\n return;\n}\n\`\`\`\n${"`~\n".repeat(2800)}`.slice(
				0,
				8192,
			),
		];
		const start = performance.now();
		for (const input of inputs) {
			expect(WorkflowSummary.safeParse(input).success).toBe(true);
		}
		expect(performance.now() - start).toBeLessThan(1000);
	});
	it("rejects oversized input before parsing or scanning it", () => {
		const parse = vi.spyOn(JSON, "parse");
		try {
			expect(WorkflowSummary.safeParse("`".repeat(100_000)).success).toBe(
				false,
			);
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});
	it("bounds the total parsing effort for nested malformed object candidates", () => {
		const input = `Notation: ${"{x".repeat(512)}${"}".repeat(512)}`;
		const parse = vi.spyOn(JSON, "parse");
		try {
			expect(WorkflowSummary.safeParse(input).success).toBe(false);
			const parsedCharacters = parse.mock.calls.reduce(
				(sum, [candidate]) => sum + candidate.length,
				0,
			);
			expect(parsedCharacters).toBeLessThanOrEqual(input.length * 2);
		} finally {
			parse.mockRestore();
		}
	});
	it.each([
		'Completed: [{"role":"planner","outcome":{"summary":"done"}}]',
		'Completed: {"summary":"done; literal } and [ characters"}. Next: review.',
	])("rejects embedded JSON reports after prose (case %#)", (input) => {
		expect(WorkflowSummary.safeParse(input).success).toBe(false);
	});
	it("preserves fenced C code with line-leading braces and JSON fragments", () => {
		const input = [
			"Updated the completion guard:",
			"```c",
			"if(done)",
			"{",
			" return;",
			"}",
			'// Sample payload: {"summary":"done"}',
			"```",
			"Next: verify the guard.",
		].join("\n");
		expect(WorkflowSummary.parse(input)).toBe(input);
	});
	it("preserves code operators rather than stripping them as Markdown list prefixes", () => {
		const input = "Kept the unary expression:\n```c\n- 42\n```\nNext: verify.";
		expect(WorkflowSummary.parse(input)).toBe(input);
	});
	it("checks whole non-JSON-labeled bodies, including quote containers and unclosed fences", () => {
		expect(
			WorkflowSummary.safeParse('Completed:\n```text\n{"summary":"done"}\n```')
				.success,
		).toBe(false);
		expect(
			WorkflowSummary.safeParse('> ~~~text\n> {"summary":"done"}').success,
		).toBe(false);
	});
	it("requires matching fence markers and sufficient closing length", () => {
		const input = [
			"Updated the example:",
			"````c",
			"~~~",
			"```",
			"```json",
			'if (done) { return; } // {"summary":"example, not a report"}',
			"````",
			"Next: verify.",
		].join("\n");
		expect(WorkflowSummary.parse(input)).toBe(input);
		expect(
			WorkflowSummary.safeParse(
				`${input}\nCompleted: {"summary":"report after code"}`,
			).success,
		).toBe(false);
	});
	it("preserves Markdown links, wikilinks, citations, and numeric notation", () => {
		const input = [
			"See [the design](design.md), [[Workflow notes]], and [label][reference].",
			"Sources [1] and [2, 3] support the decision.",
			"Keep the interval [0, 1], matrix [[1, 2], [3, 4]], x[0], and set {1, 2}.",
			"Next: check the documented bounds.",
		].join("\n");
		expect(WorkflowSummary.parse(input)).toBe(input);
	});
});

describe("workflow summary fallback", () => {
	it.each([
		["design", "delegate"],
		["delegate", "develop"],
		["develop", "summarize"],
	])("suggests the next available phase after %s", (command, next) => {
		const result = fallbackWorkflowSummary(command, [next]);
		expect(result).toContain(`Workflow /${command} completed`);
		expect(result).toContain("Summary unavailable");
		expect(result).toContain(`\`/${next}\``);
		expect(WorkflowSummary.parse(result)).toBe(result);
		expect(result).not.toContain("Workflow outcomes");
	});
	it.each(["summarize", "custom", "design", "constructor"])(
		"returns to routing rather than inventing an unavailable phase after %s",
		(command) => {
			const result = fallbackWorkflowSummary(command, [command]);
			expect(result).toContain("**Next:** Review the results in routing");
			expect(result).not.toContain("then use");
		},
	);
});
