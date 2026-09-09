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
	it("rejects new directives and phase changes while a checkpoint is active", async () => {
		const h = harness();
		await h.prompt("/design topic");
		await expect(h.prompt("/delegate other")).rejects.toThrow(/active/);
		await expect(h.runtime.setConfig!("phase", "delegate")).rejects.toThrow(
			/Abandon/,
		);
		expect(h.calls).toHaveLength(2);
	});
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
