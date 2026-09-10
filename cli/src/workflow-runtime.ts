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
	settleBatch,
	WorkflowOutcome,
	type ExecutionRecord,
} from "@d3r/core/engine";
import { type AgentDefinition } from "./resources.ts";
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
/** Routing checkpoints must be serializable, not executable session objects. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** The routing runtime still owns validation of its checkpoint's internal format. */
const JsonValue: z.ZodType<Json> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(JsonValue),
		z.record(JsonValue),
	]),
);
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
		summary: WorkflowSummary.optional(),
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
): RuntimeSession => {
	const { routing, createAgent } = options;
	let workflow = Workflow.parse(options.workflow);
	checkResources(workflow, options.agents);
	let phase = "routing";
	let engine: EngineState | null = null;
	let history: RuntimeContent[] = [];
	let input: RuntimeContent[] = [];
	let summary: string | null = null;
	let routingInput: RuntimeContent[] = [];
	let routingInterrupted = false;
	let routingBefore: unknown = undefined;
	let routingHistory = 0;
	let recoveringConfig: readonly RuntimeConfigOption[] | null = null;
	let routingBusy = false;
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
		...history,
		...input,
		...outputs(engine),
		{
			type: "text",
			text: `Execute only your assigned role for /${engine!.command}. Mode: ${engine!.mode ?? "declared workflow"}. Call d3r_report exactly once with your final structured outcome after all work. Prose alone never completes a workflow. Do not claim approval or allDone unless established.`,
		},
	];
	// oxlint-disable-next-line max-statements -- Role ownership, failure reporting, and cleanup share one lifetime.
	const runRole = async (
		record: ExecutionRecord,
		request: RuntimePrompt,
	): Promise<void> => {
		const toolCallId = `${namespace}:role:${++sequence}:${record.id}`;
		let child: RuntimeSession | null = null;
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
			request.signal.throwIfAborted();
			result.accepting = true;
			const reason = await child.prompt({
				...request,
				content: structuredClone([...request.content]),
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
				try {
					await child.dispose();
				} catch {
					result.error ??= "Role cleanup failed; workflow paused.";
				}
			}
		}
		if (!request.signal.aborted) {
			engine = recordOutcome(engine!, record.id, result);
		}
		await request.activity?.({
			kind: "tool",
			toolCallId,
			title: record.role!,
			toolKind: "other",
			status:
				!request.signal.aborted &&
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
		while (engine!.status === "ready") {
			request.signal.throwIfAborted();
			engine = beginBatch(engine!);
			await plan(request);
			const batch = engine.records.filter(({ status }) => status === "running");
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
			await summarize(request);
		} else {
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
		input = [];
		summary = null;
	};
	const route = async (request: RuntimePrompt): Promise<RuntimeStopReason> => {
		archiveWorkflow();
		routingBefore = routing.snapshot?.();
		routingInput = structuredClone([...request.content]);
		routingBusy = true;
		const text = new Map<string, string>();
		try {
			const reason = await routing.prompt({
				...request,
				content: [
					...structuredClone(history.slice(routingHistory)),
					...request.content,
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
			routingInterrupted = reason === "cancelled" || request.signal.aborted;
			if (!routingInterrupted) {
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
			routingInterrupted = true;
			throw error;
		} finally {
			routingBusy = false;
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
						(active() && current.signal.aborted)
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
				routing: routingBusy ? routingBefore : routing.snapshot(),
				routingBefore:
					routingBusy || routingInterrupted ? routingBefore : undefined,
				routingHistory,
				routingInterrupted: routingBusy || routingInterrupted,
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
			if (
				restored &&
				JSON.stringify(restored.workflow) !== JSON.stringify(parsed.workflow)
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
				(parsed.phase !== restored.command || parsed.routingInterrupted)
			) {
				throw new Error("Saved phase does not match the active workflow");
			}
			if (parsed.routingHistory > parsed.history.length) {
				throw new Error("Invalid routing handoff position");
			}
			if (!routing.restore) {
				throw new Error("Routing runtime does not support restore");
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
