// Smoke tests for the core zod schemas. The intent is to pin the
// shape contract this package authors (which fields are required,
// which defaults apply, how the recursive ChainStep union composes)
// rather than to re-prove that zod parses objects.

import { describe, expect, it } from "vitest";

import { AgentSpec, ChainStep, Workflow } from "./schema.ts";

const REVIEWS = 2;

describe("Workflow", () => {
	it("accepts a minimal valid workflow and round-trips", () => {
		const input = {
			commands: {},
			vault: { dirs: [], template_kinds: [] },
		};
		const parsed = Workflow.parse(input);
		expect(parsed).toEqual(input);
	});

	it("accepts a workflow with a command chain", () => {
		const input = {
			commands: {
				ship: {
					description: "ship a thing",
					chain: [{ kind: "agent", name: "implementor" }],
					reviews_default: REVIEWS,
				},
			},
			vault: { dirs: ["tasks"], template_kinds: ["schema"] },
		};
		const parsed = Workflow.parse(input);
		expect(parsed.commands.ship?.reviews_default).toBe(REVIEWS);
	});

	it.each([
		{
			label: "missing vault.dirs",
			input: { commands: {}, vault: { template_kinds: [] } },
		},
		{
			label: "missing vault.template_kinds",
			input: { commands: {}, vault: { dirs: [] } },
		},
		{
			label: "command chain wrong type",
			input: {
				commands: {
					ship: { description: "x", chain: "not-an-array" },
				},
				vault: { dirs: [], template_kinds: [] },
			},
		},
		{
			label: "command missing description",
			input: {
				commands: { ship: { chain: [] } },
				vault: { dirs: [], template_kinds: [] },
			},
		},
		{
			label: "missing top-level vault",
			input: { commands: {} },
		},
	])("rejects malformed input: $label", ({ input }) => {
		const result = Workflow.safeParse(input);
		expect(result.success).toBe(false);
	});
});

describe("ChainStep", () => {
	it.each([
		{
			label: "agent",
			input: { kind: "agent", name: "implementor" },
		},
		{
			label: "parallel",
			input: { kind: "parallel", agents: ["a", "b"] },
		},
		{
			label: "human",
			input: { kind: "human", prompt: "approve?" },
		},
		{
			label: "loop with empty body",
			input: { kind: "loop", max: 3, body: [] },
		},
	])("parses the $label discriminant", ({ input }) => {
		const parsed = ChainStep.parse(input);
		expect(parsed).toEqual(input);
	});

	it("parses a loop with a nested loop body (recursive shape)", () => {
		const input = {
			kind: "loop",
			max: 2,
			body: [
				{ kind: "agent", name: "implementor" },
				{
					kind: "loop",
					max: 1,
					body: [{ kind: "human", prompt: "ok?" }],
				},
			],
		};
		const parsed = ChainStep.parse(input);
		expect(parsed).toEqual(input);
	});

	it("rejects an unknown discriminant", () => {
		const result = ChainStep.safeParse({ kind: "mystery" });
		expect(result.success).toBe(false);
	});

	it("rejects a loop missing max", () => {
		const result = ChainStep.safeParse({ kind: "loop", body: [] });
		expect(result.success).toBe(false);
	});
});

describe("AgentSpec", () => {
	it("applies defaults for tools and vault_scope", () => {
		const parsed = AgentSpec.parse({
			name: "implementor",
			tier: "high",
			description: "does the thing",
			capabilities: ["read", "write"],
		});
		expect(parsed.tools).toEqual([]);
		expect(parsed.vault_scope).toBe("local");
	});

	it("preserves explicit tools and vault_scope", () => {
		const parsed = AgentSpec.parse({
			name: "scout",
			tier: "low",
			description: "scouts",
			capabilities: ["read"],
			tools: ["grep", "find"],
			vault_scope: "global",
		});
		expect(parsed.tools).toEqual(["grep", "find"]);
		expect(parsed.vault_scope).toBe("global");
	});

	it("rejects an unknown capability", () => {
		const result = AgentSpec.safeParse({
			name: "x",
			tier: "high",
			description: "x",
			capabilities: ["telepathy"],
		});
		expect(result.success).toBe(false);
	});

	it("rejects an unknown tier", () => {
		const result = AgentSpec.safeParse({
			name: "x",
			tier: "epic",
			description: "x",
			capabilities: [],
		});
		expect(result.success).toBe(false);
	});
});
