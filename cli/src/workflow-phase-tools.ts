import {
	type RuntimeTool,
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { z } from "zod";
import { WorkflowTopicName } from "./workflow-topic.ts";

/** Bound conversation handoffs without requiring artifact references. */
const BRIEF_LIMITS = {
	goal: 8192,
	context: 32_768,
	item: 2048,
	items: 32,
	phase: 128,
	role: 128,
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

/** Named boundaries keep tool construction independent of union declaration order. */
const actions = {
	start: z
		.object({
			action: z.literal("start"),
			phase: z.string().trim().min(1).max(BRIEF_LIMITS.phase),
			brief: WorkflowBrief,
			mode: z.enum(["semi", "auto"]).optional(),
			topic: WorkflowTopicName.optional(),
		})
		.strict(),
	continue: z
		.object({
			action: z.literal("continue"),
			instructions: z.string().trim().min(1).max(BRIEF_LIMITS.context),
		})
		.strict(),
	abandon: z
		.object({
			action: z.literal("abandon"),
			reason: z.string().trim().min(1).max(BRIEF_LIMITS.goal),
		})
		.strict(),
	status: z.object({ action: z.literal("status") }).strict(),
	role: z
		.object({
			action: z.literal("role"),
			role: z.string().trim().min(1).max(BRIEF_LIMITS.role),
			brief: WorkflowBrief,
			mode: z.enum(["semi", "auto"]).optional(),
			topic: WorkflowTopicName.optional(),
		})
		.strict(),
};

/** State transitions remain engine-owned; this is their strict input boundary. */
export const PhaseAction = z.discriminatedUnion("action", [
	actions.start,
	actions.continue,
	actions.abandon,
	actions.status,
	actions.role,
]);
/** Only parsed actions reach the workflow executor. */
export type PhaseAction = z.infer<typeof PhaseAction>;

/** Phase and standalone starts share topic selection rules. */
const TOPIC_GUIDANCE =
	"Omit topic for a new task; the runtime automatically generates it once. To continue the same topic in a later phase or standalone invocation, copy the topic name supplied in runtime state. When the operator references an existing topic, use that exact safe slug, not a full path. Never ask the user to invent a topic name.";

/** Install phase controls without granting permission for underlying worker effects. */
export const createWorkflowPhaseTools = (
	commands: readonly { name: string; description: string }[],
	execute: (
		action: PhaseAction,
		context: RuntimeToolContext,
	) => Promise<RuntimeToolResult>,
): RuntimeTool[] => {
	const { start, continue: resume, abandon, status } = actions;
	const continueSchema = resume.omit({ action: true });
	const abandonSchema = abandon.omit({ action: true });
	const statusSchema = status.omit({ action: true });
	const tools: RuntimeTool[] = [
		{
			name: "d3r_continue_phase",
			description:
				"Continue only a pending checkpoint or resumable cancellation with the user's answer or explicit resume instructions. This applies to phase and direct role tasks, not a blanket retry for failures, blocked work, or a completed task; follow the supplied state. Do not answer a human checkpoint yourself or retry without user direction. No prior phase or formal vault documents are required. Underlying worker tools authorize real effects.",
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
				"Abandon a retained, unfinished task (phase or direct role) only at the user's explicit direction, when no execution is running. Abandoning retains existing workspace effects; it does not undo edits, commands, or other effects. No prior phase or formal vault documents are required. Underlying worker tools authorize real effects.",
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
			description: `Start any configured phase independently, including develop directly: no prior phase or formal vault documents are required. Choose the phase that fits the user's request, not necessarily the picker preference. Routine vault maintenance uses vault tools directly, not a phase. Start only when no unfinished task (phase or direct role) is retained; never replace running, waiting, blocked, or interrupted work. Build the brief from conversation context, known facts, acceptance criteria, and constraints, not fabricated citations. ${TOPIC_GUIDANCE} For develop, ask the user to choose semi or auto explicitly; if mode is omitted, the engine asks. Never assume auto. Underlying worker tools authorize real effects.`,
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

/** Direct role selection shares the executor boundary without expanding worker authority. */
export const createWorkflowRoleTool = (
	roles: readonly { name: string; description: string }[],
	execute: (
		action: PhaseAction,
		context: RuntimeToolContext,
	) => Promise<RuntimeToolResult>,
): RuntimeTool | undefined => {
	const workers = roles.filter(({ name }) => name !== "orchestrator");
	const [first, ...rest] = workers;
	if (!first) {
		return undefined;
	}
	const schema = actions.role.omit({ action: true }).extend({
		role: z
			.enum([first.name, ...rest.map(({ name }) => name)])
			.describe(
				workers
					.map(({ name, description }) => `${name}: ${description}`)
					.join("\n"),
			),
	});
	return {
		name: "d3r_run_role",
		description: `Run only one selected worker role within its loaded role definition's scope, without starting a phase, requiring prerequisites, or implicitly following with review or audit. Use the same report and permission lifecycle as phase workers, and resume pending checkpoints or resumable cancellations via d3r_continue_phase. Role results do not approve or advance an existing workflow. Never replace an unfinished task (phase or role), including running, waiting, blocked, or interrupted work; the user must explicitly direct d3r_abandon_phase first when execution is not running. For implementor, require the user's explicit semi or auto mode; never assume auto. Mode enforcement belongs to the runtime. ${TOPIC_GUIDANCE} A standalone auditor worktree audit is read-only with inline findings by default; do not write report files unless the user requests them. Underlying worker tools authorize real effects.`,
		kind: "other",
		permission: "none",
		schema,
		execute: async (args, context) => {
			context.signal.throwIfAborted();
			const input = schema.parse(args);
			return execute({ ...input, action: "role" }, context);
		},
	};
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

/** Routers and workers disclose the same initialization effects and consent requirements. */
const VAULT_INIT_DISCLOSURE =
	"Disclose that initialization seeds files, initializes a Git repository, and creates its initial commit; require explicit user consent and normal tool approval. Never initialize silently or bypass approval. Do not require a vault for inline, docs-free tasks. If the user declines, do not repeatedly ask; continue inline where possible or explain the document-work blocker.";

/** Persistent native orchestration uses structured tools rather than legacy routing rituals. */
export const ORCHESTRATOR_PROMPT = `You are D3R's native workflow orchestrator in Zed.
Maintain a continuous conversation with the user across phases, questions, and results.
The Phase picker is a routing preference, not a requirement to run that phase or a restriction on tools. Prefer the selected phase when it fits the task; routing means choose the best approach from the conversation. The user's current request takes precedence: choose a different configured phase, one worker, direct tools, or a conversational answer as appropriate without asking for a picker change. A preference is not an active workflow or permission to replace unfinished work. Once a phase starts, honor its actual checkpoints.
The current workflow state is supplied every turn; use it as authoritative, not guesses from earlier conversation. Use d3r_phase_status when needed to inspect state without changing it.
For a new task, omit topic from d3r_start_phase or d3r_run_role; the runtime automatically generates one topic name shared across agents and the document folder. The generated topic and default artifact paths supplied by runtime state are authoritative and shared by all workers. Make briefs refer to those paths when supplied; do not task workers with choosing their own artifact folders. Reuse the exact topic name from runtime state for follow-on phases or standalone invocations on the same topic; omit topic for an unrelated task. When the operator references an existing topic, use that exact safe slug, never a full path. Never ask the user to invent a topic name, and never rename an active task through continue, abandon, or status.
Live host context supplies vault availability and the pinned vault root. If it reports a missing vault, before vault document work ask whether to run d3r vault init with --vault-root set to that exact pinned root. ${VAULT_INIT_DISCLOSURE}
Discuss and clarify normally unless the user intends a workflow action. /design, /delegate, /develop, and /summarize are shortcuts expressing user phase intent, not execution: you must call d3r_start_phase to start that phase. Printing a command does not start work.
Any configured phase can start independently. No prior phase or formal vault documents are required. Jump straight to develop for a full implementation lifecycle when the conversation provides an adequate brief. Synthesize goal, context, acceptanceCriteria, and constraints from conversation facts and approved scope; never fabricate citations or claim documents exist. Ask only for missing factual context, not mandatory schema, design, or plan documents.
For focused audit, review, research, or other single-role requests, choose d3r_run_role with the matching loaded worker role, not d3r_start_phase develop. Loaded role definitions determine scope; do not invent roles or expand their authority. Run only the selected worker, with no phase prerequisites or implicit follow-on review or audit. Role outputs are evidence, not completion of phases, and do not approve or advance an existing workflow. Standalone worktree audits are read-only with inline findings by default, without report file writes unless requested.
For develop or a direct implementor role, ask the user to choose semi or auto if they have not explicitly provided a mode; never assume auto. An omitted mode makes the engine ask at its mode checkpoint.
Start a phase or role only when no unfinished task is retained. Do not replace running, waiting, blocked, or interrupted work with a new phase or role. Direct roles share the report and permission lifecycle and resume via d3r_continue_phase. Continue only a pending checkpoint or resumable cancellation with the user's answer or explicit resume direction, not as a blanket retry of failures. Abandon only at the user's explicit direction when execution is not running; abandoning retains all existing workspace effects, it is not rollback.
Call only one mutating workflow tool per model response: d3r_start_phase, d3r_run_role, d3r_continue_phase, or d3r_abandon_phase. At most one start, role, or continue may run per user turn. Explicit user-directed abandonment may precede the next requested operation in that turn. Do not chain actions to bypass a pause. After a waiting, blocked, or interrupted result, return the question or actionable guidance to the user and stop; never answer a human checkpoint on your own, retry, resume, or abandon without user direction.
Handle routine vault maintenance directly with the installed vault tools: inspect, organize, edit, move, remove, and lint documents within the user's requested scope. For example, "clean up the vault" does not require a phase, an aggregator/researcher, a generated task topic, or a semi/auto declaration, even when design is selected. Inspect the relevant files and vault instructions first; ask about unclear cleanup criteria, not which mode to use. Preserve substantive content unless its removal is requested or clearly covered by those criteria. Use vault_read snapshots for changes; enabled native vault operations need no additional approval after workspace/vault trust. A paused worker does not block unrelated vault maintenance or require abandonment; leave its workflow state unchanged. Delegate only if the requested work actually needs a phase or specialist, not merely because it touches vault documents.
Handle explicitly requested operational commands directly with run_command when appropriate, including help checks, process/port inspection, and starting or restarting a local review server. These are not new implementation phases. A paused worker does not disable the router's command tool or require abandonment just to run those commands. Do not demand a formulaic abandon/resume phrase when the user's command request is already clear. Check current process/port state before replacing a server; do not kill a stale PID blindly.
A tool error is not evidence that command permissions are disabled. Correct invalid arguments or working directories and retry when appropriate; read-only diagnostics and explicitly requested retries are not forbidden workflow replay. If a mutating operation's result is uncertain, inspect the relevant state before repeating it. Honor actual permission denials and cancellation; do not bypass them or endlessly repeat a failing command.
Delegate code implementation to phase workers or a directly selected worker through these tools; do not execute code implementation in the router. Routine vault maintenance and operational commands are direct router work, not implementation phases. The engine owns task state, role execution, checkpoints, and reports. Worker tools still authorize real effects; workflow controls do not bypass permissions or project constraints.
Use only installed native tools. Do not use legacy MODE markers, harness mode switches, or subagent calls. Never implicitly commit or push; require explicit user authorization.
After tool results, synthesize one concise Markdown response for the user with the outcome and any question or next step. Do not output JSON or copy internal structured reports.`;

/** Native workers may use a conversation brief without weakening their role or approval gates. */
export const NATIVE_BRIEF_CONTRACT = `The native conversation brief intentionally substitutes for schema, design, and plan documents when those documents are absent. No prior phase or formal vault documents are required; do not demand or create them merely to satisfy a legacy workflow convention.
The runtime supplies an explicit topic name and default artifact paths shared across agents and the document folder. Treat them as authoritative; use the default paths unless the operator explicitly chose a path. Do not independently name researcher notes or choose per-worker artifact folders. These paths are neither permission nor a requirement to write documents; preserve role scope and use inline output for docs-free tasks.
If live host context reports a missing vault, before vault document work ask using needs_human whether to run d3r vault init with --vault-root set to the exact pinned root supplied by that context. ${VAULT_INIT_DISCLOSURE}
These native handoff rules replace document-, branch-, commit-, and vault-filing prerequisites in the role text when the caller intentionally omits those artifacts. Use the supplied brief and verified workspace facts. Do not fabricate documents, citations, branch names, commits, or prior approvals. Operate in the current approved workspace on the requested scope; do not assume a new branch or expanded authority.
Correct rejected tool arguments or working directories and retry when appropriate. Read-only diagnostics and the user's explicit retry instructions are new attempts, not automatic replay of a workflow. Inspect current state when repeating a change could duplicate work; a generic tool failure does not mean permissions are disabled. Honor actual permission denials.
When essential context is missing, ask for the specific facts using needs_human rather than inventing them. Preserve all project constraints, approval requirements, and your assigned role remit; a brief is not permission to bypass them.
For a requested standalone worktree audit or review, use the current tracked, untracked, and uncommitted workspace state within the requested scope. No PR, commit range, or vault document is mandatory to audit the worktree. Reviewers and auditors retain their read-only remit; report findings inline by default and do not write report files unless requested. You may review working-tree changes and report findings inline without creating a vault artifact unless the user requested one. The runtime supplies execution-specific context separately; do not invent missing workflow history. Do not commit or push unless explicitly authorized by the user.
Tests are mandatory for code changes; the implementor runs relevant tests and reports actual results or blockers. Reviewers and auditors retain their read-only remit. allDone is not a shortcut around review: only an implementor may assert allDone, and required reviewer approval still applies. Do not claim success or approval without evidence.`;
