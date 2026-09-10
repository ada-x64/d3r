/* oxlint-disable no-await-in-loop -- Workflow barriers deliberately serialize declared batches. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Workflow } from "@d3r/core";
import {
	formatRuntimeFailure,
	readRuntimeFailure,
	type RuntimeFailure,
	type RuntimeContent,
	type RuntimeConfigOption,
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeStopReason,
	type RuntimeTool,
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import {
	answerCheckpoint,
	beginBatch,
	compileWorkflow,
	createEngine,
	EngineState,
	interruptEngine,
	recordOutcome,
	restoreEngine,
	resumeInterruptedBatch,
	resumeReportedBatch,
	settleBatch,
	WorkflowOutcome,
	type ExecutionRecord,
} from "@d3r/core/engine";
import { type AgentDefinition } from "./resources.ts";
import { PhaseAction, renderWorkflowBrief } from "./workflow-phase-tools.ts";
import {
	WorkflowTopicName,
	createWorkflowTopicName,
	renderWorkflowTopic,
} from "./workflow-topic.ts";
import {
	standaloneWorkflow,
	executionWorkflow,
	STANDALONE_COMMAND,
} from "./workflow-role.ts";
import {
	WorkflowContinuations,
	WorkflowJsonValue as JsonValue,
	type WorkflowJson as Json,
	type WorkflowContinuation,
	snapshotWorkflowJson,
	validateContinuations,
	canResumeWorkflow,
	describeWorkflowState,
} from "./workflow-continuations.ts";
import {
	fallbackWorkflowSummary,
	WorkflowSummary,
	type WorkflowSummaryInput,
} from "./workflow-summary.ts";

/** Main installs this callback as a tool on the newly created role runtime. */
export type WorkflowReport = (outcome: unknown) => void;

/** Resource and model selection remain owned by the composition root. */
export interface WorkflowRuntimeOptions {
	readonly routing: RuntimeSession;
	/** Keep the conversation in routing and expose phase execution only through tools. */
	readonly orchestrated?: boolean;
	/** Live host context is refreshed for routing, never mistaken for an operator message. */
	readonly orchestratorContext?: (signal: AbortSignal) => Promise<string>;
	readonly workflow: Workflow;
	readonly agents: readonly AgentDefinition[];
	readonly createAgent: (
		name: string,
		report: WorkflowReport,
	) => RuntimeSession | Promise<RuntimeSession>;
	readonly summarize?: (
		input: WorkflowSummaryInput,
		signal: AbortSignal,
	) => Promise<string>;
}

/** Phase tools are callable only inside the owning orchestrator prompt. */
export interface WorkflowRuntime extends RuntimeSession {
	readonly runPhase: (
		action: PhaseAction,
		context: RuntimeToolContext,
	) => Promise<RuntimeToolResult>;
}

/** Install exactly one report tool per child; a natural-language answer is not a report. */
export const createWorkflowReportTool = (
	report: WorkflowReport,
): RuntimeTool => ({
	name: "d3r_report",
	description:
		"Report your final workflow outcome exactly once, after all work. Use blocked or needs_human when incomplete. Only a reviewer may approve a review; only an implementor may assert allDone.",
	kind: "other",
	permission: "none",
	schema: WorkflowOutcome,
	execute: async (args, context) => {
		context.signal.throwIfAborted();
		report(WorkflowOutcome.parse(args));
		return { text: "Workflow report recorded." };
	},
});

/** Attachments are persisted as data and never resolved during restoration. */
const Content = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }).strict(),
	z
		.object({
			type: z.literal("image"),
			data: z.string(),
			mimeType: z.string(),
		})
		.strict(),
	z
		.object({
			type: z.literal("resource_link"),
			uri: z.string(),
			name: z.string(),
			description: z.string().optional(),
			mimeType: z.string().optional(),
		})
		.strict(),
]);

/** A snapshot pins all command definitions, including a phase selected but not started. */
const Checkpoint = z
	.object({
		version: z.literal(1),
		format: z.literal("d3r.workflow"),
		workflow: Workflow,
		phase: z.string(),
		engine: EngineState.nullable(),
		history: z.array(Content),
		input: z.array(Content),
		phaseHistory: z.array(Content).optional(),
		summary: WorkflowSummary.optional(),
		orchestrated: z.boolean().optional(),
		standaloneRole: z.string().min(1).optional(),
		topic: WorkflowTopicName.optional(),
		continuations: WorkflowContinuations.optional(),
		routing: JsonValue,
		routingInterrupted: z.boolean(),
		routingInput: z.array(Content),
		routingBefore: JsonValue.optional(),
		routingHistory: z.number().int().nonnegative().default(0),
	})
	.strict()
	.refine(
		(saved) =>
			saved.summary === undefined || saved.engine?.status === "completed",
		"A workflow summary requires a completed engine",
	)
	.refine(
		(saved) => saved.topic === undefined || saved.orchestrated === true,
		"A topic requires orchestrated workflow state",
	);

/** Ordered structured summaries, not arrival order or prose heuristics, feed later roles. */
const outputs = (engine: EngineState | null): RuntimeContent[] =>
	engine
		? [
				{
					type: "text",
					text: `Workflow outcomes (declaration order):\n${JSON.stringify(engine.records.filter((record) => record.outcome || record.answer || record.error).map(({ id, role, status, outcome, answer, error }) => ({ id, role, status, outcome, answer, error })))}`,
				},
			]
		: [];

/** Validate the entire pinned graph before any child can perform effects. */
const checkResources = (
	workflow: Workflow,
	agents: readonly AgentDefinition[],
): void => {
	const names = agents.map(({ spec }) => spec.name);
	if (new Set(names).size !== names.length) {
		throw new Error("Duplicate agent definitions");
	}
	for (const command of Object.keys(workflow.commands)) {
		if (!/^[a-z][a-z0-9_-]*$/.test(command) || command === "routing") {
			throw new Error(`Invalid workflow command: ${command}`);
		}
		for (const record of compileWorkflow(workflow, command)) {
			if (record.role && !names.includes(record.role)) {
				throw new Error(`Missing workflow agent: ${record.role}`);
			}
		}
	}
};

/** The plan schema has no failed/skipped state; labels retain skipped provenance. */
const planStatus = (
	status: ExecutionRecord["status"],
): "completed" | "pending" | "in_progress" => {
	if (["completed", "skipped"].includes(status)) {
		return "completed";
	}
	return status === "pending" ? "pending" : "in_progress";
};

/** Only native selection fields are inspected; transcript contents stay runtime-owned. */
const NativeSelection = z
	.object({
		version: z.literal(1),
		format: z.literal("d3r.pi.embedded"),
		model: z.object({ provider: z.string().min(1), id: z.string().min(1) }),
		thinkingLevel: z.string().min(1),
	})
	.passthrough();

/** Generic runtimes validate each selector; model changes may require a neutral thought level. */
const applySelection = async (
	routing: RuntimeSession,
	desired: readonly RuntimeConfigOption[],
): Promise<void> => {
	const current = (id: string) =>
		routing.getConfig?.().find((option) => option.id === id);
	const select = async (id: string, value: string): Promise<void> => {
		if (current(id)?.value === value) {
			return;
		}
		if (
			!routing.setConfig ||
			!current(id)?.options.some((option) => option.value === value)
		) {
			throw new Error("Routing selection cannot be restored");
		}
		await routing.setConfig(id, value);
		if (current(id)?.value !== value) {
			throw new Error("Routing selection was not applied");
		}
	};
	const model = desired.find(({ id }) => id === "model");
	const thought = desired.find(({ id }) => id === "thought_level");
	if (model && current(model.id)?.value !== model.value) {
		if (thought) {
			await select(thought.id, "off");
		}
		await select(model.id, model.value);
	}
	if (thought) {
		await select(thought.id, thought.value);
	}
};

/** Native restore validates transcript and both selectors atomically; generic failures roll back. */
const recoverRouting = async (
	routing: RuntimeSession,
	before: unknown,
	desired: readonly RuntimeConfigOption[],
): Promise<void> => {
	if (!routing.restore || !routing.snapshot) {
		throw new Error("Routing recovery requires checkpoint support");
	}
	const current = structuredClone(routing.snapshot());
	const latest = NativeSelection.safeParse(current);
	const previous = NativeSelection.safeParse(before);
	try {
		if (latest.success && previous.success) {
			routing.restore({
				...structuredClone(previous.data),
				model: latest.data.model,
				thinkingLevel: latest.data.thinkingLevel,
			});
		} else {
			routing.restore(structuredClone(before));
			await applySelection(routing, desired);
		}
	} catch {
		try {
			routing.restore(current);
		} catch {
			throw new Error(
				"Routing recovery rollback failed; dispose this session.",
			);
		}
		throw new Error(
			"Routing recovery failed; previous transcript and selection retained.",
		);
	}
};

/** Compose deterministic workflow orchestration with an otherwise ordinary routing session. */
// oxlint-disable-next-line max-statements -- One closure owns the per-session lifecycle and its injected IO.
export const createWorkflowRuntime = (
	options: WorkflowRuntimeOptions,
): WorkflowRuntime => {
	const { routing, createAgent } = options;
	const orchestrated = options.orchestrated === true;
	let workflow = Workflow.parse(options.workflow);
	checkResources(workflow, options.agents);
	let phase = "routing";
	let standaloneRole: string | undefined = undefined;
	let topic: string | undefined = undefined;
	let engine: EngineState | null = null;
	let history: RuntimeContent[] = [];
	let input: RuntimeContent[] = [];
	let phaseHistory: RuntimeContent[] = [];
	let summary: string | null = null;
	let routingInput: RuntimeContent[] = [];
	let routingInterrupted = false;
	let routingBefore: unknown = undefined;
	let routingHistory = 0;
	let recoveringConfig: readonly RuntimeConfigOption[] | null = null;
	let routingBusy = false;
	let routingRequest: RuntimePrompt | null = null;
	let phaseBusy = false;
	let phaseUsed = false;
	let continuations: WorkflowContinuation[] = [];
	let disposed = false;
	let configuring: Promise<unknown> | null = null;
	let pending: Promise<RuntimeStopReason> | null = null;
	let disposal: Promise<void> | null = null;
	let controller: AbortController | null = null;
	let sequence = 0;
	const namespace = `d3r:workflow:${randomUUID()}`;

	const seenChildren = new WeakSet<RuntimeSession>();
	const assertIdle = (): void => {
		if (disposed || pending || configuring) {
			throw new Error("Workflow runtime is disposed or already running");
		}
	};
	const active = (): boolean =>
		engine !== null && engine.status !== "completed";
	const getCommands = () =>
		Object.entries(workflow.commands).map(([name, { description }]) => ({
			name,
			description,
		}));
	const getConfig = () => [
		...structuredClone(recoveringConfig ?? routing.getConfig?.() ?? []).filter(
			({ id }) => id !== "phase",
		),
		{
			id: "phase",
			name: "Phase",
			category: "mode" as const,
			value: phase,
			options: [
				{ value: "routing", name: "Routing" },
				...getCommands().map(({ name }) => ({ value: name, name: `/${name}` })),
			],
		},
	];
	const say = (request: RuntimePrompt, text: string) =>
		request.emit({
			kind: "text",
			messageId: `${namespace}:notice:${++sequence}`,
			text,
		});
	const plan = async (request: RuntimePrompt): Promise<void> => {
		if (!engine) {
			return;
		}
		await request.activity?.({
			kind: "plan",
			entries: engine.records
				.filter(({ kind }) => kind !== "loop_end")
				.map((record) => ({
					content: `${record.id}: ${record.role ?? record.prompt}${record.status === "skipped" ? " (skipped)" : ""}`,
					status: planStatus(record.status),
					priority: "medium",
				})),
		});
	};
	const context = (): RuntimeContent[] => [
		...(orchestrated ? phaseHistory : history),
		...input,
		...outputs(engine),
		...(topic === undefined
			? []
			: [{ type: "text" as const, text: renderWorkflowTopic(topic) }]),
		{
			type: "text",
			text: standaloneRole
				? `Execute only ${standaloneRole} as a standalone role, not a phase workflow. Mode: ${standaloneRole === "implementor" ? engine!.mode : "standalone"}. Use the conversation-derived brief; do not require prior phase artifacts. ${["auditor", "reviewer"].includes(standaloneRole) ? "Audit/review the current worktree, including uncommitted and untracked work when in scope. Keep inspection read-only; do not fix findings. Report findings inline with locations and severity; file a report only if explicitly requested. " : ""}No other roles will run automatically, and this task does not approve or complete a phase. Call d3r_report exactly once with your final structured outcome; prose alone does not complete the task.`
				: `Execute only your assigned role for /${engine!.command}. Mode: ${engine!.mode ?? "declared workflow"}. Call d3r_report exactly once with your final structured outcome after all work. Prose alone never completes a workflow. Do not claim approval or allDone unless established.`,
		},
	];
	// oxlint-disable-next-line max-statements -- Role ownership, failure reporting, and cleanup share one lifetime.
	const runRole = async (
		record: ExecutionRecord,
		request: RuntimePrompt,
	): Promise<void> => {
		const toolCallId = `${namespace}:role:${++sequence}:${record.id}`;
		let child: RuntimeSession | null = null;
		let settled = false;
		let completedBeforeCancellation = false;
		let retained: Json | undefined = undefined;
		const savedChild = continuations.find(
			({ recordId }) => recordId === record.id,
		);
		const result: {
			outcome?: WorkflowOutcome;
			error?: string;
			failure?: RuntimeFailure;
			accepting: boolean;
		} = { accepting: false };
		const report: WorkflowReport = (value) => {
			if (!result.accepting || request.signal.aborted) {
				result.error ??= "Report callback is outside its active role turn";
				throw new Error(result.error);
			}
			const parsed = WorkflowOutcome.safeParse(value);
			if (result.outcome || !parsed.success) {
				result.error ??= "Invalid or duplicate d3r_report; workflow paused.";
				throw new Error(result.error);
			}
			result.outcome = parsed.data;
		};
		try {
			request.signal.throwIfAborted();
			await request.activity?.({
				kind: "tool",
				toolCallId,
				title: record.role!,
				toolKind: "other",
				status: "in_progress",
				rawInput: { recordId: record.id, role: record.role },
			});
			request.signal.throwIfAborted();
			const created = await createAgent(record.role!, report);
			if (created === routing || seenChildren.has(created)) {
				result.error ??= "createAgent must return a fresh, isolated runtime";
				throw new Error(result.error);
			}

			child = created;
			seenChildren.add(child);
			if (savedChild) {
				if (!child.restore) {
					throw new Error("Interrupted role cannot restore its conversation");
				}
				child.restore(structuredClone(savedChild.checkpoint));
				await applySelection(child, routing.getConfig?.() ?? []);
			}
			request.signal.throwIfAborted();
			// A new invocation can perform new effects; its predecessor is no longer a safe resume point.
			continuations = continuations.filter(
				({ recordId }) => recordId !== record.id,
			);
			result.accepting = true;
			const reason = await child.prompt({
				...request,
				content: structuredClone([
					...request.content,
					...(savedChild
						? [
								{
									type: "text" as const,
									text: "Continue this unfinished role using the retained conversation and tool results plus the user's latest answer or correction. This is a new role invocation, not a replay. Inspect current state before further changes; do not repeat earlier commands or mutations automatically. Previous reports do not complete this invocation: call d3r_report once after addressing the correction.",
								},
							]
						: []),
				]),
				activity: async (event) => {
					if (
						event.kind === "tool" &&
						event.title === "d3r_report" &&
						event.status === "failed"
					) {
						result.error ??=
							"d3r_report validation or execution failed; workflow paused.";
					}
					await request.activity?.(event);
				},
				emit: (chunk) =>
					request.emit({
						...chunk,
						messageId: `${toolCallId}:${chunk.messageId}`,
						parentToolCallId: chunk.parentToolCallId ?? toolCallId,
					}),
			});
			settled = true;
			completedBeforeCancellation =
				orchestrated && reason === "completed" && !request.signal.aborted;
			if (reason === "cancelled") {
				controller!.abort();
			}
			if (reason !== "completed") {
				result.error ??= [
					"token_limit",
					"request_limit",
					"refused",
					"cancelled",
				].includes(reason)
					? `Role ${record.role} stopped with ${reason}; completion was not established.`
					: "Role returned an invalid completion reason; workflow paused.";
			}
		} catch (error) {
			result.failure = readRuntimeFailure(error);
			result.error ??= result.failure
				? `Role ${record.role}: ${formatRuntimeFailure(result.failure)}`
				: "Role setup or execution failed; effects may have occurred. Workflow paused.";
		} finally {
			result.accepting = false;
			if (child) {
				if (
					orchestrated &&
					settled &&
					(request.signal.aborted ||
						(!result.error && result.outcome?.status === "needs_human")) &&
					child.snapshot &&
					child.restore
				) {
					try {
						retained = snapshotWorkflowJson(child.snapshot());
					} catch {
						// No continuation is safer than recreating a role without its effect evidence.
					}
				}
				try {
					await child.dispose();
				} catch {
					retained = undefined;
					result.error ??= "Role cleanup failed; workflow paused.";
				}
			}
		}
		continuations = continuations.filter(
			({ recordId }) => recordId !== record.id,
		);
		if (retained !== undefined) {
			continuations.push({ recordId: record.id, checkpoint: retained });
		}
		if (!request.signal.aborted || completedBeforeCancellation) {
			engine = recordOutcome(engine!, record.id, result);
		}
		await request.activity?.({
			kind: "tool",
			toolCallId,
			title: record.role!,
			toolKind: "other",
			status:
				(!request.signal.aborted || completedBeforeCancellation) &&
				!result.error &&
				result.outcome?.status === "completed"
					? "completed"
					: "failed",
			rawOutput: result.error
				? {
						error: result.error,
						...(result.failure ? { failure: result.failure } : {}),
						outcome: result.outcome,
					}
				: (result.outcome ?? { error: "Missing d3r_report" }),
		});
	};
	const summarize = async (request: RuntimePrompt): Promise<void> => {
		request.signal.throwIfAborted();
		let result: unknown = undefined;
		try {
			result = await options.summarize?.(
				structuredClone({
					command: engine!.command,
					description: engine!.workflow.commands[engine!.command].description,
					input,
					history,
					records: engine!.records,
				}),
				request.signal,
			);
		} catch {
			// A failed synthesis must not invalidate completed work or leak provider errors.
		}
		request.signal.throwIfAborted();
		const parsed = WorkflowSummary.safeParse(result);
		summary = parsed.success
			? parsed.data
			: fallbackWorkflowSummary(
					engine!.command,
					Object.keys(workflow.commands),
				);
		// Delivery errors propagate: a second message could duplicate an already delivered summary.
		await say(request, summary);
	};
	const drive = async (request: RuntimePrompt): Promise<RuntimeStopReason> => {
		await plan(request);
		while (engine!.status === "ready" || engine!.status === "running") {
			request.signal.throwIfAborted();
			if (engine!.status === "ready") {
				engine = beginBatch(engine!);
			}
			await plan(request);
			const batch = engine!.records.filter(
				({ status }) => status === "running",
			);
			const batchRequest = { ...request, content: context() };
			const results = await Promise.allSettled(
				batch.map((record) =>
					runRole(record, batchRequest).catch((error: unknown) => {
						controller!.abort();
						throw error;
					}),
				),
			);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") {
				throw failure.reason;
			}
			request.signal.throwIfAborted();
			engine = settleBatch(engine!);
			await plan(request);
		}
		if (engine!.status === "completed") {
			phase = "routing";
			if (!orchestrated) {
				await summarize(request);
			}
		} else if (!orchestrated) {
			const decision = ["failure", "report", "interrupted"].includes(
				engine!.pause!.kind,
			)
				? " Reply abandon to stop, or restart to explicitly rerun the entire pinned workflow (including previously completed effects)."
				: "";
			await say(
				request,
				`Workflow /${engine!.command} ${engine!.status}: ${engine!.pause!.message}${decision}`,
			);
		}
		return "completed";
	};
	const archiveWorkflow = (): void => {
		if (!engine) {
			return;
		}
		history.push(...input, ...outputs(engine));
		if (summary !== null) {
			history.push({
				type: "text",
				text: `Workflow summary (/${engine.command}):\n${summary}`,
			});
		}
		engine = null;
		standaloneRole = undefined;
		input = [];
		summary = null;
		continuations = [];
		phaseHistory = [];
	};
	const canResume = () => canResumeWorkflow(engine, continuations);
	const phaseState = () =>
		[
			describeWorkflowState(engine, {
				phase,
				resumable: canResume(),
				standaloneRole,
			}),
			...(topic === undefined
				? []
				: [
						active()
							? "Current task topic:"
							: "Most recent topic; reuse only for follow-on work on the same subject:",
						renderWorkflowTopic(topic),
					]),
		].join("\n\n");
	// oxlint-disable-next-line max-statements -- A phase tool owns its transition and effect lifetime under one guard.
	const runPhase = async (
		value: PhaseAction,
		tool: RuntimeToolContext,
	): Promise<RuntimeToolResult> => {
		const action = PhaseAction.parse(value);
		if (
			!orchestrated ||
			!routingRequest ||
			!routingBusy ||
			disposed ||
			(tool.requestSignal ?? tool.signal) !== routingRequest.signal
		) {
			throw new Error("Phase tools require an active orchestrator turn");
		}
		tool.signal.throwIfAborted();
		if (action.action === "status") {
			return { text: phaseState() };
		}
		if (phaseBusy || phaseUsed) {
			return {
				text: "A phase action already ran in this turn. Present its result to the user before starting or continuing more work.",
				isError: true,
			};
		}
		phaseBusy = true;
		try {
			if (action.action === "abandon") {
				if (!active()) {
					return {
						text: "There is no unfinished phase to abandon.",
						isError: true,
					};
				}
				input.push({
					type: "text",
					text: `User-directed abandonment: ${action.reason}`,
				});
				archiveWorkflow();
				phase = "routing";
				return {
					text: "Phase abandoned. Existing effects remain; no work was replayed or undone.",
				};
			}
			if (action.action === "role") {
				if (active()) {
					return {
						text: `Cannot replace unfinished work with a standalone role.\n\n${phaseState()}`,
						isError: true,
					};
				}
				if (action.role === "implementor" && action.mode === undefined) {
					return {
						text: "Choose semi or auto explicitly before running the implementor. No role was started.",
						isError: true,
					};
				}
				const graph = standaloneWorkflow(workflow, options.agents, action.role);
				const started = createEngine(
					graph,
					STANDALONE_COMMAND,
					action.mode ?? null,
				);
				archiveWorkflow();
				engine = started;
				topic = action.topic ?? createWorkflowTopicName(action.brief.goal);
				standaloneRole = action.role;
				phase = "routing";
				phaseHistory = structuredClone(history);
				input = [
					...structuredClone(routingInput),
					{
						type: "text",
						text: `Conversation-derived standalone role brief:\n\n${renderWorkflowBrief(action.brief)}`,
					},
				];
			} else if (action.action === "start") {
				if (active() || !Object.hasOwn(workflow.commands, action.phase)) {
					return {
						text: `Cannot replace unfinished work or start an unknown phase.\n\n${phaseState()}`,
						isError: true,
					};
				}
				const started = createEngine(
					workflow,
					action.phase,
					action.mode ?? null,
				);
				archiveWorkflow();
				engine = started;
				topic = action.topic ?? createWorkflowTopicName(action.brief.goal);
				phaseHistory = structuredClone(history);
				({ phase } = action);
				input = [
					...structuredClone(routingInput),
					{
						type: "text",
						text: `Conversation-derived phase brief (formal vault documents intentionally optional):\n\n${renderWorkflowBrief(action.brief)}`,
					},
				];
			} else {
				if (!active()) {
					return {
						text: "There is no unfinished phase to continue.",
						isError: true,
					};
				}
				if (canResume()) {
					engine =
						engine!.status === "interrupted"
							? resumeInterruptedBatch(engine!)
							: resumeReportedBatch(engine!);
				} else if (
					engine!.status === "waiting" &&
					["mode", "human", "semi"].includes(engine!.pause!.kind)
				) {
					try {
						engine = answerCheckpoint(engine!, action.instructions);
					} catch {
						return {
							text: `The checkpoint answer was not accepted.\n\n${phaseState()}`,
							isError: true,
						};
					}
				} else if (engine!.status !== "ready") {
					return {
						text: `This phase cannot safely continue.\n\n${phaseState()}`,
						isError: true,
					};
				}
				input.push(...structuredClone(routingInput), {
					type: "text",
					text: `Latest user correction or checkpoint answer:\n${action.instructions}`,
				});
			}
			phaseUsed = true;
			try {
				await drive({ ...routingRequest, signal: tool.signal });
			} catch (error) {
				if (engine?.status === "running") {
					engine = engine.records.some(({ status }) => status === "running")
						? interruptEngine(engine)
						: settleBatch(engine);
					if (engine.status === "completed") {
						phase = "routing";
					}
				}
				throw error;
			}
			return { text: phaseState() };
		} finally {
			phaseBusy = false;
		}
	};
	const route = async (request: RuntimePrompt): Promise<RuntimeStopReason> => {
		if (!orchestrated || !active()) {
			archiveWorkflow();
		}
		routingBefore = routing.snapshot?.();
		routingInput = structuredClone([...request.content]);
		routingBusy = true;
		routingRequest = request;
		phaseUsed = false;
		const text = new Map<string, string>();
		try {
			const hostContext = orchestrated
				? await options.orchestratorContext?.(request.signal)
				: undefined;
			request.signal.throwIfAborted();
			const reason = await routing.prompt({
				...request,
				content: [
					...structuredClone(history.slice(routingHistory)),
					...request.content,
					...(orchestrated
						? [
								{
									type: "text" as const,
									text: `D3R runtime phase state (authoritative):\n${phaseState()}`,
								},
							]
						: []),
					...(hostContext
						? [{ type: "text" as const, text: hostContext }]
						: []),
				],
				emit: async (chunk) => {
					await request.emit(chunk);
					if (chunk.kind === "text") {
						text.set(
							chunk.messageId,
							(text.get(chunk.messageId) ?? "") + chunk.text,
						);
					}
				},
			});
			routingInterrupted =
				!orchestrated && (reason === "cancelled" || request.signal.aborted);
			if (
				!routingInterrupted &&
				reason !== "cancelled" &&
				!request.signal.aborted
			) {
				history.push(
					...routingInput
						.filter((item) => item.type === "text")
						.map(({ text: incoming }) => ({
							type: "text" as const,
							text: `Routing user:\n${incoming}`,
						})),
				);
				if (reason === "completed") {
					history.push(
						...[...text.values()].map((response) => ({
							type: "text" as const,
							text: `Routing response:\n${response}`,
						})),
					);
				}
				routingHistory = history.length;
			}
			return request.signal.aborted ? "cancelled" : reason;
		} catch (error) {
			routingInterrupted = !orchestrated;
			throw error;
		} finally {
			routingBusy = false;
			routingRequest = null;
		}
	};
	// oxlint-disable-next-line max-statements -- Explicit directive and recovery branches must not silently start a new run.
	const execute = async (
		request: RuntimePrompt,
	): Promise<RuntimeStopReason> => {
		const text = request.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		const directive = /^\/([^\s]+)/.exec(text)?.[1];
		if (orchestrated) {
			return route(request);
		}
		if ((active() || routingInterrupted) && directive) {
			try {
				await say(
					request,
					[
						routingInterrupted
							? "A previous routing turn was interrupted."
							: `Workflow /${engine!.command} is ${engine!.status}.`,
						...(engine?.pause ? [engine.pause.message] : []),
						"Reply abandon to end it without replaying effects, then resend your slash command.",
					].join("\n"),
				);
			} catch (error) {
				// Cancelling a notice must not interrupt the retained workflow's checkpoint.
				if (request.signal.aborted) {
					return "cancelled";
				}
				throw error;
			}
			return "completed";
		}
		if (routingInterrupted) {
			if (
				["abandon", "restart"].includes(text) &&
				routingBefore !== undefined
			) {
				recoveringConfig = structuredClone(routing.getConfig?.() ?? []);
				try {
					await recoverRouting(routing, routingBefore, recoveringConfig);
				} finally {
					recoveringConfig = null;
				}
				request.signal.throwIfAborted();
			}
			if (text === "abandon") {
				routingInterrupted = false;
				return say(
					request,
					"Interrupted routing turn abandoned; no effects were replayed.",
				).then(() => "completed");
			}
			if (text !== "restart") {
				return say(
					request,
					"Routing was interrupted. Reply abandon, or restart to explicitly repeat the original prompt; effects may be duplicated.",
				).then(() => "completed");
			}
			routingInterrupted = false;
			return route({ ...request, content: routingInput });
		}
		if (active()) {
			if (text === "abandon") {
				archiveWorkflow();
				phase = "routing";
				await say(request, "Workflow abandoned; no effects were replayed.");
				return "completed";
			}
			if (
				["blocked", "interrupted"].includes(engine!.status) ||
				engine!.pause?.kind === "report"
			) {
				if (text === "restart") {
					engine = createEngine(
						engine!.workflow,
						engine!.command,
						engine!.mode,
					);
				}
			} else if (engine!.status === "waiting") {
				try {
					engine = answerCheckpoint(engine!, text);
				} catch (error) {
					await say(request, String(error));
					return "completed";
				}
				input.push(...structuredClone([...request.content]));
			} else {
				input.push(...structuredClone([...request.content]));
			}
			return drive(request);
		}
		if (directive && Object.hasOwn(workflow.commands, directive)) {
			phase = directive;
		} else if (directive || phase === "routing") {
			return route(request);
		}
		archiveWorkflow();
		input = structuredClone([...request.content]);
		engine = createEngine(workflow, phase);
		return drive(request);
	};
	return {
		getConfig,
		getCommands,
		runPhase,
		setConfig: async (id, value) => {
			assertIdle();
			if (id === "phase") {
				if (active() || routingInterrupted) {
					throw new Error("Abandon the active workflow before changing phase");
				}
				if (value !== "routing" && !Object.hasOwn(workflow.commands, value)) {
					throw new Error("Unknown workflow phase");
				}
				phase = value;
			} else {
				if (!routing.setConfig) {
					throw new Error("Routing runtime does not support configuration");
				}
				const configure = routing.setConfig;
				configuring = Promise.resolve().then(() => configure(id, value));
				try {
					await configuring;
				} finally {
					configuring = null;
				}
			}
			return getConfig();
		},
		prompt: (request) => {
			assertIdle();
			if (request.signal.aborted) {
				return Promise.resolve("cancelled");
			}
			controller = new AbortController();
			const current = controller;
			const abort = () => current.abort();
			request.signal.addEventListener("abort", abort, { once: true });
			pending = Promise.resolve()
				.then(async () => {
					current.signal.throwIfAborted();
					const reason = await execute({ ...request, signal: current.signal });
					return current.signal.aborted ? ("cancelled" as const) : reason;
				})
				.catch((error: unknown) => {
					if (
						engine?.status === "running" ||
						(!orchestrated && active() && current.signal.aborted)
					) {
						engine = interruptEngine(engine!);
					}
					if (current.signal.aborted) {
						return "cancelled" as const;
					}
					throw error;
				})
				.finally(() => {
					request.signal.removeEventListener("abort", abort);
					pending = null;
					controller = null;
				});
			return pending;
		},
		snapshot: () => {
			if (disposed || configuring || recoveringConfig) {
				throw new Error(
					"Cannot snapshot a disposed or configuring workflow runtime",
				);
			}
			if (!routing.snapshot || !routing.restore) {
				throw new Error("Routing runtime must support snapshot and restore");
			}
			return Checkpoint.parse({
				version: 1,
				format: "d3r.workflow",
				workflow,
				phase,
				engine,
				history,
				input,
				...(summary === null ? {} : { summary }),
				...(orchestrated ? { orchestrated, continuations, phaseHistory } : {}),
				...(standaloneRole === undefined ? {} : { standaloneRole }),
				...(topic === undefined ? {} : { topic }),
				routing: snapshotWorkflowJson(
					routingBusy ? routingBefore : routing.snapshot(),
				),
				routingBefore:
					routingBusy || routingInterrupted
						? snapshotWorkflowJson(routingBefore)
						: undefined,
				routingHistory,
				routingInterrupted:
					!orchestrated && (routingBusy || routingInterrupted),
				routingInput,
			});
		},
		restore: (checkpoint) => {
			assertIdle();
			const parsed = Checkpoint.parse(
				typeof checkpoint === "string" ? JSON.parse(checkpoint) : checkpoint,
			);
			const restored = parsed.engine ? restoreEngine(parsed.engine) : null;
			checkResources(parsed.workflow, options.agents);
			const expectedWorkflow = executionWorkflow(
				parsed.workflow,
				options.agents,
				{ ...parsed, engine: restored },
			);
			if (
				restored &&
				JSON.stringify(restored.workflow) !== JSON.stringify(expectedWorkflow)
			) {
				throw new Error("Engine and session workflow pins differ");
			}
			if (
				parsed.phase !== "routing" &&
				!Object.hasOwn(parsed.workflow.commands, parsed.phase)
			) {
				throw new Error("Invalid saved phase");
			}
			if (
				restored &&
				restored.status !== "completed" &&
				((parsed.standaloneRole === undefined &&
					parsed.phase !== restored.command) ||
					parsed.routingInterrupted)
			) {
				throw new Error("Saved phase does not match the active workflow");
			}
			if (parsed.routingHistory > parsed.history.length) {
				throw new Error("Invalid routing handoff position");
			}
			if (!routing.restore) {
				throw new Error("Routing runtime does not support restore");
			}
			validateContinuations(
				restored,
				parsed.continuations ?? [],
				parsed.orchestrated === true,
			);
			if ((parsed.orchestrated === true) !== orchestrated) {
				throw new Error("Saved orchestration mode differs from the runtime");
			}
			routing.restore(structuredClone(parsed.routing));
			({
				workflow,
				phase,
				history,
				input,
				routingInterrupted,
				routingInput,
				routingHistory,
			} = parsed);
			engine = restored;
			({ standaloneRole, topic } = parsed);
			continuations = structuredClone(parsed.continuations ?? []);
			phaseHistory = structuredClone(parsed.phaseHistory ?? []);
			summary = parsed.summary ?? null;
			routingBefore = parsed.routingBefore ?? parsed.routing;
		},
		dispose: () => {
			if (disposal) {
				return disposal;
			}
			disposed = true;
			controller?.abort();
			disposal = (async () => {
				await pending?.catch(() => undefined);
				await configuring?.catch(() => undefined);
				await routing.dispose();
			})();
			return disposal;
		},
	};
};
