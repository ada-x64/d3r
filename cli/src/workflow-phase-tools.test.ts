/* oxlint-disable no-magic-numbers -- Boundary sizes and expected call counts are the test contract. */
import {
	type RuntimeTool,
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createWorkflowPhaseTools,
	NATIVE_BRIEF_CONTRACT,
	ORCHESTRATOR_PROMPT,
	PhaseAction,
	renderWorkflowBrief,
	WorkflowBrief,
} from "./workflow-phase-tools.ts";

/** Conversation-only input deliberately has no artifact or workflow-history fields. */
const conversationBrief = {
	goal: "Fix search cancellation",
	context: "Search currently keeps running after the user cancels.",
	acceptanceCriteria: [
		"Cancellation stops the search",
		"Regression tests pass",
	],
};
/** Include a custom phase to catch hard-coded slash-command allowlists. */
const commands = [
	{ name: "develop", description: "Implement and review the requested change" },
	{ name: "audit", description: "Inspect the current working tree" },
] as const;
/** Fresh turn context keeps cancellation local to each test. */
const toolContext = (): RuntimeToolContext => ({
	toolCallId: "phase-call",
	cwd: process.cwd(),
	roots: [process.cwd()],
	signal: new AbortController().signal,
});
/** The injected executor is the engine seam, not a replacement state machine. */
const harness = () => {
	const result: RuntimeToolResult = {
		text: "Choose semi or auto.",
		content: [{ type: "text", text: "Choose semi or auto." }],
	};
	const execute = vi.fn(
		async (_action: PhaseAction, _context: RuntimeToolContext) => result,
	);
	const tools = createWorkflowPhaseTools(commands, execute);
	const tool = (name: string): RuntimeTool => {
		const found = tools.find((entry) => entry.name === name);
		if (!found) {
			throw new Error(`Missing phase tool: ${name}`);
		}
		return found;
	};
	return { execute, result, tools, tool };
};

describe("workflow brief and phase action boundaries", () => {
	it("normalizes conversation facts and defaults only constraints", () => {
		expect(
			WorkflowBrief.parse({
				goal: "  Fix search cancellation \n",
				context: "\n Search currently keeps running after the user cancels.  ",
				acceptanceCriteria: [
					" Cancellation stops the search ",
					" Regression tests pass\n",
				],
			}),
		).toEqual({ ...conversationBrief, constraints: [] });
		expect(
			WorkflowBrief.parse({
				...conversationBrief,
				constraints: [" Keep public APIs stable \n"],
			}).constraints,
		).toEqual(["Keep public APIs stable"]);
		expect(conversationBrief).not.toHaveProperty("constraints");
	});

	it("requires factual nonempty fields and rejects unknown brief metadata", () => {
		const invalid = [
			{ goal: undefined },
			{ goal: " \n" },
			{ context: undefined },
			{ context: "\t" },
			{ acceptanceCriteria: undefined },
			{ acceptanceCriteria: [] },
			{ acceptanceCriteria: [" "] },
			{ acceptanceCriteria: [12] },
			{ constraints: [""] },
			{ constraints: [false] },
			{ constraints: null },
			{ artifact: "invented-design.md" },
		];
		for (const fields of invalid) {
			expect(
				WorkflowBrief.safeParse({ ...conversationBrief, ...fields }).success,
			).toBe(false);
		}
	});

	it("accepts inclusive brief limits and rejects excess text or list entries", () => {
		const largest = {
			goal: "g".repeat(8192),
			context: "c".repeat(32_768),
			acceptanceCriteria: Array.from({ length: 32 }, () => "a".repeat(2048)),
			constraints: Array.from({ length: 32 }, () => "c".repeat(2048)),
		};
		expect(WorkflowBrief.parse(largest)).toEqual(largest);
		for (const fields of [
			{ goal: "g".repeat(8193) },
			{ context: "c".repeat(32_769) },
			{ acceptanceCriteria: ["a".repeat(2049)] },
			{ constraints: ["c".repeat(2049)] },
			{ acceptanceCriteria: Array.from({ length: 33 }, () => "criterion") },
			{ constraints: Array.from({ length: 33 }, () => "constraint") },
		]) {
			expect(
				WorkflowBrief.safeParse({ ...conversationBrief, ...fields }).success,
			).toBe(false);
		}
	});

	it("parses all action variants without inventing a develop mode", () => {
		expect(
			PhaseAction.parse({
				action: "start",
				phase: " develop ",
				brief: conversationBrief,
			}),
		).toEqual({
			action: "start",
			phase: "develop",
			brief: { ...conversationBrief, constraints: [] },
		});
		for (const mode of ["semi", "auto"] as const) {
			expect(
				PhaseAction.parse({
					action: "start",
					phase: "develop",
					brief: conversationBrief,
					mode,
				}),
			).toMatchObject({ mode });
		}
		expect(
			PhaseAction.parse({
				action: "continue",
				instructions: " Resume the cancelled search \n",
			}),
		).toEqual({
			action: "continue",
			instructions: "Resume the cancelled search",
		});
		expect(
			PhaseAction.parse({ action: "abandon", reason: " Scope changed \n" }),
		).toEqual({
			action: "abandon",
			reason: "Scope changed",
		});
		expect(PhaseAction.parse({ action: "status" })).toEqual({
			action: "status",
		});
	});

	it("bounds action text and rejects extra fields, wrong variants, or implicit defaults", () => {
		const start = {
			action: "start",
			phase: "develop",
			brief: conversationBrief,
		};
		for (const action of [
			{ ...start, phase: "p".repeat(128) },
			{ action: "continue", instructions: "i".repeat(32_768) },
			{ action: "abandon", reason: "r".repeat(8192) },
		]) {
			expect(PhaseAction.safeParse(action).success).toBe(true);
		}
		for (const action of [
			{ ...start, phase: " " },
			{ ...start, phase: "p".repeat(129) },
			{ ...start, mode: "default" },
			{ ...start, instructions: "skip ahead" },
			{ action: "start", phase: "develop" },
			{ action: "continue", instructions: " " },
			{ action: "continue", instructions: "i".repeat(32_769) },
			{ action: "continue", instructions: "resume", reason: "extra" },
			{ action: "abandon", reason: " " },
			{ action: "abandon", reason: "r".repeat(8193) },
			{ action: "abandon", reason: "stop", mode: "auto" },
			{ action: "status", phase: "develop" },
			{ action: "retry" },
			{},
		]) {
			expect(PhaseAction.safeParse(action).success).toBe(false);
		}
	});
});

describe("workflow phase tools", () => {
	it("exposes configured phases and strict parameter-only schemas without effect permissions", () => {
		const { tools, tool } = harness();
		expect(
			tools.map(({ name, kind, permission }) => ({ name, kind, permission })),
		).toEqual([
			{ name: "d3r_start_phase", kind: "other", permission: "none" },
			{ name: "d3r_continue_phase", kind: "other", permission: "none" },
			{ name: "d3r_abandon_phase", kind: "other", permission: "none" },
			{ name: "d3r_phase_status", kind: "read", permission: "none" },
		]);
		for (const entry of tools) {
			expect(entry.schema).toBeInstanceOf(z.ZodObject);
			expect((entry.schema as z.AnyZodObject).shape).not.toHaveProperty(
				"action",
			);
			expect(entry.description).toMatch(
				/no prior phase or formal vault documents are required/i,
			);
		}
		const schema = tool("d3r_start_phase").schema as z.AnyZodObject;
		expect(schema.shape.phase.options).toEqual(["develop", "audit"]);
		for (const command of commands) {
			expect(schema.shape.phase.description).toContain(
				`${command.name}: ${command.description}`,
			);
		}
		expect(tool("d3r_start_phase").description).toMatch(
			/waiting, blocked, or interrupted/,
		);
		expect(tool("d3r_continue_phase").description).toMatch(
			/pending checkpoint or resumable cancellation/,
		);
		expect(tool("d3r_continue_phase").description).toContain(
			"not a blanket retry",
		);
		expect(tool("d3r_abandon_phase").description).toContain(
			"retains existing workspace effects",
		);
	});

	it("omits only start when no commands are configured", async () => {
		const { execute } = harness();
		const tools = createWorkflowPhaseTools([], execute);
		expect(tools.map(({ name }) => name)).toEqual([
			"d3r_continue_phase",
			"d3r_abandon_phase",
			"d3r_phase_status",
		]);
		const context = toolContext();
		await tools
			.find(({ name }) => name === "d3r_phase_status")!
			.execute({}, context);
		expect(execute).toHaveBeenCalledExactlyOnceWith(
			{ action: "status" },
			context,
		);
	});

	it("starts any configured phase directly from a parsed conversation brief and preserves explicit modes", async () => {
		const { tool, execute, result } = harness();
		const context = toolContext();
		const inputs = [
			{ phase: "develop", brief: conversationBrief },
			{ phase: "develop", brief: conversationBrief, mode: "semi" },
			{ phase: "develop", brief: conversationBrief, mode: "auto" },
			{ phase: "audit", brief: conversationBrief },
		];
		const results = await Promise.all(
			inputs.map((input) => tool("d3r_start_phase").execute(input, context)),
		);
		expect(results).toEqual(inputs.map(() => result));
		expect(execute.mock.calls).toEqual(
			inputs.map((input) => [
				{
					...input,
					action: "start",
					brief: { ...conversationBrief, constraints: [] },
				},
				context,
			]),
		);
	});

	it("rejects invalid tool arguments and action spoofing before invoking the executor", async () => {
		const { tools, tool, execute } = harness();
		const context = toolContext();
		const valid: Record<string, object> = {
			d3r_start_phase: { phase: "develop", brief: conversationBrief },
			d3r_continue_phase: { instructions: "resume" },
			d3r_abandon_phase: { reason: "scope changed" },
			d3r_phase_status: {},
		};
		const attempts: { tool: RuntimeTool; args: unknown }[] = tools.flatMap(
			(entry) => [
				{ tool: entry, args: { ...valid[entry.name], action: "status" } },
				{ tool: entry, args: { ...valid[entry.name], unexpected: true } },
				{ tool: entry, args: null },
			],
		);
		attempts.push(
			{
				tool: tool("d3r_start_phase"),
				args: { phase: "design", brief: conversationBrief },
			},
			{
				tool: tool("d3r_start_phase"),
				args: { phase: "develop", brief: { ...conversationBrief, goal: " " } },
			},
			{
				tool: tool("d3r_start_phase"),
				args: { phase: "develop", brief: conversationBrief, mode: "default" },
			},
			{ tool: tool("d3r_continue_phase"), args: { instructions: " " } },
			{ tool: tool("d3r_abandon_phase"), args: { reason: " " } },
		);
		await Promise.all(
			attempts.map(({ tool: entry, args }) =>
				expect(entry.execute(args, context)).rejects.toBeInstanceOf(z.ZodError),
			),
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("dispatches normalized controls with the original context and propagates engine errors without retry", async () => {
		const { tool, execute, result } = harness();
		const context = toolContext();
		expect(
			await tool("d3r_continue_phase").execute(
				{ instructions: " Resume after cancellation \n" },
				context,
			),
		).toEqual(result);
		expect(
			await tool("d3r_abandon_phase").execute(
				{ reason: " User changed scope \n" },
				context,
			),
		).toEqual(result);
		expect(await tool("d3r_phase_status").execute({}, context)).toEqual(result);
		expect(execute.mock.calls).toEqual([
			[
				{ action: "continue", instructions: "Resume after cancellation" },
				context,
			],
			[{ action: "abandon", reason: "User changed scope" }, context],
			[{ action: "status" }, context],
		]);
		const blocked: RuntimeToolResult = {
			text: "This failure is not resumable.",
			isError: true,
		};
		execute.mockResolvedValueOnce(blocked);
		expect(
			await tool("d3r_continue_phase").execute(
				{ instructions: "retry" },
				context,
			),
		).toEqual(blocked);
		const failure = new Error("An unfinished phase is retained");
		execute.mockRejectedValueOnce(failure);
		await expect(
			tool("d3r_start_phase").execute(
				{ phase: "develop", brief: conversationBrief },
				context,
			),
		).rejects.toBe(failure);
		expect(execute).toHaveBeenCalledTimes(5);
	});

	it("does not dispatch any action from an already cancelled turn", async () => {
		const { tool, execute } = harness();
		const controller = new AbortController();
		const reason = new Error("Turn cancelled");
		controller.abort(reason);
		const context = { ...toolContext(), signal: controller.signal };
		const inputs: Record<string, object> = {
			d3r_start_phase: { phase: "develop", brief: conversationBrief },
			d3r_continue_phase: { instructions: "resume" },
			d3r_abandon_phase: { reason: "stop" },
			d3r_phase_status: {},
		};
		await Promise.all(
			Object.entries(inputs).map(([name, args]) =>
				expect(tool(name).execute(args, context)).rejects.toBe(reason),
			),
		);
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("native conversation contracts", () => {
	it("renders a concise labeled Markdown brief with optional constraints and no invented provenance", () => {
		const brief = WorkflowBrief.parse(conversationBrief);
		const expected = [
			"## Goal\nFix search cancellation",
			"## Context\nSearch currently keeps running after the user cancels.",
			"## Acceptance criteria\n- Cancellation stops the search\n- Regression tests pass",
		].join("\n\n");
		expect(renderWorkflowBrief(brief)).toBe(expected);
		expect(
			renderWorkflowBrief({
				...brief,
				context: "Observed locally.\nKeep the existing API.",
				constraints: ["No new dependencies", "No commits"],
			}),
		).toBe(
			`${expected.replace(conversationBrief.context, "Observed locally.\nKeep the existing API.")}\n\n## Constraints\n- No new dependencies\n- No commits`,
		);
	});

	it("instructs persistent orchestration to delegate intended actions and stop for human decisions", () => {
		expect(
			ORCHESTRATOR_PROMPT.startsWith(
				"You are D3R's native workflow orchestrator in Zed.",
			),
		).toBe(true);
		for (const requirement of [
			/continuous conversation/,
			/state is supplied every turn/,
			/Discuss and clarify normally unless the user intends/,
			/\/design, \/delegate, \/develop, and \/summarize/,
			/must call d3r_start_phase/,
			/No prior phase or formal vault documents are required/,
			/Jump straight to develop/,
			/Ask only for missing factual context/,
			/never fabricate citations/,
			/ask the user to choose semi or auto/,
			/never assume auto/,
			/omitted mode makes the engine ask/,
			/only one mutating phase tool per model response/,
			/After a waiting, blocked, or interrupted result, return the question/,
			/never answer a human checkpoint on your own/,
			/without user direction/,
			/Delegate implementation to phase workers/,
			/do not execute implementation in the router/,
			/Do not use legacy MODE markers, harness mode switches, or subagent calls/,
			/Never implicitly commit or push/,
			/one concise Markdown response/,
			/Do not output JSON/,
		]) {
			expect(ORCHESTRATOR_PROMPT).toMatch(requirement);
		}
	});

	it("lets native roles substitute conversation context without weakening scope, testing, or review", () => {
		for (const requirement of [
			/intentionally substitutes for schema, design, and plan documents/,
			/Do not fabricate documents, citations, branch names, commits, or prior approvals/,
			/current approved workspace on the requested scope/,
			/specific facts using needs_human/,
			/Preserve all project constraints, approval requirements, and your assigned role remit/,
			/review working-tree changes and report findings inline without creating a vault artifact unless the user requested one/,
			/Do not commit or push unless explicitly authorized/,
			/Tests are mandatory/,
			/allDone is not a shortcut around review/,
			/required reviewer approval still applies/,
		]) {
			expect(NATIVE_BRIEF_CONTRACT).toMatch(requirement);
		}
	});
});
