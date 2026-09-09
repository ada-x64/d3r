/* oxlint-disable no-magic-numbers -- Counters and array positions are test data. */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { AgentSpec, Workflow } from "@d3r/core";
import {
	type RuntimeActivity,
	type RuntimePrompt,
	type RuntimeSession,
} from "@d3r/core/runtime";
import {
	compileWorkflow,
	type EngineState,
	type WorkflowOutcome,
} from "../../core/engine.ts";
import {
	createWorkflowReportTool,
	createWorkflowRuntime,
	type WorkflowReport,
} from "./workflow-runtime.ts";

/** Real resource chains keep wrapper tests sensitive to workflow changes. */
const workflow = Workflow.parse(
	parse(
		readFileSync(new URL("../../core/workflow.yaml", import.meta.url), "utf8"),
	),
);
/** Native definitions are passed through the same structural boundary as resource discovery. */
const agents = [
	...new Set(
		Object.keys(workflow.commands).flatMap((command) =>
			compileWorkflow(workflow, command).flatMap(({ role }) =>
				role ? [role] : [],
			),
		),
	),
].map((name) => ({
	spec: AgentSpec.parse({
		name,
		tier: "low",
		description: name,
		capabilities: [],
	}),
	prompt: name,
}));
/** No completion flags are implicit in ordinary successful activity reports. */
const done = (
	summary: string,
	extra: Partial<WorkflowOutcome> = {},
): WorkflowOutcome => ({ status: "completed", summary, ...extra });
/** DI fake sessions execute no providers or tools beyond explicit test callbacks. */
const harness = (
	behavior: (
		name: string,
		report: WorkflowReport,
		request: RuntimePrompt,
	) => Promise<void> = async (name, report) => {
		report(done(name));
	},
	graph = workflow,
) => {
	const calls: { name: string; text: string }[] = [];
	const chunks: string[] = [];
	const activities: RuntimeActivity[] = [];
	const disposals: string[] = [];
	const config = [
		{
			id: "model",
			name: "Model",
			category: "model" as const,
			value: "first",
			options: [
				{ value: "first", name: "First" },
				{ value: "second", name: "Second" },
			],
		},
	];
	const routing = {
		prompt: vi.fn(async () => "completed" as const),
		dispose: vi.fn(async () => undefined),
		getConfig: () => structuredClone(config),
		setConfig: vi.fn(async (_id: string, value: string) => {
			config[0].value = value;
			return config;
		}),
		snapshot: vi.fn(() => ({
			messages: ["routing history"],
			model: config[0].value,
		})),
		restore: vi.fn(),
	};
	const createAgent = vi.fn(
		async (name: string, report: WorkflowReport): Promise<RuntimeSession> => ({
			prompt: async (request) => {
				calls.push({
					name,
					text: request.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n"),
				});
				await behavior(name, report, request);
				return "completed";
			},
			dispose: async () => {
				disposals.push(name);
			},
		}),
	);
	const runtime = createWorkflowRuntime({
		routing,
		workflow: graph,
		agents,
		createAgent,
	});
	const request = (text: string): RuntimePrompt => ({
		content: [{ type: "text", text }],
		signal: new AbortController().signal,
		emit: async ({ text: chunk }) => {
			chunks.push(chunk);
		},
		activity: async (event) => {
			activities.push(event);
		},
	});
	const prompt = (text: string) => runtime.prompt(request(text));
	const state = () => (runtime.snapshot!() as { engine: EngineState }).engine;
	return {
		runtime,
		routing,
		createAgent,
		calls,
		chunks,
		activities,
		disposals,
		prompt,
		request,
		state,
	};
};

/** Every recoverable pause must keep slash commands from replacing its retained work. */
const guardedStates = [
	{ name: "missing report", status: "blocked", kind: "failure" },
	{ name: "blocked report", status: "blocked", kind: "failure" },
	{ name: "needs_human report", status: "waiting", kind: "report" },
	{ name: "human checkpoint", status: "waiting", kind: "human" },
	{ name: "interrupted workflow", status: "interrupted", kind: "interrupted" },
	{ name: "interrupted routing", status: null, kind: null },
] as const;
/** Reach pauses through real turns, retaining nonempty context and a nondefault model. */
const guardedHarness = async (
	state: (typeof guardedStates)[number]["name"],
) => {
	const controller = new AbortController();
	const h = harness(async (name, report) => {
		if (["aggregator", "researcher"].includes(name)) {
			if (state === "interrupted workflow" && !controller.signal.aborted) {
				controller.abort();
				return;
			}
			if (state === "missing report") {
				return;
			}
			if (state === "blocked report" || state === "needs_human report") {
				report({
					status: state === "blocked report" ? "blocked" : "needs_human",
					summary:
						"Cannot perform design recon because required operator brief/topic is absent",
				});
				return;
			}
		}
		report(done(name));
	});
	await h.runtime.setConfig!("model", "second");
	await h.prompt("Earlier routing context");
	if (state === "interrupted routing") {
		h.routing.prompt.mockRejectedValueOnce(
			new Error("Interrupted fixture turn"),
		);
		await expect(
			h.prompt("Original interrupted routing brief"),
		).rejects.toThrow("Interrupted fixture turn");
	} else {
		await expect(
			h.runtime.prompt({ ...h.request("/design"), signal: controller.signal }),
		).resolves.toBe(
			state === "interrupted workflow" ? "cancelled" : "completed",
		);
	}
	return h;
};

// oxlint-disable-next-line max-statements -- Cases cover the public runtime contract independently.
describe("workflow runtime", () => {
	it("advertises resource commands and merges routing config with a deferred phase selector", async () => {
		const h = harness();
		expect(h.runtime.getCommands!().map(({ name }) => name)).toEqual(
			Object.keys(workflow.commands),
		);
		expect(h.runtime.getConfig!().map(({ id }) => id)).toEqual([
			"model",
			"phase",
		]);
		await h.runtime.setConfig!("phase", "delegate");
		expect(h.createAgent).not.toHaveBeenCalled();
		expect(h.routing.prompt).not.toHaveBeenCalled();
		await h.runtime.setConfig!("thought_level", "second");
		expect(h.routing.setConfig).toHaveBeenCalledWith("thought_level", "second");
		await h.prompt("Break up this design");
		expect(h.calls.map(({ name }) => name)).toEqual(["planner", "schemer"]);
		expect(h.calls[1].text).toContain('"summary":"planner"');
		expect(h.runtime.getConfig!().find(({ id }) => id === "phase")?.value).toBe(
			"routing",
		);
	});
	it("leaves ordinary prompts and unknown commands to routing", async () => {
		const h = harness();
		await h.prompt("hello");
		await h.prompt("/other help");
		expect(h.routing.prompt).toHaveBeenCalledTimes(2);
		expect(h.createAgent).not.toHaveBeenCalled();
	});
	it("emits a plan, named role activities, and preserves embedded tool IDs", async () => {
		const h = harness(async (name, report, request) => {
			await request.activity?.({
				kind: "tool",
				toolCallId: `embedded:unique:${name}`,
				title: "Read",
				toolKind: "read",
				status: "completed",
			});
			report(done(name));
		});
		await h.prompt("/delegate topic");
		expect(h.activities[0].kind).toBe("plan");
		expect(
			h.activities
				.filter(
					(event) => event.kind === "tool" && event.status === "in_progress",
				)
				.map((event) => event.kind === "tool" && event.title),
		).toEqual(["planner", "schemer"]);
		expect(
			h.activities.some(
				(event) =>
					event.kind === "tool" &&
					event.toolCallId === "embedded:unique:planner",
			),
		).toBe(true);
		expect(h.disposals).toEqual(["planner", "schemer"]);
	});
	it("persists the design human checkpoint and threads its answer into the designer", async () => {
		const h = harness();
		expect(await h.prompt("/design a compiler")).toBe("completed");
		expect(h.calls.map(({ name }) => name)).toEqual([
			"aggregator",
			"researcher",
		]);
		expect(h.chunks.join("\n")).toContain("Discuss design questions");
		expect(h.chunks.join("\n")).not.toContain(
			"completed with structured reports",
		);
		const other = harness();
		other.runtime.restore!(JSON.stringify(h.runtime.snapshot!()));
		expect(other.createAgent).not.toHaveBeenCalled();
		expect(other.routing.prompt).not.toHaveBeenCalled();
		expect(other.routing.restore).toHaveBeenCalledWith({
			messages: ["routing history"],
			model: "first",
		});
		await other.prompt("Use a parser combinator");
		expect(other.calls.map(({ name }) => name)).toEqual(["designer"]);
		expect(other.calls[0].text).toContain("Use a parser combinator");
		expect(other.calls[0].text.indexOf('"summary":"aggregator"')).toBeLessThan(
			other.calls[0].text.indexOf('"summary":"researcher"'),
		);
	});
	it("asks develop mode and never silently selects auto", async () => {
		const h = harness();
		await h.prompt("/develop implement this");
		expect(h.createAgent).not.toHaveBeenCalled();
		await h.prompt("continue");
		expect(h.createAgent).not.toHaveBeenCalled();
		await h.prompt("semi");
		expect(h.calls.map(({ name }) => name)).toEqual(["implementor"]);
		expect(h.state().pause?.kind).toBe("semi");
		await h.prompt("Check the concurrency carefully");
		expect(h.calls.map(({ name }) => name)).toEqual([
			"implementor",
			"reviewer",
		]);
		expect(h.calls[1].text).toContain("Check the concurrency carefully");
	});
	it("runs bounded auto loops, carries review feedback, and audits only explicit success", async () => {
		let reviews = 0;
		const h = harness(async (name, report) => {
			report(
				name === "reviewer"
					? done(++reviews === 1 ? "Fix race" : "Approved", {
							review: reviews === 1 ? "changes_requested" : "approved",
						})
					: done(name),
			);
		});
		await h.prompt("/develop fix");
		await h.prompt("auto");
		expect(h.calls.map(({ name }) => name)).toEqual([
			"implementor",
			"reviewer",
			"implementor",
			"reviewer",
			"auditor",
		]);
		expect(h.calls[2].text).toContain("Fix race");
		expect(h.state().status).toBe("completed");
	});
	it("blocks exhausted loops without auditing or claiming workflow completion", async () => {
		const h = harness();
		await h.prompt("/develop fix");
		await h.prompt("auto");
		expect(h.calls).toHaveLength(6);
		expect(h.calls.some(({ name }) => name === "auditor")).toBe(false);
		expect(h.state().status).toBe("blocked");
		expect(h.chunks.join("\n")).toContain("exhausted 3");
		expect(h.chunks.join("\n")).not.toContain(
			"completed with structured reports",
		);
	});
	it("fails closed without a report and requires an explicit restart or abandon", async () => {
		const h = harness(async () => undefined);
		await h.prompt("/summarize topic");
		await h.prompt("continue");
		expect(h.calls.map(({ name }) => name)).toEqual(["summarizer"]);
		expect(h.state().status).toBe("blocked");
		await h.prompt("restart");
		expect(h.calls).toHaveLength(2);
		await h.prompt("abandon");
		await h.prompt("hello");
		expect(h.routing.prompt).toHaveBeenCalledTimes(1);
	});
	it.each(["blocked", "needs_human"] as const)(
		"never advances or replays a %s report",
		async (status) => {
			const h = harness(async (_name, report) => {
				report({ status, summary: "Need authorization" });
			});
			await h.prompt("/delegate topic");
			await h.prompt("continue");
			expect(h.calls).toHaveLength(1);
			expect(h.chunks.join("\n")).toContain("Need authorization");
		},
	);
	it("rejects invalid and duplicate reports even if the child catches the tool error", async () => {
		const h = harness(async (_name, report) => {
			try {
				report({ status: "completed", summary: "" });
			} catch {
				/* Models may catch tool errors. */
			}
			report(done("subsequent valid report"));
			try {
				report(done("duplicate"));
			} catch {
				/* The first report must not mask the error. */
			}
		});
		await h.prompt("/delegate topic");
		expect(h.state().status).toBe("blocked");
		expect(h.calls).toHaveLength(1);
	});
	it("closes the report callback when the child settles", async () => {
		let callback: WorkflowReport | undefined = undefined;
		const h = harness(async (_name, report) => {
			callback = report;
			report(done("done"));
		});
		await h.prompt("/delegate topic");
		expect(() => callback!(done("late"))).toThrow(/outside/);
	});
	it.each(
		guardedStates.flatMap((state) =>
			[
				"/design ignored brief",
				"/delegate ignored brief",
				"/unknown ignored brief",
			].map((directive) => ({ ...state, directive })),
		),
	)(
		"explains $directive during $name without changing state or replaying effects",
		async ({ name, status, kind, directive }) => {
			const h = await guardedHarness(name);
			try {
				const before = {
					checkpoint: h.runtime.snapshot!(),
					config: h.runtime.getConfig!(),
					commands: h.runtime.getCommands!(),
					children: h.createAgent.mock.calls.length,
					routingCalls: h.routing.prompt.mock.calls.length,
					effects: structuredClone({
						calls: h.calls,
						disposals: h.disposals,
						activities: h.activities,
					}),
					chunks: h.chunks.length,
				};
				expect(before.checkpoint).toMatchObject(
					kind === null
						? { engine: null, routingInterrupted: true }
						: {
								phase: "design",
								engine: { command: "design", status, pause: { kind } },
							},
				);
				const request = h.request(directive);
				const emit = vi.fn(request.emit);
				await expect(h.runtime.prompt({ ...request, emit })).resolves.toBe(
					"completed",
				);
				const notices = h.chunks.slice(before.chunks);
				expect(notices).toHaveLength(1);
				expect(emit).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ kind: "text", text: notices[0] }),
				);
				expect(notices[0]).toContain(
					kind === null
						? "previous routing turn was interrupted"
						: `Workflow /design is ${status}`,
				);
				if (kind !== null) {
					expect(notices[0]).toContain(h.state().pause!.message);
				}
				expect(notices[0]).toContain("Reply abandon");
				expect(notices[0]).toContain("without replaying effects");
				expect(notices[0]).toContain("resend your slash command");
				await expect(h.runtime.setConfig!("phase", "delegate")).rejects.toThrow(
					/Abandon/,
				);
				expect(h.runtime.snapshot!()).toEqual(before.checkpoint);
				expect(h.runtime.getConfig!()).toEqual(before.config);
				expect(h.runtime.getCommands!()).toEqual(before.commands);
				expect(h.createAgent).toHaveBeenCalledTimes(before.children);
				expect(h.routing.prompt).toHaveBeenCalledTimes(before.routingCalls);
				expect(h.routing.setConfig).toHaveBeenCalledTimes(1);
				expect(h.routing.restore).not.toHaveBeenCalled();
				expect({
					calls: h.calls,
					disposals: h.disposals,
					activities: h.activities,
				}).toEqual(before.effects);
			} finally {
				await h.runtime.dispose();
			}
		},
	);
	it("explains a ready workflow without a pause after initial plan delivery fails", async () => {
		const h = harness();
		try {
			await expect(
				h.runtime.prompt({
					...h.request("/design original"),
					activity: async () => {
						throw new Error("Plan delivery failed");
					},
				}),
			).rejects.toThrow("Plan delivery failed");
			expect(h.state()).toMatchObject({ status: "ready", pause: null });
			const before = h.runtime.snapshot!();
			await expect(h.prompt("/design revised")).resolves.toBe("completed");
			expect(h.chunks.at(-1)).toContain("Workflow /design is ready");
			expect(h.chunks.at(-1)).toContain("Reply abandon");
			expect(h.runtime.snapshot!()).toEqual(before);
			expect(h.createAgent).not.toHaveBeenCalled();
		} finally {
			await h.runtime.dispose();
		}
	});
	it("explains a restored blocked design without replacing its pinned graph or brief", async () => {
		const original = await guardedHarness("blocked report");
		const changed = structuredClone(workflow);
		changed.commands.design.chain = [{ kind: "agent", name: "archivist" }];
		const h = harness(undefined, changed);
		try {
			await h.runtime.setConfig!("model", "second");
			h.runtime.restore!(JSON.stringify(original.runtime.snapshot!()));
			const before = h.runtime.snapshot!();
			const prompt =
				"/design we're working on the acp integration. i want to run a test. choose a random topic and research it.";
			await expect(h.prompt(prompt)).resolves.toBe("completed");
			expect(h.chunks.at(-1)).toContain("Workflow /design is blocked");
			expect(h.chunks.at(-1)).toContain(
				"required operator brief/topic is absent",
			);
			expect(h.chunks.at(-1)).toContain("Reply abandon");
			expect(h.runtime.snapshot!()).toEqual(before);
			expect(h.state().workflow).toEqual(workflow);
			expect(h.createAgent).not.toHaveBeenCalled();
			expect(h.routing.prompt).not.toHaveBeenCalled();
			expect(h.routing.restore).toHaveBeenCalledTimes(1);
			expect(h.routing.setConfig).toHaveBeenCalledTimes(1);
		} finally {
			await Promise.all([original.runtime.dispose(), h.runtime.dispose()]);
		}
	});
	it.each(guardedStates)(
		"requires abandon and a resent directive to launch new work after $name",
		async ({ name }) => {
			const h = await guardedHarness(name);
			try {
				const children = h.createAgent.mock.calls.length;
				const callCount = h.calls.length;
				const routingCalls = h.routing.prompt.mock.calls.length;
				await expect(h.prompt("/delegate ignored brief")).resolves.toBe(
					"completed",
				);
				await expect(h.prompt("abandon")).resolves.toBe("completed");
				expect(h.createAgent).toHaveBeenCalledTimes(children);
				expect(h.routing.prompt).toHaveBeenCalledTimes(routingCalls);
				expect(h.runtime.snapshot!()).toMatchObject({
					phase: "routing",
					engine: null,
					routingInterrupted: false,
				});
				await expect(h.prompt("/delegate resent brief")).resolves.toBe(
					"completed",
				);
				const launched = h.calls.slice(callCount);
				expect(launched.map(({ name: role }) => role)).toEqual([
					"planner",
					"schemer",
				]);
				expect(
					launched.every(({ text }) =>
						text.includes("Earlier routing context"),
					),
				).toBe(true);
				expect(
					launched.every(({ text }) => text.includes("/delegate resent brief")),
				).toBe(true);
				expect(
					launched.some(({ text }) => text.includes("ignored brief")),
				).toBe(false);
				expect(h.createAgent).toHaveBeenCalledTimes(children + 2);
				expect(h.routing.prompt).toHaveBeenCalledTimes(routingCalls);
				expect(h.state()).toMatchObject({
					command: "delegate",
					status: "completed",
				});
				expect(
					h.runtime.getConfig!().find(({ id }) => id === "model")?.value,
				).toBe("second");
			} finally {
				await h.runtime.dispose();
			}
		},
	);
	it.each(guardedStates.filter(({ name }) => name !== "human checkpoint"))(
		"restarts only the retained work after a guarded directive during $name",
		async ({ name }) => {
			const h = await guardedHarness(name);
			try {
				const children = h.createAgent.mock.calls.length;
				const callCount = h.calls.length;
				const routingCalls = h.routing.prompt.mock.calls.length;
				await expect(h.prompt("/delegate ignored brief")).resolves.toBe(
					"completed",
				);
				await expect(h.prompt("continue")).resolves.toBe("completed");
				expect(h.createAgent).toHaveBeenCalledTimes(children);
				expect(h.routing.prompt).toHaveBeenCalledTimes(routingCalls);
				await expect(h.prompt("restart")).resolves.toBe("completed");
				if (name === "interrupted routing") {
					expect(h.createAgent).not.toHaveBeenCalled();
					expect(h.routing.prompt).toHaveBeenCalledTimes(routingCalls + 1);
					expect(h.routing.prompt).toHaveBeenLastCalledWith(
						expect.objectContaining({
							content: [
								{ type: "text", text: "Original interrupted routing brief" },
							],
						}),
					);
				} else {
					const repeated = h.calls.slice(callCount);
					expect(repeated.map(({ name: role }) => role)).toEqual([
						"aggregator",
						"researcher",
					]);
					expect(repeated.every(({ text }) => text.includes("/design"))).toBe(
						true,
					);
					expect(
						repeated.some(({ text }) => text.includes("ignored brief")),
					).toBe(false);
					expect(h.state().command).toBe("design");
					expect(h.state().workflow).toEqual(workflow);
					expect(h.createAgent).toHaveBeenCalledTimes(children + 2);
					expect(h.routing.prompt).toHaveBeenCalledTimes(routingCalls);
				}
				expect(
					h.runtime.getConfig!().find(({ id }) => id === "model")?.value,
				).toBe("second");
			} finally {
				await h.runtime.dispose();
			}
		},
	);
	it("restores the pinned graph, not changed live resource definitions", async () => {
		const h = harness();
		await h.prompt("/design original");
		const changed = structuredClone(workflow);
		changed.commands.design.chain = [{ kind: "agent", name: "archivist" }];
		changed.commands.design.description = "changed";
		const other = harness(undefined, changed);
		other.runtime.restore!(h.runtime.snapshot!());
		await other.prompt("Use original graph");
		expect(other.calls.map(({ name }) => name)).toEqual(["designer"]);
		expect(other.runtime.getCommands!()[0].description).toBe(
			workflow.commands.design.description,
		);
	});
	it("rejects invalid restore before touching the routing runtime", () => {
		const h = harness();
		const snapshot = h.runtime.snapshot!() as Record<string, unknown>;
		expect(() =>
			h.runtime.restore!({ ...snapshot, phase: "nonexistent" }),
		).toThrow();
		expect(h.routing.restore).not.toHaveBeenCalled();
	});
	it("threads finished workflow summaries into the next command", async () => {
		const h = harness();
		await h.prompt("/delegate topic");
		await h.prompt("/summarize task");
		expect(h.calls[2].text).toContain('"summary":"schemer"');
		expect(h.calls.map(({ name }) => name)).toEqual([
			"planner",
			"schemer",
			"summarizer",
			"archivist",
		]);
	});
	it("validates roles before effects and refuses incomplete snapshot support", () => {
		const h = harness();
		expect(() =>
			createWorkflowRuntime({
				routing: h.routing,
				workflow,
				agents: [],
				createAgent: h.createAgent,
			}),
		).toThrow(/Missing workflow agent/);
		const runtime = createWorkflowRuntime({
			routing: { prompt: h.routing.prompt, dispose: h.routing.dispose },
			workflow,
			agents,
			createAgent: h.createAgent,
		});
		expect(() => runtime.snapshot!()).toThrow(/snapshot and restore/);
	});
	it("exposes the report tool schema and checks cancellation before accepting a report", async () => {
		const report = vi.fn();
		const tool = createWorkflowReportTool(report);
		const controller = new AbortController();
		const context = {
			toolCallId: "report",
			cwd: ".",
			roots: ["."],
			signal: controller.signal,
		};
		expect(tool.name).toBe("d3r_report");
		expect(tool.permission).toBe("none");
		expect(tool.schema.safeParse(done("okay")).success).toBe(true);
		await tool.execute(done("okay"), context);
		expect(report).toHaveBeenCalledWith(done("okay"));
		controller.abort();
		await expect(tool.execute(done("late"), context)).rejects.toThrow();
		expect(report).toHaveBeenCalledTimes(1);
	});
});
