import {
	type EngineState,
	resumeInterruptedBatch,
	resumeReportedBatch,
	restartBlockedBatch,
} from "@d3r/core/engine";
import { z } from "zod";

/** Child checkpoints contain data only; each backend still validates its own format. */
export type WorkflowJson =
	| null
	| boolean
	| number
	| string
	| WorkflowJson[]
	| { [key: string]: WorkflowJson };
/** Parse backend data after native restore's bounded, accessor-free copy. */
export const WorkflowJsonValue: z.ZodType<WorkflowJson> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(WorkflowJsonValue),
		z.record(WorkflowJsonValue),
	]),
);
/** Match the engine's bounded graph rather than allowing unlimited saved children. */
const MAX_CONTINUATIONS = 10_000;
/** Paused roles retain transcripts, not live sessions; older blocked tasks may lack one. */
export const WorkflowContinuations = z
	.array(
		z
			.object({
				recordId: z.string(),
				checkpoint: WorkflowJsonValue,
			})
			.strict(),
	)
	.max(MAX_CONTINUATIONS);
/** Typed, detached role state owned by a workflow, never live runtime objects. */
export type WorkflowContinuation = z.infer<
	typeof WorkflowContinuations
>[number];
/** Trusted runtime snapshots use JSON persistence semantics for optional undefined fields. */
export const snapshotWorkflowJson = (value: unknown): WorkflowJson =>
	// oxlint-disable-next-line prefer-structured-clone -- structuredClone retains undefined properties that JSON persistence omits.
	WorkflowJsonValue.parse(JSON.parse(JSON.stringify(value)));

/** Continuations cannot attach to completed work or a different pinned graph. */
export const validateContinuations = (
	engine: EngineState | null,
	rows: readonly WorkflowContinuation[],
	orchestrated: boolean,
): void => {
	const paused =
		engine && ["waiting", "blocked", "interrupted"].includes(engine.status);
	if (
		new Set(rows.map(({ recordId }) => recordId)).size !== rows.length ||
		rows.some(
			({ recordId }) =>
				!orchestrated ||
				!paused ||
				!engine?.records.some(
					(record) =>
						record.id === recordId &&
						record.kind === "agent" &&
						(record.status === "interrupted" ||
							record.status === "blocked" ||
							(record.status === "waiting" &&
								record.outcome?.status === "needs_human" &&
								!record.error)),
				),
		)
	) {
		throw new Error("Invalid interrupted role continuations");
	}
};
/** Select the pure transition without changing task identity or replaying completed roles. */
export const resumeWorkflow = (engine: EngineState): EngineState => {
	switch (engine.status) {
		case "blocked": {
			return restartBlockedBatch(engine);
		}
		case "interrupted": {
			return resumeInterruptedBatch(engine);
		}
		default: {
			return resumeReportedBatch(engine);
		}
	}
};

/** A blocked task can restart with a fresh worker; other continuations require retained transcripts. */
export const canResumeWorkflow = (
	engine: EngineState | null,
	rows: readonly WorkflowContinuation[],
): boolean => {
	if (
		!engine ||
		(engine.status !== "blocked" &&
			engine.status !== "interrupted" &&
			!(engine.status === "waiting" && engine.pause?.kind === "report"))
	) {
		return false;
	}
	try {
		const resumed = resumeWorkflow(engine);
		return (
			engine.status === "blocked" ||
			resumed.records
				.filter(({ status }) => status === "running")
				.every(({ id }) => rows.some(({ recordId }) => recordId === id))
		);
	} catch {
		return false;
	}
};
/** Bound model-facing status independently of complete persisted role outcomes. */
const EVIDENCE_LIMITS = { records: 16, characters: 65_536 };
/** Phase tool results and each orchestrator turn receive current state, not inferred state. */
export const describeWorkflowState = (
	engine: EngineState | null,
	{
		phase,
		resumable,
		standaloneRole,
	}: { phase: string; resumable: boolean; standaloneRole?: string },
): string => {
	if (!engine) {
		return `No active workflow. Preferred phase: ${phase} (routing preference, not a requirement). Choose direct tools, a worker, or any configured phase to fit the user's current request; no prior phase or vault documents are required. Routine vault maintenance needs no phase or semi/auto mode.`;
	}
	const evidence = engine.records
		.filter((record) => record.outcome || record.error)
		.slice(-EVIDENCE_LIMITS.records)
		.map(
			(record) =>
				`### ${record.role ?? "Step"} (${record.status})\n${record.error ?? record.outcome?.summary ?? ""}`,
		)
		.join("\n\n");
	const recovery =
		engine.status === "blocked"
			? "Blocked roles can be restarted with d3r_continue_phase using the user's correction or retry request. No abandonment, new topic, or mode selection is required. Reuse retained worker conversations where available; otherwise create a fresh same-role conversation from the brief and prior outcomes, and inspect the current working diff before continuing. Completed siblings and pending human decisions are preserved; do not replay historical tool calls."
			: "The unfinished roles have retained conversations and settled tool results. The user's answer, correction, or explicit continue can resume only those roles; completed roles are not replayed. Use the latest instructions and inspect existing changes when needed.";
	return [
		standaloneRole
			? `## Role: ${standaloneRole}\nStatus: ${engine.status}\nMode: ${engine.mode ?? "standalone"}\nThis is an independent role task, not completion or approval of a phase.`
			: `## Phase: ${engine.command}\nStatus: ${engine.status}\nMode: ${engine.mode ?? "not selected"}`,
		engine.pause?.message ?? "",
		evidence.slice(0, EVIDENCE_LIMITS.characters),
		evidence.length > EVIDENCE_LIMITS.characters
			? "[Role evidence truncated for this status report.]"
			: "",
		resumable ? recovery : "",
		engine.status === "interrupted" && !resumable
			? "This workflow lacks a resumable checkpoint. Discuss its recovery rather than rerunning completed steps. This does not disable unrelated inspection, requested vault maintenance, or explicitly requested operational commands."
			: "",
		["waiting", "blocked", "interrupted"].includes(engine.status)
			? "Return control to the user for workflow decisions. Do not advance, restart, or abandon the workflow without their direction. A paused workflow does not disable requested vault maintenance or explicitly requested operational commands."
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
};
