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
	createWorkflowRoleTool,
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
/** Include a custom worker to keep direct roles driven by loaded definitions. */
const roles = [
	{ name: "orchestrator", description: "Route user requests" },
	{ name: "auditor", description: "Audit the current worktree read-only" },
	{ name: "implementor", description: "Implement the requested change" },
	{ name: "fact-finder", description: "Research the requested topic" },
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

describe("workflow role tool", () => {
	it("appends the strict role action without moving existing options or defaulting mode", () => {
		expect(
			PhaseAction.options.map((option) => option.shape.action.value),
		).toEqual(["start", "continue", "abandon", "status", "role"]);
		const action = {
			action: "role",
			role: "auditor",
			brief: conversationBrief,
		};
		expect(PhaseAction.parse({ ...action, role: " auditor \n" })).toEqual({
			...action,
			brief: { ...conversationBrief, constraints: [] },
		});
		expect(
			PhaseAction.safeParse({ ...action, role: "r".repeat(128) }).success,
		).toBe(true);
		for (const fields of [
			{ role: undefined },
			{ role: " \n" },
			{ role: "r".repeat(129) },
			{ brief: undefined },
			{ phase: "develop" },
			{ mode: "default" },
		]) {
			expect(PhaseAction.safeParse({ ...action, ...fields }).success).toBe(
				false,
			);
		}
	});

	it("exposes only loaded worker roles in a strict parameter-only schema without effect permissions", () => {
		const { execute } = harness();
		const tool = createWorkflowRoleTool(roles, execute)!;
		expect(tool).toMatchObject({
			name: "d3r_run_role",
			kind: "other",
			permission: "none",
		});
		expect(tool.schema).toBeInstanceOf(z.ZodObject);
		const schema = tool.schema as z.AnyZodObject;
		expect(Object.keys(schema.shape)).toEqual([
			"role",
			"brief",
			"mode",
			"topic",
		]);
		expect(schema.shape.role.options).toEqual([
			"auditor",
			"implementor",
			"fact-finder",
		]);
		expect(schema.shape.role.description).toBe(
			roles
				.filter(({ name }) => name !== "orchestrator")
				.map(({ name, description }) => `${name}: ${description}`)
				.join("\n"),
		);
	});

	it("omits the tool when no worker roles are available", () => {
		const { execute } = harness();
		expect(createWorkflowRoleTool([], execute)).toBeUndefined();
		expect(createWorkflowRoleTool([roles[0]], execute)).toBeUndefined();
		expect(execute).not.toHaveBeenCalled();
	});

	it("dispatches one selected role with normalized facts and preserves explicit or omitted mode for the runtime", async () => {
		const { execute, result } = harness();
		const tool = createWorkflowRoleTool(roles, execute)!;
		const context = toolContext();
		const inputs = [
			{ role: "auditor", brief: conversationBrief },
			{ role: "fact-finder", brief: conversationBrief },
			{ role: "implementor", brief: conversationBrief },
			{ role: "implementor", brief: conversationBrief, mode: "semi" },
			{ role: "implementor", brief: conversationBrief, mode: "auto" },
		];
		const results = await Promise.all(
			inputs.map((input) =>
				tool.execute(
					{
						...input,
						brief: { ...input.brief, goal: ` ${input.brief.goal}\n` },
					},
					context,
				),
			),
		);
		for (const output of results) {
			expect(output).toBe(result);
		}
		expect(execute.mock.calls).toEqual(
			inputs.map((input) => [
				{
					...input,
					action: "role",
					brief: { ...conversationBrief, constraints: [] },
				},
				context,
			]),
		);
	});

	it("rejects invalid raw arguments, unconfigured roles, and action spoofing before dispatch", async () => {
		const { execute } = harness();
		const tool = createWorkflowRoleTool(roles, execute)!;
		const context = toolContext();
		const valid = { role: "auditor", brief: conversationBrief };
		const invalid = [
			null,
			{},
			{ ...valid, role: "orchestrator" },
			{ ...valid, role: "reviewer" },
			{ ...valid, role: " " },
			{ ...valid, role: "r".repeat(129) },
			{ ...valid, brief: undefined },
			{ ...valid, brief: { ...conversationBrief, goal: " " } },
			{ ...valid, brief: { ...conversationBrief, artifact: "invented.md" } },
			{ ...valid, mode: "default" },
			{ ...valid, action: "role" },
			{ ...valid, action: "start" },
			{ ...valid, phase: "develop" },
			{ ...valid, unexpected: true },
		];
		await Promise.all(
			invalid.map((args) =>
				expect(tool.execute(args, context)).rejects.toBeInstanceOf(z.ZodError),
			),
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("honors turn cancellation and propagates engine blockers and failures without retry", async () => {
		const { execute } = harness();
		const tool = createWorkflowRoleTool(roles, execute)!;
		const args = { role: "auditor", brief: conversationBrief };
		const context = toolContext();
		const controller = new AbortController();
		const cancelled = new Error("Turn cancelled");
		controller.abort(cancelled);
		await expect(
			tool.execute(args, { ...context, signal: controller.signal }),
		).rejects.toBe(cancelled);
		expect(execute).not.toHaveBeenCalled();

		const blocked: RuntimeToolResult = {
			text: "An unfinished task is retained; explicitly abandon it first.",
			isError: true,
		};
		execute.mockResolvedValueOnce(blocked);
		expect(await tool.execute(args, context)).toBe(blocked);
		const failure = new Error("Role execution failed");
		execute.mockRejectedValueOnce(failure);
		await expect(tool.execute(args, context)).rejects.toBe(failure);
		expect(execute).toHaveBeenCalledTimes(2);
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

describe("workflow topic boundaries", () => {
	it("forwards an exact safe topic name for phase starts and standalone roles", async () => {
		const { tool, execute, result } = harness();
		const context = toolContext();
		const topic = "search-cancellation";
		const requests = [
			{
				entry: tool("d3r_start_phase"),
				action: "start",
				phase: "develop",
			},
			{
				entry: createWorkflowRoleTool(roles, execute)!,
				action: "role",
				role: "fact-finder",
			},
		];
		await Promise.all(
			requests.map(async ({ entry, action, ...selector }) => {
				const input = { ...selector, brief: conversationBrief, topic };
				const expected = {
					...input,
					action,
					brief: { ...conversationBrief, constraints: [] },
				};
				expect(PhaseAction.parse({ ...input, action })).toEqual(expected);
				expect(await entry.execute(input, context)).toBe(result);
				expect(execute).toHaveBeenCalledWith(expected, context);
				for (const requirement of [
					/Omit topic for a new task; the runtime automatically generates it once/,
					/same topic in a later phase or standalone invocation/,
					/copy the topic name supplied in runtime state/,
					/existing topic, use that exact safe slug, not a full path/,
					/Never ask the user to invent a topic name/,
				]) {
					expect(entry.description).toMatch(requirement);
				}
			}),
		);
		expect(execute).toHaveBeenCalledTimes(requests.length);
	});

	it("keeps an omitted topic optional without generating one at the tool boundary", async () => {
		const { tool, execute } = harness();
		const context = toolContext();
		const requests = [
			{
				entry: tool("d3r_start_phase"),
				action: "start",
				phase: "develop",
			},
			{
				entry: createWorkflowRoleTool(roles, execute)!,
				action: "role",
				role: "fact-finder",
			},
		];
		await Promise.all(
			requests.map(async ({ entry, action, ...selector }) => {
				const input = { ...selector, brief: conversationBrief };
				expect((entry.schema as z.AnyZodObject).shape.topic.isOptional()).toBe(
					true,
				);
				expect(entry.schema.parse(input)).not.toHaveProperty("topic");
				expect(PhaseAction.parse({ ...input, action })).not.toHaveProperty(
					"topic",
				);
				await entry.execute(input, context);
			}),
		);
		expect(execute).toHaveBeenCalledTimes(requests.length);
		for (const [action] of execute.mock.calls) {
			expect(action).not.toHaveProperty("topic");
		}
	});

	it("rejects traversal and full paths as topics before phase or role dispatch", async () => {
		const { tool, execute } = harness();
		const context = toolContext();
		const requests = [
			{
				entry: tool("d3r_start_phase"),
				action: "start",
				phase: "develop",
			},
			{
				entry: createWorkflowRoleTool(roles, execute)!,
				action: "role",
				role: "fact-finder",
			},
		];
		await Promise.all(
			requests.flatMap(({ entry, action, ...selector }) =>
				[
					"../other",
					String.raw`..\other`,
					"topic/../other",
					"tasks/search-cancellation",
					"/tmp/search-cancellation",
					String.raw`C:\vault\search-cancellation`,
				].map(async (topic) => {
					const input = { ...selector, brief: conversationBrief, topic };
					expect(PhaseAction.safeParse({ ...input, action }).success).toBe(
						false,
					);
					await expect(entry.execute(input, context)).rejects.toBeInstanceOf(
						z.ZodError,
					);
				}),
			),
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects topic on continue, abandon, and status rather than renaming a retained task", async () => {
		const { tool, execute } = harness();
		const context = toolContext();
		const requests = [
			{
				entry: tool("d3r_continue_phase"),
				action: "continue",
				instructions: "Resume the requested work",
			},
			{
				entry: tool("d3r_abandon_phase"),
				action: "abandon",
				reason: "Stop this task",
			},
			{ entry: tool("d3r_phase_status"), action: "status" },
		];
		await Promise.all(
			requests.map(async ({ entry, action, ...fields }) => {
				const input = { ...fields, topic: "replacement-topic" };
				expect((entry.schema as z.AnyZodObject).shape).not.toHaveProperty(
					"topic",
				);
				expect(PhaseAction.safeParse({ ...input, action }).success).toBe(false);
				await expect(entry.execute(input, context)).rejects.toBeInstanceOf(
					z.ZodError,
				);
			}),
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
			/omit topic from d3r_start_phase or d3r_run_role/,
			/runtime automatically generates one topic name shared across agents and the document folder/,
			/generated topic and default artifact paths supplied by runtime state are authoritative and shared/,
			/Make briefs refer to those paths when supplied/,
			/do not task workers with choosing their own artifact folders/,
			/Reuse the exact topic name from runtime state for follow-on phases or standalone invocations/,
			/omit topic for an unrelated task/,
			/existing topic, use that exact safe slug, never a full path/,
			/Never ask the user to invent a topic name/,
			/never rename an active task/,
			/If it reports a missing vault, before vault document work ask whether to run d3r vault init with --vault-root set to that exact pinned root/,
			/initialization seeds files, initializes a Git repository, and creates its initial commit/,
			/require explicit user consent and normal tool approval/,
			/Never initialize silently or bypass approval/,
			/Do not require a vault for inline, docs-free tasks/,
			/If the user declines, do not repeatedly ask/,
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
			/only one mutating workflow tool per model response/,
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

	it("routes focused work to one role without phase advancement or worktree audit prerequisites", () => {
		const { execute } = harness();
		const tool = createWorkflowRoleTool(roles, execute)!;
		for (const requirement of [
			/only one selected worker role/,
			/loaded role definition's scope/,
			/without starting a phase, requiring prerequisites, or implicitly following with review or audit/,
			/same report and permission lifecycle/,
			/resume.*via d3r_continue_phase/,
			/do not approve or advance an existing workflow/,
			/Never replace an unfinished task/,
			/user must explicitly direct d3r_abandon_phase first/,
			/implementor, require the user's explicit semi or auto mode/,
			/Mode enforcement belongs to the runtime/,
			/read-only with inline findings by default/,
			/do not write report files unless the user requests them/,
		]) {
			expect(tool.description).toMatch(requirement);
		}
		for (const requirement of [
			/focused audit, review, research, or other single-role requests, choose d3r_run_role/,
			/not d3r_start_phase develop/,
			/Loaded role definitions determine scope/,
			/Role outputs are evidence, not completion of phases/,
			/do not approve or advance an existing workflow/,
			/For develop or a direct implementor role, ask the user to choose semi or auto/,
			/Start a phase or role only when no unfinished task is retained/,
			/Direct roles share the report and permission lifecycle and resume via d3r_continue_phase/,
			/At most one start, role, or continue may run per user turn/,
			/Explicit user-directed abandonment may precede the next requested operation in that turn/,
		]) {
			expect(ORCHESTRATOR_PROMPT).toMatch(requirement);
		}
		for (const requirement of [
			/requested standalone worktree audit or review/,
			/current tracked, untracked, and uncommitted workspace state within the requested scope/,
			/No PR, commit range, or vault document is mandatory to audit the worktree/,
			/Reviewers and auditors retain their read-only remit/,
			/report findings inline by default/,
			/do not write report files unless requested/,
			/runtime supplies execution-specific context separately/,
			/do not invent missing workflow history/,
		]) {
			expect(NATIVE_BRIEF_CONTRACT).toMatch(requirement);
		}
	});

	it("lets native roles substitute conversation context without weakening scope, testing, or review", () => {
		for (const requirement of [
			/intentionally substitutes for schema, design, and plan documents/,
			/runtime supplies an explicit topic name and default artifact paths shared across agents and the document folder/,
			/use the default paths unless the operator explicitly chose a path/,
			/Do not independently name researcher notes or choose per-worker artifact folders/,
			/paths are neither permission nor a requirement to write documents/,
			/If live host context reports a missing vault, before vault document work ask using needs_human whether to run d3r vault init with --vault-root set to the exact pinned root/,
			/initialization seeds files, initializes a Git repository, and creates its initial commit/,
			/require explicit user consent and normal tool approval/,
			/Never initialize silently or bypass approval/,
			/Do not require a vault for inline, docs-free tasks/,
			/If the user declines, do not repeatedly ask/,
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
