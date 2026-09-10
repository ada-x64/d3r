/* oxlint-disable no-magic-numbers -- Iteration counts and indices are test fixtures. */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { Workflow, type ChainStep } from "./schema.ts";
import {
	type EngineState,
	answerCheckpoint,
	beginBatch,
	compileWorkflow,
	createEngine,
	interruptEngine,
	parseEngineState,
	recordOutcome,
	restoreEngine,
	serializeEngine,
	settleBatch,
	WorkflowOutcome,
} from "./engine.ts";

/** Exercise the shipped graph rather than duplicating its orchestration in fixtures. */
const workflow = Workflow.parse(
	parse(readFileSync(new URL("workflow.yaml", import.meta.url), "utf8")),
);
/** Minimal graphs isolate control-flow corner cases. */
const graph = (chain: ChainStep[]): Workflow => ({
	commands: { test: { description: "test", chain } },
	vault: { dirs: [], template_kinds: [] },
});
/** Reports default to a successful activity, not successful loop termination. */
const done = (
	summary: string,
	extra: Partial<WorkflowOutcome> = {},
): WorkflowOutcome => ({ status: "completed", summary, ...extra });
/** A pure batch driver models a barrier without any IO or model runtime. */
const batch = (
	input: EngineState,
	report: (role: string) => unknown = (role) => done(role),
): EngineState => {
	const running = beginBatch(input);
	return settleBatch(
		running.records
			.filter((record) => record.status === "running")
			.reduce(
				(state, record) =>
					recordOutcome(state, record.id, { outcome: report(record.role!) }),
				running,
			),
	);
};
/** Human checkpoints are answered explicitly, never inferred from an agent's prose. */
const automatic = (): EngineState =>
	answerCheckpoint(createEngine(workflow, "develop"), "auto");

// oxlint-disable-next-line max-statements -- Independent cases document the engine transition contract.
describe("workflow engine", () => {
	it("compiles stable IDs and declared parallel order without mutating resources", () => {
		const before = JSON.stringify(workflow);
		const records = compileWorkflow(workflow, "design");
		expect(records.map(({ id, role, kind }) => [id, role ?? kind])).toEqual([
			["design/0/0", "aggregator"],
			["design/0/1", "researcher"],
			["design/1", "human"],
			["design/2", "designer"],
		]);
		expect(records[0].batch).toBe(records[1].batch);
		expect(compileWorkflow(workflow, "design")).toEqual(records);
		expect(JSON.stringify(workflow)).toBe(before);
	});
	it("requires a real human answer between design discovery and drafting", () => {
		const start = createEngine(workflow, "design");
		const waiting = batch(start);
		expect(start.status).toBe("ready");
		expect(waiting.status).toBe("waiting");
		expect(waiting.pause?.kind).toBe("human");
		expect(() => beginBatch(waiting)).toThrow();
		expect(() => answerCheckpoint(waiting, " ")).toThrow();
		const resumed = answerCheckpoint(
			restoreEngine(serializeEngine(waiting)),
			"Use a small design",
		);
		expect(resumed.records[2].answer).toBe("Use a small design");
		expect(batch(resumed).status).toBe("completed");
	});
	it.each(["delegate", "summarize"])(
		"runs /%s in declaration order",
		(command) => {
			let state = createEngine(workflow, command);
			const seen: string[] = [];
			while (state.status === "ready") {
				state = batch(state, (role) => {
					seen.push(role);
					return done(role);
				});
			}
			expect(seen).toEqual(
				workflow.commands[command].chain.map((step) =>
					step.kind === "agent" ? step.name : "unexpected",
				),
			);
			expect(state.status).toBe("completed");
		},
	);
	it("waits for an explicit develop mode and checkpoints between semi batches", () => {
		const waiting = createEngine(workflow, "develop");
		expect(waiting.pause?.kind).toBe("mode");
		expect(() => answerCheckpoint(waiting, "go ahead")).toThrow(/semi or auto/);
		const state = batch(answerCheckpoint(waiting, "semi"));
		expect(state.pause?.kind).toBe("semi");
		expect(
			beginBatch(
				answerCheckpoint(state, "Please review carefully"),
			).records.find((record) => record.status === "running")?.role,
		).toBe("reviewer");
	});
	it("exhausts unapproved loops and does not run the auditor", () => {
		let state = automatic();
		const roles: string[] = [];
		while (state.status === "ready") {
			state = batch(state, (role) => {
				roles.push(role);
				return done("Looks complete in prose only");
			});
		}
		expect(roles).toEqual([
			"implementor",
			"reviewer",
			"implementor",
			"reviewer",
			"implementor",
			"reviewer",
		]);
		expect(state.status).toBe("blocked");
		expect(state.pause?.message).toMatch(/exhausted 3/);
		expect(state.records.at(-1)?.status).toBe("pending");
	});
	it("feeds changes_requested to the next iteration and exits only on approval", () => {
		let state = batch(automatic(), () =>
			done("Implemented", { allDone: true }),
		);
		state = batch(state, () =>
			done("Fix the race", { review: "changes_requested" }),
		);
		expect(
			state.records.find(
				(record) => record.outcome?.review === "changes_requested",
			)?.outcome?.summary,
		).toBe("Fix the race");
		state = batch(state, () => done("Fixed the race", { allDone: true }));
		state = batch(state, () => done("Reviewed", { review: "approved" }));
		expect(
			state.records.filter((record) => record.status === "skipped").length,
		).toBeGreaterThan(0);
		expect(
			beginBatch(state).records.find((record) => record.status === "running")
				?.role,
		).toBe("auditor");
		expect(batch(state).status).toBe("completed");
	});
	it("requires the declared develop review even after implementor allDone", () => {
		const start = automatic();
		const state = batch(start, () => done("Nothing left", { allDone: true }));
		expect(state.records.slice(1)).toEqual(start.records.slice(1));
		expect(
			beginBatch(state).records.find((record) => record.status === "running")
				?.role,
		).toBe("reviewer");
		const approved = batch(state, () =>
			done("Reviewed", { review: "approved" }),
		);
		expect(
			beginBatch(approved).records.find((record) => record.status === "running")
				?.role,
		).toBe("auditor");
		expect(batch(approved).status).toBe("completed");
		expect(start.records.every((record) => record.status === "pending")).toBe(
			true,
		);
	});
	it("accepts allDone in a standalone implementor loop", () => {
		const custom = graph([
			{ kind: "loop", max: 2, body: [{ kind: "agent", name: "implementor" }] },
			{ kind: "agent", name: "auditor" },
		]);
		const state = batch(createEngine(custom, "test"), () =>
			done("Nothing left", { allDone: true }),
		);
		expect(
			state.records.slice(1, -1).every((record) => record.status === "skipped"),
		).toBe(true);
		expect(
			beginBatch(state).records.find((record) => record.status === "running")
				?.role,
		).toBe("auditor");
	});
	it("does not let a reviewer in a later iteration prevent allDone", () => {
		const custom = graph([
			{
				kind: "loop",
				max: 2,
				body: [
					{ kind: "agent", name: "reviewer" },
					{ kind: "agent", name: "implementor" },
				],
			},
			{ kind: "agent", name: "auditor" },
		]);
		const reviewed = batch(createEngine(custom, "test"));
		const state = batch(reviewed, () =>
			done("Nothing left", { allDone: true }),
		);
		expect(
			state.records
				.filter((record) => record.role === "reviewer")
				.map((record) => record.status),
		).toEqual(["completed", "skipped"]);
		expect(
			beginBatch(state).records.find((record) => record.status === "running")
				?.role,
		).toBe("auditor");
	});
	it("does not let an outer reviewer prevent closing an implementor-only inner loop", () => {
		const custom = graph([
			{
				kind: "loop",
				max: 2,
				body: [
					{
						kind: "loop",
						max: 2,
						body: [{ kind: "agent", name: "implementor" }],
					},
					{ kind: "agent", name: "reviewer" },
				],
			},
			{ kind: "agent", name: "auditor" },
		]);
		const state = batch(createEngine(custom, "test"), () =>
			done("Inner work done", { allDone: true }),
		);
		expect(
			state.records.slice(1, 4).every((record) => record.status === "skipped"),
		).toBe(true);
		expect(
			beginBatch(state).records.find((record) => record.status === "running")
				?.role,
		).toBe("reviewer");
		const approved = batch(state, () =>
			done("Outer approved", { review: "approved" }),
		);
		expect(
			beginBatch(approved).records.find((record) => record.status === "running")
				?.role,
		).toBe("auditor");
	});
	it("does not skip a nested reviewer within the implementor's current iteration", () => {
		const custom = graph([
			{
				kind: "loop",
				max: 2,
				body: [
					{ kind: "agent", name: "implementor" },
					{ kind: "loop", max: 2, body: [{ kind: "agent", name: "reviewer" }] },
				],
			},
		]);
		const start = createEngine(custom, "test");
		const state = batch(start, () =>
			done("Outer work done", { allDone: true }),
		);
		expect(state.records.slice(1)).toEqual(start.records.slice(1));
		expect(
			beginBatch(state).records.find((record) => record.status === "running")
				?.role,
		).toBe("reviewer");
	});
	it("does not accept other roles' completion hints", () => {
		const wrongRole = batch(
			batch(automatic(), () => done("Not a reviewer", { review: "approved" })),
			() => done("Not an implementor", { allDone: true }),
		);
		expect(
			beginBatch(wrongRole).records.find(
				(record) => record.status === "running",
			)?.role,
		).toBe("implementor");
	});
	it.each([undefined, "completed", { status: "completed", summary: "" }])(
		"fails closed on a missing or invalid report: %s",
		(report) => {
			const state = batch(createEngine(workflow, "delegate"), () => report);
			expect(state.status).toBe("blocked");
			expect(state.records[1].status).toBe("pending");
			expect(() => answerCheckpoint(state, "continue")).toThrow();
		},
	);
	it.each(["blocked", "needs_human"] as const)(
		"does not advance on %s even with approval or allDone",
		(status) => {
			const state = batch(automatic(), () => ({
				status,
				summary: "Need a decision",
				allDone: true,
				review: "approved",
			}));
			expect(state.status).toBe(status === "blocked" ? "blocked" : "waiting");
			expect(
				state.records.filter((record) => record.status === "skipped"),
			).toHaveLength(0);
			expect(() => answerCheckpoint(state, "continue")).toThrow();
		},
	);
	it("keeps parallel outputs in declaration order and waits for every result", () => {
		const start = beginBatch(createEngine(workflow, "design"));
		const second = recordOutcome(start, "design/0/1", {
			outcome: done("Second"),
		});
		expect(() => settleBatch(second)).toThrow(/not settled/);
		const first = recordOutcome(second, "design/0/0", {
			outcome: done("First"),
		});
		expect(
			settleBatch(first)
				.records.filter((record) => record.outcome)
				.map((record) => record.outcome?.summary),
		).toEqual(["First", "Second"]);
		expect(start.records[1].outcome).toBeUndefined();
	});
	it("restores in-flight records as interrupted while preserving completed siblings", () => {
		const running = recordOutcome(
			beginBatch(createEngine(workflow, "design")),
			"design/0/1",
			{ outcome: done("Completed before crash") },
		);
		const restored = restoreEngine(serializeEngine(running));
		expect(restored.status).toBe("interrupted");
		expect(restored.records.slice(0, 2).map((record) => record.status)).toEqual(
			["interrupted", "completed"],
		);
		expect(() => beginBatch(restored)).toThrow();
		expect(restoreEngine(serializeEngine(restored))).toEqual(restored);
		expect(interruptEngine(running).records[1].outcome?.summary).toBe(
			"Completed before crash",
		);
	});
	it("pins a deep copy and rejects topology tampering or fabricated completion", () => {
		const source = structuredClone(workflow);
		const state = createEngine(source, "delegate");
		source.commands.delegate.chain.reverse();
		expect(state.workflow).toEqual(workflow);
		const changed = structuredClone(state);
		changed.records.reverse();
		expect(() => parseEngineState(changed)).toThrow(/pinned workflow/);
		state.records[0].status = "completed";
		expect(() => parseEngineState(state)).toThrow(/completed report/);
		expect(() =>
			WorkflowOutcome.parse({ ...done("okay"), invented: true }),
		).toThrow();
	});
	it("rejects checkpoints that bypass unfinished work or the develop mode question", () => {
		const blocked = batch(createEngine(workflow, "delegate"), () => undefined);
		blocked.status = "ready";
		blocked.pause = null;
		expect(() => restoreEngine(blocked)).toThrow(/unfinished work/);
		const develop = createEngine(workflow, "develop");
		develop.status = "ready";
		develop.pause = null;
		expect(() => restoreEngine(develop)).toThrow(/explicit mode/);
		const partial = recordOutcome(
			beginBatch(createEngine(workflow, "design")),
			"design/0/0",
			{ outcome: done("done") },
		);
		partial.status = "ready";
		expect(() => beginBatch(partial)).toThrow(/replay/);
	});
	it("does not let an inner loop's approval close an outer loop", () => {
		const nested = graph([
			{
				kind: "loop",
				max: 2,
				body: [
					{ kind: "loop", max: 2, body: [{ kind: "agent", name: "reviewer" }] },
				],
			},
			{ kind: "agent", name: "auditor" },
		]);
		let state = createEngine(nested, "test");
		state = batch(state, () => done("inner approved", { review: "approved" }));
		expect(state.status).toBe("ready");
		state = batch(state, () =>
			done("next inner approved", { review: "approved" }),
		);
		expect(state.status).toBe("blocked");
		expect(state.records.at(-1)?.status).toBe("pending");
	});
	it.each([
		["reviewer", "implementor"],
		["implementor", "reviewer"],
	])(
		"gives changes_requested precedence over parallel allDone in %j order",
		(...agents) => {
			const custom = graph([
				{
					kind: "loop",
					max: 1,
					body: [{ kind: "parallel", agents }],
				},
				{ kind: "agent", name: "auditor" },
			]);
			const state = batch(createEngine(custom, "test"), (role) =>
				role === "reviewer"
					? done("Fix this", { review: "changes_requested" })
					: done("Done", { allDone: true }),
			);
			expect(state.status).toBe("blocked");
			expect(state.records.some((record) => record.status === "skipped")).toBe(
				false,
			);
			expect(state.records.at(-1)).toMatchObject({
				role: "auditor",
				status: "pending",
			});
		},
	);
	it.each([0, -1, 1.5, Infinity, 10_001])(
		"rejects invalid loop max %s",
		(max) => {
			expect(() =>
				createEngine(
					graph([{ kind: "loop", max, body: [{ kind: "agent", name: "a" }] }]),
					"test",
				),
			).toThrow();
		},
	);
	it("bounds nested expansion and rejects empty executable chains", () => {
		expect(() =>
			createEngine(
				graph([
					{
						kind: "loop",
						max: 100,
						body: [
							{ kind: "loop", max: 100, body: [{ kind: "agent", name: "a" }] },
						],
					},
				]),
				"test",
			),
		).toThrow(/budget/);
		for (const chain of [
			[],
			[{ kind: "parallel", agents: [] }],
			[{ kind: "human", prompt: "" }],
		] as ChainStep[][]) {
			expect(() => createEngine(graph(chain), "test")).toThrow();
		}
		let body: ChainStep[] = [{ kind: "agent", name: "a" }];
		for (let depth = 0; depth < 18; depth++) {
			body = [{ kind: "loop", max: 1, body }];
		}
		expect(() => createEngine(graph(body), "test")).toThrow(/depth/);
	});
});
