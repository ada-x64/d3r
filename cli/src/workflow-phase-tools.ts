import {
	type RuntimeTool,
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { z } from "zod";

/** Bound conversation handoffs without requiring artifact references. */
const BRIEF_LIMITS = {
	goal: 8192,
	context: 32_768,
	item: 2048,
	items: 32,
	phase: 128,
};
/** Criteria and constraints carry concrete, nonempty statements. */
const briefItem = z.string().trim().min(1).max(BRIEF_LIMITS.item);

/** The orchestrator synthesizes this brief from known conversation facts. */
export const WorkflowBrief = z
	.object({
		goal: z.string().trim().min(1).max(BRIEF_LIMITS.goal),
		context: z.string().trim().min(1).max(BRIEF_LIMITS.context),
		acceptanceCriteria: z.array(briefItem).min(1).max(BRIEF_LIMITS.items),
		constraints: z.array(briefItem).max(BRIEF_LIMITS.items).default([]),
	})
	.strict();
/** Parsed briefs always include a constraints list. */
export type WorkflowBrief = z.infer<typeof WorkflowBrief>;

/** State transitions remain engine-owned; this is their strict input boundary. */
export const PhaseAction = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("start"),
			phase: z.string().trim().min(1).max(BRIEF_LIMITS.phase),
			brief: WorkflowBrief,
			mode: z.enum(["semi", "auto"]).optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("continue"),
			instructions: z.string().trim().min(1).max(BRIEF_LIMITS.context),
		})
		.strict(),
	z
		.object({
			action: z.literal("abandon"),
			reason: z.string().trim().min(1).max(BRIEF_LIMITS.goal),
		})
		.strict(),
	z.object({ action: z.literal("status") }).strict(),
]);
/** Only parsed actions reach the workflow executor. */
export type PhaseAction = z.infer<typeof PhaseAction>;

/** Install phase controls without granting permission for underlying worker effects. */
export const createWorkflowPhaseTools = (
	commands: readonly { name: string; description: string }[],
	execute: (
		action: PhaseAction,
		context: RuntimeToolContext,
	) => Promise<RuntimeToolResult>,
): RuntimeTool[] => {
	const [start, resume, abandon, status] = PhaseAction.options;
	const continueSchema = resume.omit({ action: true });
	const abandonSchema = abandon.omit({ action: true });
	const statusSchema = status.omit({ action: true });
	const tools: RuntimeTool[] = [
		{
			name: "d3r_continue_phase",
			description:
				"Continue only a pending checkpoint or resumable cancellation with the user's answer or explicit resume instructions. This is not a blanket retry for failures, blocked work, or a completed phase; follow the supplied state. Do not answer a human checkpoint yourself or retry without user direction. No prior phase or formal vault documents are required. Underlying worker tools authorize real effects.",
			kind: "other",
			permission: "none",
			schema: continueSchema,
			execute: async (args, context) => {
				context.signal.throwIfAborted();
				const input = continueSchema.parse(args);
				return execute({ ...input, action: "continue" }, context);
			},
		},
		{
			name: "d3r_abandon_phase",
			description:
				"Abandon a retained, unfinished phase only at the user's explicit direction, when no phase execution is running. Abandoning retains existing workspace effects; it does not undo edits, commands, or other effects. No prior phase or formal vault documents are required. Underlying worker tools authorize real effects.",
			kind: "other",
			permission: "none",
			schema: abandonSchema,
			execute: async (args, context) => {
				context.signal.throwIfAborted();
				const input = abandonSchema.parse(args);
				return execute({ ...input, action: "abandon" }, context);
			},
		},
		{
			name: "d3r_phase_status",
			description:
				"Read current workflow state and available next actions without starting, continuing, retrying, or abandoning work. Available in any phase state, including no active phase. No prior phase or formal vault documents are required.",
			kind: "read",
			permission: "none",
			schema: statusSchema,
			execute: async (args, context) => {
				context.signal.throwIfAborted();
				const input = statusSchema.parse(args);
				return execute({ ...input, action: "status" }, context);
			},
		},
	];
	const [first, ...rest] = commands;
	if (first) {
		const startSchema = start.omit({ action: true }).extend({
			phase: z
				.enum([first.name, ...rest.map(({ name }) => name)])
				.describe(
					commands
						.map(({ name, description }) => `${name}: ${description}`)
						.join("\n"),
				),
		});
		tools.unshift({
			name: "d3r_start_phase",
			description:
				"Start any configured phase independently, including develop directly: no prior phase or formal vault documents are required. Start only when no unfinished phase is retained; never replace running, waiting, blocked, or interrupted work. Build the brief from conversation context, known facts, acceptance criteria, and constraints, not fabricated citations. For develop, ask the user to choose semi or auto explicitly; if mode is omitted, the engine asks. Never assume auto. Underlying worker tools authorize real effects.",
			kind: "other",
			permission: "none",
			schema: startSchema,
			execute: async (args, context) => {
				context.signal.throwIfAborted();
				const input = startSchema.parse(args);
				return execute({ ...input, action: "start" }, context);
			},
		});
	}
	return tools;
};

/** Render the factual handoff without inventing documents, provenance, or workflow history. */
export const renderWorkflowBrief = (brief: WorkflowBrief): string =>
	[
		`## Goal\n${brief.goal}`,
		`## Context\n${brief.context}`,
		`## Acceptance criteria\n${brief.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
		...(brief.constraints.length
			? [
					`## Constraints\n${brief.constraints.map((item) => `- ${item}`).join("\n")}`,
				]
			: []),
	].join("\n\n");

/** Persistent native orchestration uses structured tools rather than legacy routing rituals. */
export const ORCHESTRATOR_PROMPT = `You are D3R's native workflow orchestrator in Zed.
Maintain a continuous conversation with the user across phases, questions, and results.
The current workflow state is supplied every turn; use it as authoritative, not guesses from earlier conversation. Use d3r_phase_status when needed to inspect state without changing it.
Discuss and clarify normally unless the user intends a workflow action. /design, /delegate, /develop, and /summarize are shortcuts expressing user phase intent, not execution: you must call d3r_start_phase to start that phase. Printing a command does not start work.
Any configured phase can start independently. No prior phase or formal vault documents are required. Jump straight to develop when the conversation provides an adequate brief. Synthesize goal, context, acceptanceCriteria, and constraints from conversation facts and approved scope; never fabricate citations or claim documents exist. Ask only for missing factual context, not mandatory schema, design, or plan documents.
For develop, ask the user to choose semi or auto if they have not explicitly provided a mode; never assume auto. An omitted mode makes the engine ask at its mode checkpoint.
Start only when no unfinished phase is retained. Do not replace running, waiting, blocked, or interrupted work with a new phase. Continue only a pending checkpoint or resumable cancellation with the user's answer or explicit resume direction, not as a blanket retry of failures. Abandon only at the user's explicit direction when execution is not running; abandoning retains all existing workspace effects, it is not rollback.
Call only one mutating phase tool per model response: d3r_start_phase, d3r_continue_phase, or d3r_abandon_phase. At most one start or continue may run per user turn. Explicit user-directed abandonment may precede a different phase start in that turn. Do not chain actions to bypass a pause. After a waiting, blocked, or interrupted result, return the question or actionable guidance to the user and stop; never answer a human checkpoint on your own, retry, resume, or abandon without user direction.
Delegate implementation to phase workers through these tools; do not execute implementation in the router. The engine owns phase state, role execution, checkpoints, and reports. Worker tools still authorize real effects; phase controls do not bypass permissions or project constraints.
Use only installed native tools. Do not use legacy MODE markers, harness mode switches, or subagent calls. Never implicitly commit or push; require explicit user authorization.
After tool results, synthesize one concise Markdown response for the user with the outcome and any question or next step. Do not output JSON or copy internal structured reports.`;

/** Native workers may use a conversation brief without weakening their role or approval gates. */
export const NATIVE_BRIEF_CONTRACT = `The native conversation brief intentionally substitutes for schema, design, and plan documents when those documents are absent. No prior phase or formal vault documents are required; do not demand or create them merely to satisfy a legacy workflow convention.
These native handoff rules replace document-, branch-, commit-, and vault-filing prerequisites in the role text when the caller intentionally omits those artifacts. Use the supplied brief and verified workspace facts. Do not fabricate documents, citations, branch names, commits, or prior approvals. Operate in the current approved workspace on the requested scope; do not assume a new branch or expanded authority.
When essential context is missing, ask for the specific facts using needs_human rather than inventing them. Preserve all project constraints, approval requirements, and your assigned role remit; a brief is not permission to bypass them.
You may review working-tree changes and report findings inline without creating a vault artifact unless the user requested one. Do not commit or push unless explicitly authorized by the user.
Tests are mandatory for code changes; the implementor runs relevant tests and reports actual results or blockers. Reviewers and auditors retain their read-only remit. allDone is not a shortcut around review: only an implementor may assert allDone, and required reviewer approval still applies. Do not claim success or approval without evidence.`;
