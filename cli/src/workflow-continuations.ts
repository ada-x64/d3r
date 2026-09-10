import {
	type EngineState,
	resumeInterruptedBatch,
	resumeReportedBatch,
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
/** Interrupted and clarification-seeking roles retain transcripts, not live sessions. */
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
							(record.status === "waiting" &&
								record.outcome?.status === "needs_human" &&
								!record.error)),
				),
		)
	) {
		throw new Error("Invalid interrupted role continuations");
	}
};
/** Resuming is an explicit decision and requires evidence for every unfinished role. */
export const canResumeWorkflow = (
	engine: EngineState | null,
	rows: readonly WorkflowContinuation[],
): boolean => {
	if (
		!engine ||
		(engine.status !== "interrupted" &&
			!(engine.status === "waiting" && engine.pause?.kind === "report"))
	) {
		return false;
	}
	try {
		const resumed =
			engine.status === "interrupted"
				? resumeInterruptedBatch(engine)
				: resumeReportedBatch(engine);
		return resumed.records
			.filter(({ status }) => status === "running")
			.every(({ id }) => rows.some(({ recordId }) => recordId === id));
	} catch {
		return false;
	}
};
/** Bound model-facing status independently of complete persisted role outcomes. */
const EVIDENCE_LIMITS = { records: 16, characters: 65_536 };
/** Phase tool results and each orchestrator turn receive current state, not inferred state. */
export const describeWorkflowState = (
	engine: EngineState | null,
	{ phase, resumable }: { phase: string; resumable: boolean },
): string => {
	if (!engine) {
		return `No active workflow. Selected phase: ${phase}. Any configured phase may start independently; no prior phase or vault documents are required.`;
	}
	const evidence = engine.records
		.filter((record) => record.outcome || record.error)
		.slice(-EVIDENCE_LIMITS.records)
		.map(
			(record) =>
				`### ${record.role ?? "Step"} (${record.status})\n${record.error ?? record.outcome?.summary ?? ""}`,
		)
		.join("\n\n");
	return [
		`## Phase: ${engine.command}\nStatus: ${engine.status}\nMode: ${engine.mode ?? "not selected"}`,
		engine.pause?.message ?? "",
		evidence.slice(0, EVIDENCE_LIMITS.characters),
		evidence.length > EVIDENCE_LIMITS.characters
			? "[Role evidence truncated for this status report.]"
			: "",
		resumable
			? "The unfinished roles have retained conversations and settled tool results. The user's answer, correction, or explicit continue can resume only those roles; completed roles are not replayed. Inspect current state before more effects."
			: "",
		engine.status === "interrupted" && !resumable
			? "Safe role continuation is unavailable. Do not resume or replay effects. Discuss recovery with the user; abandon only at their direction."
			: "",
		["waiting", "blocked", "interrupted"].includes(engine.status)
			? "Return control to the user. Do not answer this checkpoint, restart, or abandon on their behalf."
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
};
