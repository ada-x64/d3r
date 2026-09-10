import { AgentSpec, Workflow } from "@d3r/core";
import {
	beginBatch,
	createEngine,
	interruptEngine,
	recordOutcome,
	settleBatch,
} from "@d3r/core/engine";
import {
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	executionWorkflow,
	standaloneWorkflow,
	STANDALONE_COMMAND,
} from "./workflow-role.ts";
import {
	createWorkflowRuntime,
	type WorkflowReport,
} from "./workflow-runtime.ts";

/** A phase still owns its follow-on review when a worker is selected independently. */
const workflow = Workflow.parse({
	commands: {
		develop: {
			description: "Implement and review",
			chain: [
				{ kind: "agent", name: "implementor" },
				{ kind: "agent", name: "reviewer" },
			],
		},
	},
	vault: { dirs: [], template_kinds: [] },
});
/** Loaded roles, including a worker not referenced by any phase. */
const agents = ["implementor", "reviewer", "researcher", "orchestrator"].map(
	(name) => ({
		spec: AgentSpec.parse({
			name,
			tier: "low",
			description: name,
			capabilities: [],
		}),
		prompt: name,
	}),
);

describe("standalone workflow graphs", () => {
	it("selects exactly one loaded worker without changing phase definitions or shared resources", () => {
		const base = structuredClone(workflow);
		const resources = structuredClone(agents);
		const graph = standaloneWorkflow(base, resources, "researcher");
		expect(graph.commands).toEqual({
			standalone: {
				description: expect.any(String),
				chain: [{ kind: "agent", name: "researcher" }],
			},
		});
		expect(graph.vault).toEqual(base.vault);
		expect(base).toEqual(workflow);
		expect(resources).toEqual(agents);

		graph.commands.standalone.chain.push({ kind: "agent", name: "reviewer" });
		graph.vault.dirs.push("standalone-only");
		expect(base).toEqual(workflow);
		expect(resources).toEqual(agents);
	});

	it("rejects unknown roles and the loaded orchestrator", () => {
		expect(() => standaloneWorkflow(workflow, agents, "missing")).toThrow(
			/unknown or non-delegable/i,
		);
		expect(() => standaloneWorkflow(workflow, agents, "orchestrator")).toThrow(
			/unknown or non-delegable/i,
		);
	});

	it("derives the restore graph from the selected role and leaves ordinary execution alone", () => {
		const graph = standaloneWorkflow(workflow, agents, "reviewer");
		const saved = {
			engine: createEngine(graph, STANDALONE_COMMAND),
			phase: "routing",
			orchestrated: true,
			standaloneRole: "reviewer",
			routingInterrupted: false,
		};
		const restored = executionWorkflow(workflow, agents, saved);
		expect(restored).toEqual(graph);
		expect(restored).not.toBe(saved.engine.workflow);
		expect(
			executionWorkflow(workflow, agents, {
				...saved,
				standaloneRole: undefined,
				engine: createEngine(workflow, "develop", "semi"),
				phase: "develop",
			}),
		).toBe(workflow);
	});

	it("refuses standalone metadata without a compatible engine, routing phase, and orchestration mode", () => {
		const saved = {
			engine: createEngine(
				standaloneWorkflow(workflow, agents, "reviewer"),
				STANDALONE_COMMAND,
			),
			phase: "routing",
			orchestrated: true,
			standaloneRole: "reviewer",
			routingInterrupted: false,
		};
		const invalid = [
			{ ...saved, engine: null },
			{ ...saved, engine: createEngine(workflow, "develop", "auto") },
			{ ...saved, orchestrated: false },
			{ ...saved, phase: "develop" },
			{ ...saved, routingInterrupted: true },
			{
				...saved,
				standaloneRole: "implementor",
				engine: createEngine(
					standaloneWorkflow(workflow, agents, "implementor"),
					STANDALONE_COMMAND,
				),
			},
		];
		for (const checkpoint of invalid) {
			expect(() => executionWorkflow(workflow, agents, checkpoint)).toThrow(
				/invalid standalone role execution checkpoint/i,
			);
		}
	});

	it("rejects a direct implementor without explicit mode before any state change or worker effects", async () => {
		const brief = {
			goal: "Fix cancellation",
			context: "Search continues after cancellation",
			acceptanceCriteria: ["Cancelled searches stop"],
			constraints: ["Do not commit or push"],
		};
		const createAgent = vi.fn(
			(_name: string, report: WorkflowReport): RuntimeSession => ({
				prompt: async () => {
					report({ status: "completed", summary: "Cancellation fixed" });
					return "completed";
				},
				dispose: async () => undefined,
			}),
		);
		const routing = {
			prompt: async (request: RuntimePrompt): Promise<RuntimeStopReason> => {
				const context = {
					toolCallId: "implementor",
					cwd: process.cwd(),
					roots: [process.cwd()],
					signal: request.signal,
				};
				const before = runtime.snapshot!();
				const result = await runtime.runPhase(
					{ action: "role", role: "implementor", brief },
					context,
				);
				expect(result.isError).toBe(true);
				expect(result.text).toMatch(/choose semi or auto explicitly/i);
				expect(runtime.snapshot!()).toEqual(before);
				expect(createAgent).not.toHaveBeenCalled();
				expect(activity).not.toHaveBeenCalled();
				expect(emit).not.toHaveBeenCalled();

				const started = await runtime.runPhase(
					{ action: "role", role: "implementor", brief, mode: "semi" },
					context,
				);
				expect(started.isError).not.toBe(true);
				return "completed";
			},
			snapshot: () => ({}),
			restore: () => undefined,
			dispose: async () => undefined,
		};
		const runtime = createWorkflowRuntime({
			workflow,
			agents,
			routing,
			createAgent,
			orchestrated: true,
		});
		onTestFinished(() => runtime.dispose());
		const activity = vi.fn(async () => undefined);
		const emit = vi.fn(async () => undefined);
		await runtime.prompt({
			content: [{ type: "text", text: "Implement the cancellation fix" }],
			signal: new AbortController().signal,
			activity,
			emit,
		});
		expect(createAgent.mock.calls.map(([name]) => name)).toEqual([
			"implementor",
		]);
		expect(runtime.snapshot!()).toMatchObject({
			phase: "routing",
			standaloneRole: "implementor",
			engine: { command: "standalone", mode: "semi", status: "completed" },
		});
	});

	it("requires routing for every unfinished role state and rejects unknown phases even after completion", () => {
		const graph = standaloneWorkflow(workflow, agents, "reviewer");
		const ready = createEngine(graph, STANDALONE_COMMAND);
		const running = beginBatch(ready);
		const reported = (status: "needs_human" | "blocked" | "completed") =>
			settleBatch(
				recordOutcome(running, running.records[0].id, {
					outcome: { status, summary: "Inspection result" },
				}),
			);
		const metadata = {
			phase: "routing",
			orchestrated: true,
			standaloneRole: "reviewer",
			routingInterrupted: false,
		};
		for (const engine of [
			ready,
			running,
			reported("needs_human"),
			reported("blocked"),
			interruptEngine(running),
		]) {
			expect(
				executionWorkflow(workflow, agents, { ...metadata, engine }),
			).toEqual(graph);
			expect(
				() =>
					executionWorkflow(workflow, agents, {
						...metadata,
						engine,
						phase: "develop",
					}),
				engine.status,
			).toThrow(/invalid standalone role execution checkpoint/i);
		}
		const engine = reported("completed");
		expect(engine.status).toBe("completed");
		expect(() =>
			executionWorkflow(workflow, agents, {
				...metadata,
				engine,
				phase: "missing",
			}),
		).toThrow(/invalid standalone role execution checkpoint/i);
	});
});
