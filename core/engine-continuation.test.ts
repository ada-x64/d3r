/* oxlint-disable no-magic-numbers -- Iteration counts and indices are test fixtures. */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { Workflow } from "./schema.ts";
import {
	type EngineState,
	type ExecutionRecord,
	type WorkflowOutcome,
	answerCheckpoint,
	beginBatch,
	createEngine,
	interruptEngine,
	parseEngineState,
	recordOutcome,
	restoreEngine,
	resumeInterruptedBatch,
	resumeReportedBatch,
	serializeEngine,
	settleBatch,
} from "./engine.ts";

/** Keep continuation tied to the production develop graph. */
const workflow = Workflow.parse(
	parse(readFileSync(new URL("workflow.yaml", import.meta.url), "utf8")),
);
/** Parallel reviewers expose retained decisions and a mandatory post-loop checkpoint. */
const parallelReview: Workflow = {
	commands: {
		test: {
			description: "Parallel review before audit",
			chain: [
				{
					kind: "loop",
					max: 2,
					body: [{ kind: "parallel", agents: ["reviewer", "reviewer"] }],
				},
				{ kind: "human", prompt: "Confirm the reviews before auditing" },
				{ kind: "agent", name: "auditor" },
			],
		},
	},
	vault: { dirs: [], template_kinds: [] },
};
/** Completion alone does not imply approval or allDone. */
const done = (
	summary: string,
	extra: Partial<WorkflowOutcome> = {},
): WorkflowOutcome => ({ status: "completed", summary, ...extra });
/** Report only active children, then explicitly cross the settlement barrier. */
const finishBatch = (
	input: EngineState,
	outcome = done("Finished activity"),
): EngineState =>
	settleBatch(
		input.records
			.filter((record) => record.status === "running")
			.reduce(
				(state, record) => recordOutcome(state, record.id, { outcome }),
				input,
			),
	);
/** The normal cancellation path supplies an explicit develop mode. */
const interruptedDevelop = (): EngineState =>
	interruptEngine(beginBatch(createEngine(workflow, "develop", "auto")));
/** Capture a partial parallel batch with either declaration slot already completed. */
const interruptedReview = (
	outcome = done("Saved review", { review: "approved" }),
	savedSlot = 0,
): EngineState => {
	const running = beginBatch(createEngine(parallelReview, "test"));
	return interruptEngine(
		recordOutcome(running, running.records[savedSlot].id, { outcome }),
	);
};
/** Assert the entire permitted transition, including immutability and untouched metadata. */
const resume = (input: EngineState): EngineState => {
	const before = structuredClone(input);
	const state = resumeInterruptedBatch(input);
	expect(input).toEqual(before);
	expect(state).toEqual({
		...before,
		status: "running",
		pause: null,
		activeBatch: before.records.find(
			(record) => record.status === "interrupted",
		)!.batch,
		records: before.records.map((record) =>
			record.status === "interrupted"
				? { ...record, status: "running" }
				: record,
		),
	});
	expect(parseEngineState(state)).toEqual(state);
	return state;
};
/** Invalid snapshots must also be rejected without altering their evidence. */
const rejects = (input: EngineState, message?: RegExp): void => {
	const before = structuredClone(input);
	expect(() => resumeInterruptedBatch(input)).toThrow(message);
	expect(input).toEqual(before);
};

describe("interrupted batch continuation", () => {
	it.each(["auto", "semi"] as const)(
		"resumes develop in %s mode without letting allDone bypass review",
		(mode) => {
			const running = beginBatch(
				answerCheckpoint(createEngine(workflow, "develop"), mode),
			);
			const interrupted = interruptEngine(running, "Apply the correction");
			const persisted = restoreEngine(serializeEngine(interrupted));
			const resumed = resume(persisted);
			expect(() => settleBatch(resumed)).toThrow(/not settled/);
			expect(() => beginBatch(resumed)).toThrow(/not ready/);
			rejects(resumed, /not paused on an interrupted batch/);
			const reported = recordOutcome(resumed, resumed.records[0].id, {
				outcome: done("Correction complete", { allDone: true }),
			});
			expect(
				reported.records
					.slice(1)
					.every((record) => record.status === "pending"),
			).toBe(true);
			const settled = settleBatch(reported);
			expect(settled.status).toBe(mode === "semi" ? "waiting" : "ready");
			expect(settled.pause?.kind).toBe(mode === "semi" ? "semi" : undefined);
			expect(
				settled.records.slice(1).every((record) => record.status === "pending"),
			).toBe(true);
			expect(settled.records.at(-1)).toMatchObject({
				role: "auditor",
				status: "pending",
			});
			const review = beginBatch(
				mode === "semi"
					? answerCheckpoint(settled, "Review the correction")
					: settled,
			);
			expect(
				review.records.find((record) => record.status === "running")?.role,
			).toBe("reviewer");
			const approved = finishBatch(
				review,
				done("Correction approved", { review: "approved" }),
			);
			expect(
				approved.records
					.slice(2, -1)
					.every((record) => record.status === "skipped"),
			).toBe(true);
			const audit = beginBatch(
				mode === "semi"
					? answerCheckpoint(approved, "Audit the correction")
					: approved,
			);
			expect(
				audit.records.find((record) => record.status === "running")?.role,
			).toBe("auditor");
			expect(finishBatch(audit).status).toBe("completed");
			expect(persisted).toEqual(interrupted);
			expect(resumed.records[0].status).toBe("running");
		},
	);

	it("keeps review changes_requested after allDone and advances only after settlement", () => {
		const implemented = finishBatch(
			beginBatch(createEngine(workflow, "develop", "auto")),
			done("Implementation complete", { allDone: true }),
		);
		const resumed = resume(interruptEngine(beginBatch(implemented)));
		const reviewer = resumed.records.find(
			(record) => record.status === "running",
		)!;
		expect(reviewer.role).toBe("reviewer");
		const reported = recordOutcome(resumed, reviewer.id, {
			outcome: done("Fix the cancellation race", {
				review: "changes_requested",
			}),
		});
		expect(
			reported.records.find((record) => record.kind === "loop_end")?.status,
		).toBe("pending");
		const next = beginBatch(settleBatch(reported));
		expect(
			next.records.find((record) => record.status === "running"),
		).toMatchObject({
			role: "implementor",
			loops: [{ id: "develop/0", iteration: 2, max: 3 }],
		});
		const approved = finishBatch(
			beginBatch(finishBatch(next)),
			done("Correction reviewed", { review: "approved" }),
		);
		expect(
			approved.records.find((record) => record.id === reviewer.id)?.outcome,
		).toEqual(
			reported.records.find((record) => record.id === reviewer.id)?.outcome,
		);
		const audit = beginBatch(approved);
		expect(
			audit.records.find((record) => record.status === "running")?.role,
		).toBe("auditor");
		expect(finishBatch(audit).status).toBe("completed");
	});

	it("retains completed iterations and still blocks at develop loop exhaustion", () => {
		let state = createEngine(workflow, "develop", "auto");
		for (let batch = 0; batch < 5; batch++) {
			state = finishBatch(beginBatch(state));
		}
		const resumed = resume(interruptEngine(beginBatch(state)));
		const blocked = finishBatch(
			resumed,
			done("Still needs correction", { review: "changes_requested" }),
		);
		expect(blocked.status).toBe("blocked");
		expect(blocked.pause).toMatchObject({
			kind: "failure",
			message: expect.stringMatching(/exhausted 3/),
		});
		expect(blocked.records.at(-1)).toMatchObject({
			role: "auditor",
			status: "pending",
		});
		rejects(blocked, /not paused on an interrupted batch/);
	});

	it("allows previously completed and skipped loop records before an interrupted auditor", () => {
		const implemented = finishBatch(
			beginBatch(createEngine(workflow, "develop", "auto")),
			done("No implementation left", { allDone: true }),
		);
		const approved = finishBatch(
			beginBatch(implemented),
			done("Reviewed", { review: "approved" }),
		);
		const interrupted = interruptEngine(beginBatch(approved));
		expect(
			interrupted.records.some((record) => record.status === "skipped"),
		).toBe(true);
		const resumed = resume(interrupted);
		expect(resumed.records.slice(0, -1)).toEqual(approved.records.slice(0, -1));
		expect(finishBatch(resumed).status).toBe("completed");
	});

	it.each([0, 1])(
		"preserves completed reviewer slot %s without replay or premature approval",
		(savedSlot) => {
			const interrupted = restoreEngine(
				serializeEngine(interruptedReview(undefined, savedSlot)),
			);
			const resumed = resume(interrupted);
			const saved = resumed.records[savedSlot];
			expect(saved).toEqual(interrupted.records[savedSlot]);
			expect(saved).not.toBe(interrupted.records[savedSlot]);
			expect(saved.outcome).not.toBe(interrupted.records[savedSlot].outcome);
			expect(resumed.workflow).not.toBe(interrupted.workflow);
			expect(resumed.records[savedSlot].loops).not.toBe(
				interrupted.records[savedSlot].loops,
			);
			expect(() =>
				recordOutcome(resumed, saved.id, { outcome: done("Replay") }),
			).toThrow(/not in the active batch/);
			expect(() => settleBatch(resumed)).toThrow(/not settled/);
			expect(
				resumed.records.slice(2).every((record) => record.status === "pending"),
			).toBe(true);
			const waiting = finishBatch(
				resumed,
				done("Second review approved", { review: "approved" }),
			);
			expect(waiting.pause?.kind).toBe("human");
			expect(
				waiting.records.find((record) => record.kind === "human")?.status,
			).toBe("waiting");
			expect(waiting.records.at(-1)?.status).toBe("pending");
			expect(() => beginBatch(waiting)).toThrow(/not ready/);
			const answered = answerCheckpoint(waiting, "Audit the agreed correction");
			const audit = resume(interruptEngine(beginBatch(answered)));
			expect(
				audit.records.find((record) => record.kind === "human")?.answer,
			).toBe("Audit the agreed correction");
			expect(finishBatch(audit).status).toBe("completed");
		},
	);

	it.each([
		["approved", "changes_requested"],
		["changes_requested", "approved"],
	] as const)(
		"gives changes_requested precedence with saved %s and resumed %s",
		(savedReview, resumedReview) => {
			const interrupted = interruptedReview(
				done("Saved decision", { review: savedReview }),
			);
			const resumed = resume(interrupted);
			const next = finishBatch(
				resumed,
				done("Corrected decision", { review: resumedReview }),
			);
			expect(next.status).toBe("ready");
			expect(next.records[0].outcome).toEqual(interrupted.records[0].outcome);
			expect(next.records.some((record) => record.status === "skipped")).toBe(
				false,
			);
			expect(
				next.records.find((record) => record.kind === "human")?.status,
			).toBe("pending");
			const nextBatch = beginBatch(next);
			expect(
				nextBatch.records
					.filter((record) => record.status === "running")
					.map((record) => record.loops[0].iteration),
			).toEqual([2, 2]);
			const waiting = finishBatch(
				nextBatch,
				done("Now approved", { review: "approved" }),
			);
			expect(waiting.pause?.kind).toBe("human");
		},
	);

	it.each(["implementor", "reviewer"])(
		"retains allDone conflicts when the completed %s is not replayed",
		(savedRole) => {
			const custom = structuredClone(parallelReview);
			custom.commands.test.chain = [
				{
					kind: "loop",
					max: 1,
					body: [{ kind: "parallel", agents: ["implementor", "reviewer"] }],
				},
				{ kind: "agent", name: "auditor" },
			];
			const running = beginBatch(createEngine(custom, "test"));
			const saved = running.records.find(
				(record) => record.role === savedRole,
			)!;
			const implementor = done("All work done", { allDone: true });
			const reviewer = done("Fix the race", { review: "changes_requested" });
			const interrupted = interruptEngine(
				recordOutcome(running, saved.id, {
					outcome: savedRole === "implementor" ? implementor : reviewer,
				}),
			);
			const resumed = resume(restoreEngine(serializeEngine(interrupted)));
			const blocked = finishBatch(
				resumed,
				savedRole === "implementor" ? reviewer : implementor,
			);
			expect(blocked.records.find((record) => record.id === saved.id)).toEqual(
				interrupted.records.find((record) => record.id === saved.id),
			);
			expect(blocked.status).toBe("blocked");
			expect(
				blocked.records.some((record) => record.status === "skipped"),
			).toBe(false);
			expect(blocked.records.at(-1)).toMatchObject({
				role: "auditor",
				status: "pending",
			});
		},
	);

	it("resumes every interrupted child and keeps the parallel barrier", () => {
		const resumed = resume(
			interruptEngine(beginBatch(createEngine(parallelReview, "test"))),
		);
		expect(
			resumed.records.filter((record) => record.status === "running"),
		).toHaveLength(2);
		const partial = recordOutcome(resumed, resumed.records[1].id, {
			outcome: done("Second finished", { review: "approved" }),
		});
		expect(() => settleBatch(partial)).toThrow(/not settled/);
		const interruptedAgain = interruptEngine(partial);
		const continuedAgain = resume(interruptedAgain);
		expect(continuedAgain.records[1]).toEqual(partial.records[1]);
		expect(finishBatch(continuedAgain).pause?.kind).toBe("human");
	});

	it("restores an in-flight snapshot before explicitly resuming only its interrupted child", () => {
		const running = beginBatch(createEngine(parallelReview, "test"));
		const partial = recordOutcome(running, running.records[0].id, {
			outcome: done("Saved before disconnect"),
		});
		const restored = restoreEngine(serializeEngine(partial));
		expect(restored.records.slice(0, 2).map((record) => record.status)).toEqual(
			["completed", "interrupted"],
		);
		const resumed = resume(restored);
		expect(resumed.records[0].outcome?.summary).toBe("Saved before disconnect");
	});

	it("preserves existing later skip markers without making new loop decisions", () => {
		const interrupted = interruptedDevelop();
		interrupted.records.find((record) => record.kind === "loop_end")!.status =
			"skipped";
		const resumed = resume(interrupted);
		expect(
			resumed.records.filter((record) => record.status === "skipped"),
		).toHaveLength(1);
		expect(resumed.records.at(-1)?.status).toBe("pending");
	});
});

/** A request for input is not approval, even if it carries completion hints. */
const needsHuman: WorkflowOutcome = {
	status: "needs_human",
	summary: "Confirm the cancellation policy",
	review: "approved",
	allDone: true,
};
/** Retain a review finding while its parallel sibling waits for the user. */
const reportedReview = (
	input = createEngine(parallelReview, "test"),
): EngineState => {
	const running = beginBatch(input);
	const saved = running.records.find((record) => record.status === "running")!;
	return finishBatch(
		recordOutcome(running, saved.id, {
			outcome: done("Fix the race", { review: "changes_requested" }),
		}),
		needsHuman,
	);
};
/** Rejected report continuations must retain the original failure evidence. */
const rejectsReport = (input: EngineState): void => {
	const before = structuredClone(input);
	expect(() => resumeReportedBatch(input)).toThrow();
	expect(input).toEqual(before);
};

describe("reported batch continuation", () => {
	it("requires a fresh report after an explicit develop continuation without bypassing review", () => {
		const running = beginBatch(createEngine(workflow, "develop", "semi"));
		const waiting = restoreEngine(
			serializeEngine(finishBatch(running, needsHuman)),
		);
		waiting.records[0].error = undefined;
		const before = structuredClone(waiting);
		expect(waiting.pause?.kind).toBe("report");
		expect(() =>
			answerCheckpoint(waiting, "Keep cancellation local"),
		).toThrow();
		const resumed = resumeReportedBatch(waiting);
		expect(waiting).toEqual(before);
		expect(resumed).toEqual(running);
		expect(resumed.records[0]).not.toHaveProperty("outcome");
		expect(resumed.records[0]).not.toHaveProperty("error");
		expect(parseEngineState(resumed)).toEqual(resumed);
		expect(() => settleBatch(resumed)).toThrow(/not settled/);
		const missing = settleBatch(
			recordOutcome(resumed, resumed.records[0].id, {}),
		);
		expect(missing.pause?.kind).toBe("failure");
		const implemented = finishBatch(
			resumed,
			done("Applied the answer", { allDone: true }),
		);
		expect(implemented.pause?.kind).toBe("semi");
		expect(implemented.records.slice(1)).toEqual(waiting.records.slice(1));
		const review = beginBatch(
			answerCheckpoint(implemented, "Review the result"),
		);
		expect(
			review.records.find((record) => record.status === "running")?.role,
		).toBe("reviewer");
		const approved = finishBatch(
			review,
			done("Reviewed", { review: "approved" }),
		);
		const audit = beginBatch(answerCheckpoint(approved, "Audit it"));
		expect(finishBatch(audit).status).toBe("completed");
		expect(waiting).toEqual(before);
	});

	it("preserves completed parallel findings and lets settlement apply their conflict", () => {
		const waiting = restoreEngine(serializeEngine(reportedReview()));
		const before = structuredClone(waiting);
		const resumed = resumeReportedBatch(waiting);
		expect(resumed).toMatchObject({
			status: "running",
			pause: null,
			activeBatch: waiting.records[1].batch,
		});
		expect(resumed.records[0]).toEqual(waiting.records[0]);
		expect(resumed.records[0].outcome).not.toBe(waiting.records[0].outcome);
		expect(resumed.records[1]).toEqual({
			...waiting.records[1],
			status: "running",
			outcome: undefined,
		});
		expect(resumed.records[1]).not.toHaveProperty("outcome");
		expect(resumed.records.slice(2)).toEqual(waiting.records.slice(2));
		expect(() =>
			recordOutcome(resumed, resumed.records[0].id, {
				outcome: done("Replay"),
			}),
		).toThrow(/not in the active batch/);
		const next = finishBatch(
			resumed,
			done("Question answered", { review: "approved" }),
		);
		expect(next.records[0]).toEqual(waiting.records[0]);
		expect(next.records.some((record) => record.status === "skipped")).toBe(
			false,
		);
		expect(
			beginBatch(next)
				.records.filter((record) => record.status === "running")
				.map((record) => record.loops[0].iteration),
		).toEqual([2, 2]);
		expect(waiting).toEqual(before);
	});

	it("waits for every resumed child and retains settled history through a later report pause", () => {
		const waiting = finishBatch(
			beginBatch(createEngine(parallelReview, "test")),
			needsHuman,
		);
		const resumed = resumeReportedBatch(waiting);
		expect(
			resumed.records.filter((record) => record.status === "running"),
		).toHaveLength(2);
		expect(
			resumed.records.every((record) => !Object.hasOwn(record, "outcome")),
		).toBe(true);
		const partial = recordOutcome(resumed, resumed.records[1].id, {
			outcome: done("Second approved", { review: "approved" }),
		});
		expect(() => settleBatch(partial)).toThrow(/not settled/);
		const checkpoint = finishBatch(
			partial,
			done("First approved", { review: "approved" }),
		);
		expect(checkpoint.pause?.kind).toBe("human");
		expect(checkpoint.records.at(-1)?.status).toBe("pending");
		const audit = beginBatch(
			answerCheckpoint(checkpoint, "Audit the confirmed policy"),
		);
		const auditQuestion = finishBatch(audit, needsHuman);
		const continuedAudit = resumeReportedBatch(auditQuestion);
		expect(continuedAudit.records.slice(0, -1)).toEqual(
			auditQuestion.records.slice(0, -1),
		);
		expect(
			continuedAudit.records.some((record) => record.status === "skipped"),
		).toBe(true);
		expect(finishBatch(continuedAudit).status).toBe("completed");
	});

	it("rejects other pauses, blocked siblings, and waiting children without clean needs_human reports", () => {
		rejectsReport(interruptedDevelop());
		rejectsReport(createEngine(workflow, "develop"));
		rejectsReport(finishBatch(beginBatch(createEngine(workflow, "design"))));
		rejectsReport(
			finishBatch(beginBatch(createEngine(workflow, "develop", "auto")), {
				status: "blocked",
				summary: "Cannot proceed",
			}),
		);
		const waiting = finishBatch(
			beginBatch(createEngine(parallelReview, "test")),
			needsHuman,
		);
		const corruptions: ((state: EngineState) => void)[] = [
			(state) => {
				state.records[0].outcome = done("Not a request for input");
			},
			(state) => {
				delete state.records[0].outcome;
			},
			(state) => {
				state.records[0].error = "";
			},
			(state) => {
				state.records[0].status = "blocked";
			},
			(state) => {
				state.records[0].status = "pending";
			},
			(state) => {
				state.records[0].status = "skipped";
			},
		];
		for (const corrupt of corruptions) {
			const invalid = structuredClone(waiting);
			corrupt(invalid);
			rejectsReport(invalid);
		}
		const completed = finishBatch(
			beginBatch(createEngine(parallelReview, "test")),
			done("Reviewed", { review: "approved" }),
		);
		completed.pause!.kind = "report";
		rejectsReport(completed);
	});

	it("preflights topology and rejects continuations across unfinished or later settled work", () => {
		const next = finishBatch(
			beginBatch(createEngine(parallelReview, "test")),
			done("Rework needed", { review: "changes_requested" }),
		);
		const waiting = reportedReview(next);
		const corruptions: ((state: EngineState) => void)[] = [
			(state) => {
				state.records[0].batch = "foreign";
			},
			(state) => {
				state.records[0].status = "pending";
			},
			(state) => {
				state.records[0].status = "waiting";
				state.records[0].outcome = needsHuman;
			},
			(state) => {
				state.records.at(-1)!.status = "completed";
				state.records.at(-1)!.outcome = done("Out-of-order audit");
			},
			(state) => {
				state.records.at(-1)!.status = "waiting";
				state.records.at(-1)!.outcome = needsHuman;
			},
		];
		for (const corrupt of corruptions) {
			const invalid = structuredClone(waiting);
			corrupt(invalid);
			rejectsReport(invalid);
		}
	});
});

describe("interrupted batch rejection", () => {
	it.each<[string, () => EngineState]>([
		["mode choice", () => createEngine(workflow, "develop")],
		["ready", () => createEngine(workflow, "develop", "auto")],
		["running", () => beginBatch(createEngine(workflow, "develop", "auto"))],
		[
			"semi pause",
			() => finishBatch(beginBatch(createEngine(workflow, "develop", "semi"))),
		],
		[
			"human checkpoint",
			() => finishBatch(beginBatch(createEngine(workflow, "design"))),
		],
		[
			"failure pause",
			() =>
				finishBatch(beginBatch(createEngine(workflow, "develop", "auto")), {
					status: "blocked",
					summary: "Cannot continue",
				}),
		],
		[
			"report pause",
			() =>
				finishBatch(beginBatch(createEngine(workflow, "develop", "auto")), {
					status: "needs_human",
					summary: "Need a decision",
				}),
		],
		[
			"completed workflow",
			() =>
				finishBatch(
					beginBatch(
						finishBatch(beginBatch(createEngine(workflow, "delegate"))),
					),
				),
		],
	])("rejects %s instead of guessing a continuation", (_name, create) => {
		rejects(create(), /not paused on an interrupted batch/);
	});

	it.each<[string, () => EngineState]>([
		[
			"unselected mode",
			() => interruptEngine(createEngine(workflow, "develop")),
		],
		[
			"unstarted batch",
			() => interruptEngine(createEngine(workflow, "develop", "auto")),
		],
		[
			"waiting checkpoint",
			() =>
				interruptEngine(
					finishBatch(beginBatch(createEngine(workflow, "design"))),
				),
		],
		[
			"all children completed before settlement",
			() => {
				const running = beginBatch(createEngine(workflow, "develop", "auto"));
				return interruptEngine(
					recordOutcome(running, running.records[0].id, {
						outcome: done("Already completed", { allDone: true }),
					}),
				);
			},
		],
		[
			"all work completed",
			() =>
				interruptEngine(
					finishBatch(
						beginBatch(
							finishBatch(beginBatch(createEngine(workflow, "delegate"))),
						),
					),
				),
		],
	])(
		"rejects interrupted state with %s but no interrupted agents",
		(_name, create) => {
			rejects(create(), /No interrupted agents/);
		},
	);

	it.each<[string, (state: EngineState) => void]>([
		[
			"missing pause",
			(state) => {
				state.pause = null;
			},
		],
		[
			"failure pause",
			(state) => {
				state.pause!.kind = "failure";
			},
		],
		[
			"wrong status",
			(state) => {
				state.status = "waiting";
			},
		],
		[
			"stale active batch",
			(state) => {
				state.activeBatch = state.records[0].batch;
			},
		],
		[
			"missing develop mode",
			(state) => {
				state.mode = null;
			},
		],
		[
			"incomplete snapshot",
			(state) => {
				Reflect.deleteProperty(state, "workflow");
			},
		],
	])(
		"preflights %s without mutating the invalid snapshot",
		(_name, corrupt) => {
			const interrupted = interruptedDevelop();
			corrupt(interrupted);
			rejects(interrupted);
		},
	);

	it.each<[string, (state: EngineState) => void]>([
		[
			"reordered records",
			(state) => {
				state.records.reverse();
			},
		],
		[
			"missing record",
			(state) => {
				state.records.pop();
			},
		],
		[
			"duplicate identity",
			(state) => {
				state.records[1].id = state.records[0].id;
			},
		],
		[
			"foreign batch",
			(state) => {
				state.records[0].batch = "foreign";
			},
		],
		[
			"changed role",
			(state) => {
				state.records[0].role = "auditor";
			},
		],
		[
			"changed loop scope",
			(state) => {
				state.records[0].loops[0].iteration = 2;
			},
		],
		[
			"non-agent sibling",
			(state) => {
				state.records[0].kind = "human";
			},
		],
	])("rejects malformed topology: %s", (_name, corrupt) => {
		const interrupted = interruptedReview();
		corrupt(interrupted);
		rejects(interrupted, /pinned workflow/);
	});

	it.each<[string, (state: EngineState) => void]>([
		[
			"missing completed report",
			(state) => {
				delete state.records[0].outcome;
			},
		],
		[
			"blocked report marked completed",
			(state) => {
				state.records[0].outcome!.status = "blocked";
			},
		],
		[
			"completed report with an error",
			(state) => {
				state.records[0].error = "Failed after reporting";
			},
		],
	])("rejects %s on a retained sibling", (_name, corrupt) => {
		const interrupted = interruptedReview();
		corrupt(interrupted);
		rejects(interrupted, /completed report/);
	});

	it.each<ExecutionRecord["status"]>([
		"pending",
		"skipped",
		"blocked",
		"waiting",
		"running",
	])("rejects a %s sibling rather than resetting it", (status) => {
		const interrupted = interruptedReview();
		interrupted.records[0].status = status;
		delete interrupted.records[0].outcome;
		rejects(interrupted);
	});

	it.each(["blocked", "needs_human"] as const)(
		"rejects a real %s sibling even when interrupted after its report",
		(status) => {
			const interrupted = interruptedReview({
				status,
				summary: "Unresolved review",
				review: "approved",
			});
			rejects(interrupted, /cannot bypass/);
		},
	);

	it.each<ExecutionRecord["status"]>([
		"pending",
		"waiting",
		"blocked",
		"interrupted",
		"running",
	])("rejects earlier %s work outside the interrupted batch", (status) => {
		const implemented = finishBatch(
			beginBatch(createEngine(workflow, "develop", "auto")),
		);
		const interrupted = interruptEngine(beginBatch(implemented));
		interrupted.records[0].status = status;
		delete interrupted.records[0].outcome;
		rejects(interrupted);
	});

	it.each<ExecutionRecord["status"]>([
		"completed",
		"waiting",
		"blocked",
		"interrupted",
		"running",
	])("rejects later %s work outside the interrupted batch", (status) => {
		const interrupted = interruptedDevelop();
		const later = interrupted.records.at(-1)!;
		later.status = status;
		if (status === "completed") {
			later.outcome = done("Out-of-order audit");
		}
		rejects(interrupted);
	});

	it.each(["pending", "waiting"] as const)(
		"does not bypass an earlier %s human checkpoint",
		(status) => {
			const interrupted = interruptEngine(
				finishBatch(beginBatch(createEngine(workflow, "design"))),
			);
			interrupted.records.find((record) => record.kind === "human")!.status =
				status;
			interrupted.records.at(-1)!.status = "interrupted";
			rejects(interrupted, /cannot bypass/);
		},
	);

	it("does not bypass a pending loop boundary to resume the next iteration", () => {
		const implemented = finishBatch(
			beginBatch(createEngine(workflow, "develop", "auto")),
		);
		const next = finishBatch(beginBatch(implemented));
		const interrupted = interruptEngine(beginBatch(next));
		interrupted.records.find((record) => record.kind === "loop_end")!.status =
			"pending";
		rejects(interrupted, /cannot bypass/);
	});

	it.each(["human", "loop_end"] as const)(
		"does not treat an interrupted %s as an interrupted agent",
		(kind) => {
			const interrupted = interruptEngine(createEngine(parallelReview, "test"));
			interrupted.records.find((record) => record.kind === kind)!.status =
				"interrupted";
			rejects(interrupted, /No interrupted agents/);
		},
	);
});
