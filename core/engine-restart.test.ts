/* oxlint-disable no-magic-numbers -- Iteration counts and indices are test fixtures. */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { Workflow, type ChainStep } from "./schema.ts";
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
	restartBlockedBatch,
	resumeInterruptedBatch,
	resumeReportedBatch,
	settleBatch,
} from "./engine.ts";

/** Exercise restart against the shipped develop graph, not a replacement loop. */
const workflow = Workflow.parse(
	parse(readFileSync(new URL("workflow.yaml", import.meta.url), "utf8")),
);
/** Small graphs isolate sibling and checkpoint invariants. */
const graph = (chain: ChainStep[]): Workflow => ({
	commands: { test: { description: "Restart test", chain } },
	vault: { dirs: [], template_kinds: [] },
});
/** Completion alone never establishes loop approval. */
const done = (
	summary = "Activity completed",
	extra: Partial<WorkflowOutcome> = {},
): WorkflowOutcome => ({ status: "completed", summary, ...extra });
/** Stale success hints must not survive a failed attempt. */
const failure = {
	outcome: {
		status: "blocked",
		summary: "Implementation budget exhausted",
		allDone: true,
		review: "approved",
	},
	error: "Stopped after partial effects",
};
/** Drive only active records through the real reporting and settlement APIs, with no effects. */
const finishBatch = (
	input: EngineState,
	result: Parameters<typeof recordOutcome>[2] = { outcome: done() },
): EngineState =>
	settleBatch(
		input.records
			.filter((record) => record.status === "running")
			.reduce(
				(state, record) => recordOutcome(state, record.id, result),
				input,
			),
	);
/** A real failure pause supplies the default rejection fixture. */
const blockedDevelop = (): EngineState =>
	finishBatch(beginBatch(createEngine(workflow, "develop", "auto")), failure);
/** Retain either declaration slot in the shipped parallel discovery batch. */
const blockedDesign = (savedSlot = 0): EngineState => {
	const running = beginBatch(createEngine(workflow, "design"));
	return finishBatch(
		recordOutcome(running, running.records[savedSlot].id, {
			outcome: done("Saved discovery"),
		}),
		failure,
	);
};
/** The contract changes only failed attempts and batch lifecycle, without mutating input. */
const restart = (input: EngineState): EngineState => {
	const before = structuredClone(input);
	const state = restartBlockedBatch(input);
	expect(input).toEqual(before);
	expect(state).toEqual({
		...before,
		status: "running",
		pause: null,
		activeBatch: before.records.find((record) => record.status === "blocked")!
			.batch,
		records: before.records.map((record) => {
			if (record.status !== "blocked") {
				return record;
			}
			const fresh = { ...record, status: "running" };
			delete fresh.outcome;
			delete fresh.error;
			return fresh;
		}),
	});
	expect(parseEngineState(state)).toEqual(state);
	return state;
};
/** Failed preflight must preserve all evidence as well. */
const rejects = (input: EngineState, message?: RegExp): void => {
	const before = structuredClone(input);
	expect(() => restartBlockedBatch(input)).toThrow(message);
	expect(input).toEqual(before);
};

describe("blocked batch restart", () => {
	it.each(["semi", "auto"] as const)(
		"restarts the shipped develop implementor in %s mode, then requires review and audit",
		(mode) => {
			const blocked = finishBatch(
				beginBatch(answerCheckpoint(createEngine(workflow, "develop"), mode)),
				failure,
			);
			expect(blocked.status).toBe("blocked");
			expect(() => answerCheckpoint(blocked, "restart")).toThrow();
			const running = restart(blocked);
			expect(
				running.records
					.filter((record) => record.status === "running")
					.map((record) => record.role),
			).toEqual(["implementor"]);
			expect(() => settleBatch(running)).toThrow(/not settled/);
			rejects(running, /not paused on a blocked batch/);
			const reported = recordOutcome(running, running.records[0].id, {
				outcome: done("Implementation finished", { allDone: true }),
			});
			expect(reported.records.slice(1)).toEqual(blocked.records.slice(1));
			const implemented = settleBatch(reported);
			expect(implemented.records.slice(1)).toEqual(blocked.records.slice(1));
			expect(implemented.status).toBe(mode === "semi" ? "waiting" : "ready");
			expect(implemented.pause?.kind).toBe(
				mode === "semi" ? "semi" : undefined,
			);
			if (mode === "semi") {
				expect(() => beginBatch(implemented)).toThrow(/not ready/);
				rejects(implemented);
			}
			const review = beginBatch(
				mode === "semi"
					? answerCheckpoint(implemented, "Review the implementation")
					: implemented,
			);
			expect(
				review.records
					.filter((record) => record.status === "running")
					.map((record) => record.role),
			).toEqual(["reviewer"]);
			const approved = finishBatch(review, {
				outcome: done("Reviewed", { review: "approved" }),
			});
			expect(
				approved.records
					.slice(2, -1)
					.every((record) => record.status === "skipped"),
			).toBe(true);
			expect(approved.pause?.kind).toBe(mode === "semi" ? "semi" : undefined);
			const audit = beginBatch(
				mode === "semi"
					? answerCheckpoint(approved, "Audit the result")
					: approved,
			);
			expect(
				audit.records
					.filter((record) => record.status === "running")
					.map((record) => record.role),
			).toEqual(["auditor"]);
			expect(finishBatch(audit).status).toBe("completed");
		},
	);

	it.each([
		[
			"blocked report",
			{ outcome: { status: "blocked", summary: "Cannot finish" } },
		],
		["missing report", {}],
		["invalid report", { outcome: { status: "completed", summary: "" } }],
		[
			"error after a completed report",
			{
				outcome: done("Premature success", { allDone: true }),
				error: "Failed after reporting",
			},
		],
	] satisfies [string, Parameters<typeof recordOutcome>[2]][])(
		"requires fresh evidence after %s and can restart another failure",
		(_name, result) => {
			const blocked = finishBatch(
				beginBatch(createEngine(workflow, "develop", "auto")),
				result,
			);
			const running = restart(blocked);
			expect(running.records[0]).not.toHaveProperty("outcome");
			expect(running.records[0]).not.toHaveProperty("error");
			const missing = finishBatch(running, {});
			expect(missing.status).toBe("blocked");
			expect(missing.records[0].error).toMatch(/Missing or invalid d3r_report/);
			const retried = finishBatch(restart(missing));
			expect(retried.status).toBe("ready");
			expect(retried.records.slice(1)).toEqual(blocked.records.slice(1));
		},
	);

	it.each([0, 1])(
		"preserves completed parallel slot %s and the declared human gate",
		(savedSlot) => {
			const blocked = blockedDesign(savedSlot);
			const running = restart(blocked);
			expect(() =>
				recordOutcome(running, running.records[savedSlot].id, {
					outcome: done("Replay"),
				}),
			).toThrow(/not in the active batch/);
			const checkpoint = finishBatch(running);
			expect(checkpoint.records[savedSlot]).toEqual(blocked.records[savedSlot]);
			expect(checkpoint.pause?.kind).toBe("human");
			expect(checkpoint.records.at(-1)?.status).toBe("pending");
			rejects(checkpoint);
			const draft = beginBatch(
				answerCheckpoint(checkpoint, "Use both discoveries"),
			);
			expect(
				draft.records.find((record) => record.status === "running")?.role,
			).toBe("designer");
			expect(finishBatch(draft).status).toBe("completed");
		},
	);

	it("restarts every blocked sibling but waits for the entire batch to report", () => {
		const blocked = finishBatch(
			beginBatch(createEngine(workflow, "design")),
			failure,
		);
		const running = restart(blocked);
		expect(running.records.slice(0, 2).map((record) => record.status)).toEqual([
			"running",
			"running",
		]);
		const partial = recordOutcome(running, running.records[1].id, {
			outcome: done("Second discovery"),
		});
		expect(() => settleBatch(partial)).toThrow(/not settled/);
		const failedAgain = finishBatch(partial, failure);
		const retried = restart(failedAgain);
		expect(retried.records[1]).toEqual(partial.records[1]);
		expect(finishBatch(retried).pause?.kind).toBe("human");
	});

	it("preserves a waiting sibling and pauses for its answer after restarted work settles", () => {
		const custom = graph([
			{
				kind: "loop",
				max: 2,
				body: [
					{
						kind: "parallel",
						agents: ["reviewer", "implementor", "researcher"],
					},
				],
			},
			{ kind: "human", prompt: "Confirm before audit" },
			{ kind: "agent", name: "auditor" },
		]);
		let running = beginBatch(createEngine(custom, "test"));
		running = recordOutcome(running, running.records[0].id, {
			outcome: {
				status: "needs_human",
				summary: "Which acceptance criterion applies?",
				review: "approved",
			},
		});
		running = recordOutcome(running, running.records[2].id, {
			outcome: done("Saved research"),
		});
		const blocked = finishBatch(running, failure);
		const restarted = restart(blocked);
		expect(
			restarted.records.slice(0, 3).map((record) => record.status),
		).toEqual(["waiting", "running", "completed"]);
		expect(() =>
			recordOutcome(restarted, restarted.records[0].id, {
				outcome: done("Unauthorized answer"),
			}),
		).toThrow(/not in the active batch/);
		const waiting = finishBatch(restarted, {
			outcome: done("Implementation finished", { allDone: true }),
		});
		expect(waiting).toMatchObject({
			status: "waiting",
			pause: { kind: "report", message: "Which acceptance criterion applies?" },
			activeBatch: null,
		});
		expect(waiting.records[0]).toEqual(blocked.records[0]);
		expect(waiting.records[2]).toEqual(blocked.records[2]);
		expect(waiting.records.slice(3)).toEqual(blocked.records.slice(3));
		rejects(waiting);
		expect(() => beginBatch(waiting)).toThrow(/not ready/);
		expect(() =>
			answerCheckpoint(waiting, "Use the stricter criterion"),
		).toThrow();
		const answered = resumeReportedBatch(waiting);
		expect(
			answered.records
				.filter((record) => record.status === "running")
				.map((record) => record.role),
		).toEqual(["reviewer"]);
		const checkpoint = finishBatch(answered, {
			outcome: done("Confirmed review", { review: "approved" }),
		});
		expect(checkpoint.pause?.kind).toBe("human");
		const audit = beginBatch(answerCheckpoint(checkpoint, "Audit now"));
		expect(
			audit.records.find((record) => record.status === "running")?.role,
		).toBe("auditor");
		expect(finishBatch(audit).status).toBe("completed");
	});

	it("retains completed reviewer changes_requested against restarted implementor allDone", () => {
		const custom = graph([
			{
				kind: "loop",
				max: 1,
				body: [{ kind: "parallel", agents: ["reviewer", "implementor"] }],
			},
			{ kind: "agent", name: "auditor" },
		]);
		const running = beginBatch(createEngine(custom, "test"));
		const reviewed = recordOutcome(running, running.records[0].id, {
			outcome: done("Fix the race", { review: "changes_requested" }),
		});
		const blocked = finishBatch(reviewed, failure);
		const exhausted = finishBatch(restart(blocked), {
			outcome: done("Finished", { allDone: true }),
		});
		expect(exhausted.records[0]).toEqual(reviewed.records[0]);
		expect(exhausted.status).toBe("blocked");
		expect(exhausted.pause?.message).toMatch(/exhausted 1/);
		expect(exhausted.records.at(-1)?.status).toBe("pending");
		rejects(exhausted, /No blocked agents/);
	});

	it("keeps completed and skipped loop history when restarting the auditor", () => {
		const implemented = finishBatch(
			beginBatch(createEngine(workflow, "develop", "auto")),
		);
		const approved = finishBatch(beginBatch(implemented), {
			outcome: done("Approved", { review: "approved" }),
		});
		const blocked = finishBatch(beginBatch(approved), failure);
		expect(blocked.records.some((record) => record.status === "skipped")).toBe(
			true,
		);
		const running = restart(blocked);
		expect(running.records.slice(0, -1)).toEqual(approved.records.slice(0, -1));
		expect(finishBatch(running).status).toBe("completed");
	});

	it("preserves skipped siblings and later skip markers without making loop decisions", () => {
		const blocked = blockedDesign();
		blocked.records[0].status = "skipped";
		blocked.records.at(-1)!.status = "skipped";
		const running = restart(blocked);
		expect(running.records[0]).toEqual(blocked.records[0]);
		expect(running.records.at(-1)).toEqual(blocked.records.at(-1));
		expect(finishBatch(running).pause?.kind).toBe("human");
	});

	it("uses parsed values and detaches all state without effects or shared mutable history", () => {
		const blocked = blockedDesign();
		blocked.records[0].outcome!.summary = "  Saved discovery  ";
		const before = structuredClone(blocked);
		const running = restartBlockedBatch(blocked);
		expect(running.records[0].outcome!.summary).toBe("Saved discovery");
		expect(restartBlockedBatch(blocked)).toEqual(running);
		running.workflow.commands.design.chain.reverse();
		running.records[0].outcome!.summary = "Changed copy";
		running.records[1].loops.push({ id: "copy-only", iteration: 1, max: 1 });
		expect(blocked).toEqual(before);
	});
});

describe("blocked restart rejection", () => {
	it.each<[string, () => EngineState]>([
		["mode choice", () => createEngine(workflow, "develop")],
		["ready", () => createEngine(workflow, "develop", "auto")],
		["running", () => beginBatch(createEngine(workflow, "develop", "auto"))],
		[
			"interrupted",
			() =>
				interruptEngine(beginBatch(createEngine(workflow, "develop", "auto"))),
		],
		[
			"semi pause",
			() => finishBatch(beginBatch(createEngine(workflow, "develop", "semi"))),
		],
		[
			"human checkpoint",
			() => finishBatch(beginBatch(createEngine(workflow, "design"))),
		],
		[
			"report pause",
			() =>
				finishBatch(beginBatch(createEngine(workflow, "develop", "auto")), {
					outcome: { status: "needs_human", summary: "Need a decision" },
				}),
		],
		[
			"completed",
			() =>
				finishBatch(
					beginBatch(
						finishBatch(beginBatch(createEngine(workflow, "delegate"))),
					),
				),
		],
	])(
		"rejects %s instead of inferring permission to restart",
		(_name, create) => {
			rejects(create(), /not paused on a blocked batch/);
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
			"non-failure pause",
			(state) => {
				state.pause!.kind = "report";
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
			"unknown status",
			(state) => {
				Reflect.set(state.records[0], "status", "unknown");
			},
		],
		[
			"incomplete snapshot",
			(state) => {
				Reflect.deleteProperty(state, "workflow");
			},
		],
	])("preflights %s before making any changes", (_name, corrupt) => {
		const blocked = blockedDevelop();
		corrupt(blocked);
		rejects(blocked);
	});

	it.each<[string, (state: EngineState) => void]>([
		[
			"record order",
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
			"changed loop",
			(state) => {
				state.records[0].loops[0].iteration = 2;
			},
		],
		[
			"changed kind",
			(state) => {
				state.records[0].kind = "human";
			},
		],
	])("rejects malformed topology: %s", (_name, corrupt) => {
		const blocked = blockedDevelop();
		corrupt(blocked);
		rejects(blocked, /pinned workflow/);
	});

	it.each<ExecutionRecord["status"]>([
		"running",
		"interrupted",
		"pending",
		"waiting",
	])("rejects a %s sibling rather than resetting unreported work", (status) => {
		const blocked = blockedDesign();
		blocked.records[0].status = status;
		delete blocked.records[0].outcome;
		rejects(blocked);
	});

	it.each([
		{ outcome: done("Wrong waiting report") },
		{ outcome: { status: "blocked", summary: "Blocked, not waiting" } },
		{
			outcome: { status: "needs_human", summary: "Question" },
			error: "Failed after reporting",
		},
		{ outcome: { status: "needs_human", summary: "Question" }, error: "" },
	])("rejects an untrustworthy waiting sibling: %j", (result) => {
		const blocked = blockedDesign();
		Object.assign(blocked.records[0], { status: "waiting", ...result });
		rejects(blocked, /cannot bypass/);
	});

	it.each<[string, (record: ExecutionRecord) => void]>([
		[
			"missing report",
			(record) => {
				delete record.outcome;
			},
		],
		[
			"blocked report",
			(record) => {
				record.outcome!.status = "blocked";
			},
		],
		[
			"error",
			(record) => {
				record.error = "Failed after reporting";
			},
		],
		[
			"unknown status",
			(record) => {
				Reflect.set(record, "status", "unknown");
			},
		],
	])("rejects a retained sibling with %s", (_name, corrupt) => {
		const blocked = blockedDesign();
		corrupt(blocked.records[0]);
		rejects(blocked);
	});

	it.each<ExecutionRecord["status"]>([
		"pending",
		"waiting",
		"blocked",
		"interrupted",
		"running",
	])("rejects earlier %s serial work outside the blocked batch", (status) => {
		const implemented = finishBatch(
			beginBatch(createEngine(workflow, "develop", "auto")),
		);
		const blocked = finishBatch(beginBatch(implemented), failure);
		blocked.records[0].status = status;
		delete blocked.records[0].outcome;
		rejects(blocked);
	});

	it.each<ExecutionRecord["status"]>([
		"completed",
		"waiting",
		"blocked",
		"interrupted",
		"running",
	])("rejects later %s work outside the blocked batch", (status) => {
		const blocked = blockedDevelop();
		Object.assign(blocked.records.at(-1)!, {
			status,
			outcome: done("Out-of-order audit"),
		});
		rejects(blocked);
	});

	it.each(["pending", "waiting"] as const)(
		"cannot bypass an earlier %s human checkpoint",
		(status) => {
			const checkpoint = finishBatch(
				beginBatch(createEngine(workflow, "design")),
			);
			const blocked = finishBatch(
				beginBatch(answerCheckpoint(checkpoint, "Draft now")),
				failure,
			);
			const human = blocked.records.find((record) => record.kind === "human")!;
			human.status = status;
			delete human.answer;
			rejects(blocked, /cannot bypass/);
		},
	);

	it("cannot bypass a pending loop boundary to restart the next iteration", () => {
		const implemented = finishBatch(
			beginBatch(createEngine(workflow, "develop", "auto")),
		);
		const reviewed = finishBatch(beginBatch(implemented));
		const blocked = finishBatch(beginBatch(reviewed), failure);
		blocked.records.find((record) => record.kind === "loop_end")!.status =
			"pending";
		rejects(blocked, /cannot bypass/);
	});

	it("does not extend exhausted shipped review loops after a successful restart", () => {
		let state = finishBatch(restart(blockedDevelop()), {
			outcome: done("Implemented", { allDone: true }),
		});
		for (let iteration = 1; iteration <= 3; iteration++) {
			state = finishBatch(beginBatch(state), {
				outcome: done("Still needs fixes", { review: "changes_requested" }),
			});
			if (iteration < 3) {
				state = finishBatch(beginBatch(state), {
					outcome: done("Fixed", { allDone: true }),
				});
			}
		}
		expect(state.status).toBe("blocked");
		expect(state.pause?.message).toMatch(/exhausted 3/);
		expect(state.records.at(-1)).toMatchObject({
			role: "auditor",
			status: "pending",
		});
		expect(
			state.records
				.filter((record) => record.status === "blocked")
				.map((record) => record.kind),
		).toEqual(["loop_end"]);
		rejects(state, /No blocked agents/);
	});

	it("does not broaden legacy continuation permissions", () => {
		const blocked = blockedDesign();
		expect(() => resumeInterruptedBatch(blocked)).toThrow();
		expect(() => resumeReportedBatch(blocked)).toThrow();
		const skipped = structuredClone(blocked);
		skipped.records[0].status = "skipped";
		const interrupted = interruptEngine(restart(skipped));
		expect(() => resumeInterruptedBatch(interrupted)).toThrow(/cannot bypass/);
		const waiting = finishBatch(restart(skipped), {
			outcome: { status: "needs_human", summary: "Need an answer" },
		});
		expect(() => resumeReportedBatch(waiting)).toThrow(/cannot bypass/);
	});
});
