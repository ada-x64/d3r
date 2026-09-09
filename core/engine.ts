import { z } from "zod";
import { Workflow, type ChainStep } from "./schema.ts";

/** The only completion contract accepted at an agent boundary. */
export const WorkflowOutcome = z
	.object({
		status: z.enum(["completed", "blocked", "needs_human"]),
		summary: z.string().trim().min(1),
		review: z.enum(["approved", "changes_requested"]).optional(),
		allDone: z.boolean().optional(),
	})
	.strict();
export type WorkflowOutcome = z.infer<typeof WorkflowOutcome>;

/** Expansion budgets prevent recursive or multiplicative workflow blowups. */
const MAX_RECORDS = 10_000;
/** Nested loops have a separate recursion budget. */
const MAX_DEPTH = 16;

/** A loop identity is shared by all of its statically expanded iterations. */
const LoopScope = z
	.object({
		id: z.string(),
		iteration: z.number().int().positive(),
		max: z.number().int().positive(),
	})
	.strict();
/** Records retain declaration order, even when their effects run concurrently. */
export const ExecutionRecord = z
	.object({
		id: z.string(),
		kind: z.enum(["agent", "human", "loop_end"]),
		batch: z.string(),
		role: z.string().optional(),
		prompt: z.string().optional(),
		loops: z.array(LoopScope),
		status: z.enum([
			"pending",
			"running",
			"completed",
			"skipped",
			"waiting",
			"blocked",
			"interrupted",
		]),
		outcome: WorkflowOutcome.optional(),
		answer: z.string().optional(),
		error: z.string().optional(),
	})
	.strict();
export type ExecutionRecord = z.infer<typeof ExecutionRecord>;

/** Serializable engine data contains a pinned graph, not references to live resources. */
export const EngineState = z
	.object({
		version: z.literal(1),
		workflow: Workflow,
		command: z.string(),
		mode: z.enum(["semi", "auto"]).nullable(),
		status: z.enum([
			"ready",
			"running",
			"waiting",
			"blocked",
			"interrupted",
			"completed",
		]),
		pause: z
			.object({
				kind: z.enum([
					"mode",
					"human",
					"semi",
					"report",
					"failure",
					"interrupted",
				]),
				message: z.string(),
			})
			.strict()
			.nullable(),
		activeBatch: z.string().nullable(),
		records: z.array(ExecutionRecord).max(MAX_RECORDS),
	})
	.strict();
export type EngineState = z.infer<typeof EngineState>;

/** Compile bounded control flow to stable path IDs without invoking any agents. */
export const compileWorkflow = (
	workflow: Workflow,
	command: string,
): ExecutionRecord[] => {
	const definition = Object.hasOwn(workflow.commands, command)
		? workflow.commands[command]
		: undefined;
	if (!definition) {
		throw new Error(`Unknown workflow command: ${command}`);
	}
	const records: ExecutionRecord[] = [];
	const add = (record: ExecutionRecord): void => {
		if (records.length >= MAX_RECORDS) {
			throw new Error("Workflow expansion exceeds record budget");
		}
		records.push(record);
	};
	const expand = (
		steps: ChainStep[],
		path: string,
		loops: ExecutionRecord["loops"],
	): void => {
		if (loops.length > MAX_DEPTH) {
			throw new Error("Workflow nesting exceeds depth budget");
		}
		if (!steps.length) {
			throw new Error("Workflow chains and loop bodies must not be empty");
		}
		steps.forEach((step, index) => {
			const id = `${path}/${index}`;
			const base = { id, batch: id, loops, status: "pending" as const };
			if (step.kind === "agent" || step.kind === "parallel") {
				const roles = step.kind === "agent" ? [step.name] : step.agents;
				if (!roles.length || roles.some((role) => !role.trim())) {
					throw new Error("Agent batches must name at least one role");
				}
				roles.forEach((role, slot) =>
					add({
						...base,
						id: step.kind === "agent" ? id : `${id}/${slot}`,
						kind: "agent",
						role,
					}),
				);
			} else if (step.kind === "human") {
				if (!step.prompt.trim()) {
					throw new Error("Human checkpoint requires a prompt");
				}
				add({ ...base, kind: "human", prompt: step.prompt });
			} else {
				if (
					!Number.isSafeInteger(step.max) ||
					step.max < 1 ||
					step.max > MAX_RECORDS
				) {
					throw new Error("Loop max must be a bounded positive integer");
				}
				for (let iteration = 1; iteration <= step.max; iteration++) {
					const scope = [...loops, { id, iteration, max: step.max }];
					const prefix = `${id}@${iteration}`;
					expand(step.body, prefix, scope);
					add({
						...base,
						id: `${prefix}/end`,
						batch: `${prefix}/end`,
						kind: "loop_end",
						loops: scope,
					});
				}
			}
		});
	};
	expand(definition.chain, encodeURIComponent(command), []);
	return records;
};

/** Pause mutation is confined to private copies owned by pure transitions. */
const pause = (
	state: EngineState,
	kind: NonNullable<EngineState["pause"]>["kind"],
	message: string,
): EngineState => {
	state.status = "waiting";
	if (kind === "failure") {
		state.status = "blocked";
	}
	if (kind === "interrupted") {
		state.status = "interrupted";
	}
	state.pause = { kind, message };
	return state;
};

/** Consume only control records; reaching a role never performs work. */
const advance = (state: EngineState): EngineState => {
	state.pause = null;
	for (const record of state.records.filter(
		(entry) => entry.status === "pending",
	)) {
		if (record.kind === "human") {
			record.status = "waiting";
			return pause(state, "human", record.prompt!);
		}
		if (record.kind === "agent") {
			state.status = "ready";
			return state;
		}
		const loop = record.loops.at(-1)!;
		if (loop.iteration === loop.max) {
			record.status = "blocked";
			return pause(
				state,
				"failure",
				`Loop ${loop.id} exhausted ${loop.max} iterations without reviewer approval or implementor allDone. No subsequent steps were run.`,
			);
		}
		record.status = "completed";
	}
	state.status = "completed";
	return state;
};

/** Develop always starts with an explicit mode choice unless one is supplied by the caller. */
export const createEngine = (
	workflow: unknown,
	command: string,
	mode: EngineState["mode"] = null,
): EngineState => {
	const pinned = Workflow.parse(workflow);
	const state: EngineState = {
		version: 1,
		workflow: pinned,
		command,
		mode,
		status: "ready",
		pause: null,
		activeBatch: null,
		records: compileWorkflow(pinned, command),
	};
	return command === "develop" && mode === null
		? pause(
				state,
				"mode",
				"Choose develop mode: semi (confirm between agent batches) or auto (run until a checkpoint or completion). Reply semi or auto.",
			)
		: advance(state);
};

/** Begin exactly the first declared batch; callers may execute its records in parallel. */
export const beginBatch = (input: EngineState): EngineState => {
	if (input.status !== "ready") {
		throw new Error("Engine is not ready for a batch");
	}
	const state = structuredClone(input);
	const first = state.records.find((record) => record.status === "pending");
	if (
		first?.kind !== "agent" ||
		state.records.some(
			(record) => record.batch === first.batch && record.status !== "pending",
		)
	) {
		throw new Error(
			"Batch cannot replay settled records or bypass a checkpoint",
		);
	}
	state.activeBatch = first.batch;
	state.status = "running";
	state.records
		.filter((record) => record.batch === first.batch)
		.forEach((record) => {
			record.status = "running";
		});
	return state;
};

/** Commit settled children independently so snapshots retain already completed parallel outputs. */
export const recordOutcome = (
	input: EngineState,
	id: string,
	result: { outcome?: unknown; error?: string },
): EngineState => {
	const state = structuredClone(input);
	const record = state.records.find((entry) => entry.id === id);
	if (
		state.status !== "running" ||
		record?.status !== "running" ||
		record.batch !== state.activeBatch
	) {
		throw new Error("Record is not in the active batch");
	}
	const parsed = WorkflowOutcome.safeParse(result.outcome);
	if (parsed.success) {
		record.outcome = parsed.data;
	}
	if (result.error || !parsed.success) {
		record.status = "blocked";
		record.error =
			result.error ??
			"Missing or invalid d3r_report; completion was not established.";
	} else {
		record.status =
			parsed.data.status === "needs_human" ? "waiting" : parsed.data.status;
	}
	return state;
};

/** Only role-specific, explicit success closes the innermost loop containing a batch. */
const closeLoops = (state: EngineState, batch: ExecutionRecord[]): void => {
	if (batch.some((record) => record.outcome?.review === "changes_requested")) {
		return;
	}
	batch.forEach((record) => {
		const success =
			(record.role === "reviewer" && record.outcome?.review === "approved") ||
			(record.role === "implementor" && record.outcome?.allDone === true);
		const loop = record.loops.at(-1);
		if (!success || !loop) {
			return;
		}
		state.records
			.filter(
				(entry) =>
					entry.status === "pending" &&
					entry.loops.some((scope) => scope.id === loop.id),
			)
			.forEach((entry) => {
				entry.status = "skipped";
			});
	});
};

/** A barrier advances only after every child has settled, regardless of completion order. */
export const settleBatch = (input: EngineState): EngineState => {
	if (
		input.status !== "running" ||
		input.records.some((record) => record.status === "running")
	) {
		throw new Error("Batch has not settled");
	}
	const state = structuredClone(input);
	const batch = state.records.filter(
		(record) => record.batch === state.activeBatch,
	);
	state.activeBatch = null;
	const blocked = batch.find((record) => record.status === "blocked");
	if (blocked) {
		return pause(state, "failure", blocked.error ?? blocked.outcome!.summary);
	}
	const human = batch.find((record) => record.status === "waiting");
	if (human) {
		return pause(state, "report", human.outcome!.summary);
	}
	closeLoops(state, batch);
	advance(state);
	return state.mode === "semi" && state.status === "ready"
		? pause(
				state,
				"semi",
				"Review the completed batch. Reply with instructions to continue, or abandon to stop.",
			)
		: state;
};

/** Only declared human checkpoints and semi/mode choices can continue without a restart. */
export const answerCheckpoint = (
	input: EngineState,
	answer: string,
): EngineState => {
	if (
		input.status !== "waiting" ||
		!["mode", "human", "semi"].includes(input.pause?.kind ?? "")
	) {
		throw new Error(
			"This pause requires an explicit restart or abandon decision",
		);
	}
	if (!answer.trim()) {
		throw new Error("Checkpoint answer must not be empty");
	}
	const state = structuredClone(input);
	if (state.pause!.kind === "mode") {
		const mode = answer.trim().toLowerCase();
		if (mode !== "semi" && mode !== "auto") {
			throw new Error("Reply semi or auto to choose develop mode");
		}
		state.mode = mode;
	} else if (state.pause!.kind === "human") {
		const record = state.records.find(
			(entry) => entry.kind === "human" && entry.status === "waiting",
		)!;
		record.status = "completed";
		record.answer = answer;
	}
	return advance(state);
};

/** Cancellation never rewinds a record; interrupted effects require an external decision. */
export const interruptEngine = (
	input: EngineState,
	message = "Work was interrupted; effects may already have occurred.",
): EngineState => {
	const state = structuredClone(input);
	state.records
		.filter((record) => record.status === "running")
		.forEach((record) => {
			record.status = "interrupted";
		});
	state.activeBatch = null;
	return pause(state, "interrupted", message);
};

/** Identity fields must match compilation exactly, independently of execution results. */
const topology = ({
	id,
	kind,
	batch,
	role,
	prompt,
	loops,
}: ExecutionRecord) => ({ id, kind, batch, role, prompt, loops });

/** Parse and verify graph identities before accepting persisted execution data. */
// oxlint-disable-next-line max-statements -- Cross-field invariants are checked together at the checkpoint boundary.
export const parseEngineState = (input: unknown): EngineState => {
	const state = EngineState.parse(
		typeof input === "string" ? JSON.parse(input) : input,
	);
	const compiled = compileWorkflow(state.workflow, state.command);
	if (
		JSON.stringify(compiled.map(topology)) !==
		JSON.stringify(state.records.map(topology))
	) {
		throw new Error("Checkpoint records do not match the pinned workflow");
	}
	for (const record of state.records) {
		if (
			record.kind === "agent" &&
			record.status === "completed" &&
			(record.outcome?.status !== "completed" || record.error)
		) {
			throw new Error("Completed agent requires a completed report");
		}
		if (
			record.kind === "human" &&
			record.status === "completed" &&
			!record.answer?.trim()
		) {
			throw new Error("Completed checkpoint requires a human answer");
		}
		if (
			record.status === "running" &&
			(state.status !== "running" || record.batch !== state.activeBatch)
		) {
			throw new Error("Running record requires an active batch");
		}
	}
	if ((state.status === "running") !== (state.activeBatch !== null)) {
		throw new Error("Invalid active batch");
	}
	if (
		state.status === "completed" &&
		state.records.some(
			(record) => !["completed", "skipped"].includes(record.status),
		)
	) {
		throw new Error("Unfinished records in completed workflow");
	}
	if (
		["waiting", "blocked", "interrupted"].includes(state.status) !==
		(state.pause !== null)
	) {
		throw new Error("Invalid checkpoint pause");
	}
	const unfinished = state.records.filter(
		(record) => !["completed", "skipped"].includes(record.status),
	);
	const kind = state.pause?.kind;
	if (
		state.command === "develop" &&
		state.mode === null &&
		(state.records.some((record) => record.status !== "pending") ||
			(kind !== "mode" && kind !== "interrupted"))
	) {
		throw new Error("Develop checkpoint has no explicit mode");
	}
	if (state.status === "ready" || kind === "semi") {
		if (
			unfinished[0]?.kind !== "agent" ||
			unfinished.some((record) => record.status !== "pending") ||
			(kind === "semi" && state.mode !== "semi")
		) {
			throw new Error("Ready checkpoint would bypass unfinished work");
		}
	}
	if (
		kind === "human" &&
		(unfinished[0]?.kind !== "human" ||
			unfinished[0].status !== "waiting" ||
			unfinished.slice(1).some((record) => record.status !== "pending"))
	) {
		throw new Error("Invalid human checkpoint");
	}
	if (
		kind === "report" &&
		!unfinished.some(
			(record) =>
				record.status === "waiting" && record.outcome?.status === "needs_human",
		)
	) {
		throw new Error("Missing needs_human report");
	}
	if (
		(state.status === "blocked" && kind !== "failure") ||
		(state.status === "interrupted" && kind !== "interrupted") ||
		(state.status === "waiting" &&
			!["human", "mode", "semi", "report"].includes(kind!))
	) {
		throw new Error("Checkpoint pause does not match state");
	}
	return state;
};

/** JSON serialization is explicit and validates completed-output provenance. */
export const serializeEngine = (state: EngineState): string =>
	JSON.stringify(parseEngineState(state));

/** Restore performs no work and never requeues an in-flight effect. */
export const restoreEngine = (input: unknown): EngineState => {
	const state = parseEngineState(input);
	return state.status === "running" ? interruptEngine(state) : state;
};
