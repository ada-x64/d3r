/* oxlint-disable no-magic-numbers -- Array positions and counts are lifecycle assertions. */
import { AgentSpec, Workflow } from "@d3r/core";
import {
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { type EngineState } from "../../core/engine.ts";
import {
	createWorkflowRuntime,
	type WorkflowReport,
} from "./workflow-runtime.ts";

/** Explicit gates exercise races without timers or model calls. */
const gate = () => {
	let resolve: (() => void) | undefined = undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve: resolve! };
};
/** A parallel batch and trailing role expose barrier and cancellation mistakes. */
const workflow = Workflow.parse({
	commands: {
		design: {
			description: "Design",
			chain: [
				{ kind: "parallel", agents: ["first", "second"] },
				{ kind: "agent", name: "last" },
			],
		},
	},
	vault: { dirs: [], template_kinds: [] },
});
/** Names alone select fake roles; definitions remain native resource objects. */
const agents = ["first", "second", "last"].map((name) => ({
	spec: AgentSpec.parse({
		name,
		tier: "low",
		description: name,
		capabilities: [],
	}),
	prompt: name,
}));
/** Fake routing has observable but inert checkpoint restoration. */
const router = () => ({
	prompt: vi.fn(
		async (_request: RuntimePrompt): Promise<RuntimeStopReason> => "completed",
	),
	dispose: vi.fn(async () => undefined),
	snapshot: vi.fn(() => ({ messages: [] })),
	restore: vi.fn(),
});
/** Requests intentionally have no external services. */
const request = (
	text: string,
	signal = new AbortController().signal,
): RuntimePrompt => ({
	content: [{ type: "text", text }],
	signal,
	emit: vi.fn(async () => undefined),
	activity: vi.fn(async () => undefined),
});
/** Typed access to persisted engine data keeps tests on the public snapshot API. */
const state = (runtime: RuntimeSession): EngineState =>
	(runtime.snapshot!() as { engine: EngineState }).engine;

// oxlint-disable-next-line max-statements -- Each race is isolated with its own gates and DI sessions.
describe("workflow runtime lifecycle", () => {
	it("freezes parallel inputs and collects outputs in declaration, not arrival order", async () => {
		const releaseFirst = gate();
		const firstStarted = gate();
		const secondFinished = gate();
		const seen: { name: string; text: string }[] = [];
		const createAgent = async (
			name: string,
			report: WorkflowReport,
		): Promise<RuntimeSession> => {
			if (name === "first") {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return {
				prompt: async (input) => {
					seen.push({ name, text: JSON.stringify(input.content) });
					report({ status: "completed", summary: `${name} output` });
					return "completed";
				},
				dispose: async () => {
					if (name === "second") {
						secondFinished.resolve();
					}
				},
			};
		};
		const runtime = createWorkflowRuntime({
			routing: router(),
			workflow,
			agents,
			createAgent,
		});
		const turn = runtime.prompt(request("/design topic"));
		await firstStarted.promise;
		await secondFinished.promise;
		await vi.waitFor(() =>
			expect(state(runtime).records[1].status).toBe("completed"),
		);
		expect(seen.map(({ name }) => name)).toEqual(["second"]);
		releaseFirst.resolve();
		await turn;
		expect(seen.find(({ name }) => name === "first")?.text).toBe(
			seen.find(({ name }) => name === "second")?.text,
		);
		const last = seen.find(({ name }) => name === "last")!.text;
		expect(last.indexOf("first output")).toBeLessThan(
			last.indexOf("second output"),
		);
	});
	it("restores mid-batch as interrupted without recreating children or replaying effects", async () => {
		const release = gate();
		const started = gate();
		const routing = router();
		const createAgent = vi.fn(
			async (
				name: string,
				report: WorkflowReport,
			): Promise<RuntimeSession> => ({
				prompt: async () => {
					if (name === "first") {
						started.resolve();
						await release.promise;
					}
					report({ status: "completed", summary: name });
					return "completed";
				},
				dispose: async () => undefined,
			}),
		);
		const runtime = createWorkflowRuntime({
			routing,
			workflow,
			agents,
			createAgent,
		});
		const turn = runtime.prompt(request("/design topic"));
		await started.promise;
		await vi.waitFor(() =>
			expect(state(runtime).records[1].status).toBe("completed"),
		);
		const snapshot = JSON.stringify(runtime.snapshot!());
		const restoredFactory = vi.fn(createAgent);
		const restoredRouting = router();
		const restored = createWorkflowRuntime({
			routing: restoredRouting,
			workflow,
			agents,
			createAgent: restoredFactory,
		});
		restored.restore!(snapshot);
		expect(restoredFactory).not.toHaveBeenCalled();
		expect(restoredRouting.prompt).not.toHaveBeenCalled();
		expect(
			state(restored)
				.records.slice(0, 2)
				.map(({ status }) => status),
		).toEqual(["interrupted", "completed"]);
		await restored.prompt(request("continue"));
		expect(restoredFactory).not.toHaveBeenCalled();
		await restored.prompt(request("abandon"));
		expect(restoredFactory).not.toHaveBeenCalled();
		release.resolve();
		await turn;
	});
	it("cancellation waits for every child and disposal before settling", async () => {
		const controller = new AbortController();
		const allStarted = gate();
		const cleanup = gate();
		const started: string[] = [];
		const disposed: string[] = [];
		const routing = router();
		const createAgent = async (name: string): Promise<RuntimeSession> => ({
			prompt: async (input) => {
				started.push(name);
				if (started.length === 2) {
					allStarted.resolve();
				}
				await new Promise<void>((resolve) =>
					input.signal.addEventListener("abort", () => resolve(), {
						once: true,
					}),
				);
				return "cancelled";
			},
			dispose: async () => {
				await cleanup.promise;
				disposed.push(name);
			},
		});
		const runtime = createWorkflowRuntime({
			routing,
			workflow,
			agents,
			createAgent,
		});
		let settled = false;
		const turn = runtime
			.prompt(request("/design topic", controller.signal))
			.then((reason) => {
				settled = true;
				return reason;
			});
		await allStarted.promise;
		expect(() => runtime.prompt(request("/design other"))).toThrow(
			/already running/,
		);
		expect(() => runtime.restore!(runtime.snapshot!())).toThrow(
			/already running/,
		);
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		cleanup.resolve();
		expect(await turn).toBe("cancelled");
		expect(disposed.toSorted()).toEqual(["first", "second"]);
		expect(started).not.toContain("last");
		expect(
			state(runtime)
				.records.slice(0, 2)
				.every(({ status }) => status === "interrupted"),
		).toBe(true);
		await runtime.prompt(request("continue"));
		expect(started).toHaveLength(2);
	});
	it("disposal aborts live children and waits for factories that have not resolved", async () => {
		const factoryStarted = gate();
		const releaseFactory = gate();
		const routing = router();
		const childPrompt = vi.fn(async () => "completed" as const);
		const childDispose = vi.fn(async () => undefined);
		const createAgent = async (): Promise<RuntimeSession> => {
			factoryStarted.resolve();
			await releaseFactory.promise;
			return { prompt: childPrompt, dispose: childDispose };
		};
		const runtime = createWorkflowRuntime({
			routing,
			workflow,
			agents,
			createAgent,
		});
		const turn = runtime.prompt(request("/design topic"));
		await factoryStarted.promise;
		let settled = false;
		const disposing = runtime.dispose().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(routing.dispose).not.toHaveBeenCalled();
		releaseFactory.resolve();
		await disposing;
		expect(await turn).toBe("cancelled");
		expect(childPrompt).not.toHaveBeenCalled();
		expect(childDispose).toHaveBeenCalledTimes(2);
		expect(routing.dispose).toHaveBeenCalledTimes(1);
		await runtime.dispose();
		expect(routing.dispose).toHaveBeenCalledTimes(1);
	});
	it("does not dispose a sibling-owned runtime when the factory incorrectly reuses it", async () => {
		const release = gate();
		const started = gate();
		const disposed = vi.fn(async () => undefined);
		const child: RuntimeSession = {
			prompt: async () => {
				started.resolve();
				await release.promise;
				return "completed";
			},
			dispose: disposed,
		};
		const runtime = createWorkflowRuntime({
			routing: router(),
			workflow,
			agents,
			createAgent: () => child,
		});
		const turn = runtime.prompt(request("/design topic"));
		await started.promise;
		await vi.waitFor(() =>
			expect(state(runtime).records[1].status).toBe("blocked"),
		);
		expect(disposed).not.toHaveBeenCalled();
		release.resolve();
		await turn;
		expect(disposed).toHaveBeenCalledTimes(1);
		expect(state(runtime).status).toBe("blocked");
	});
	it.each(["token_limit", "request_limit", "refused"] as const)(
		"does not accept a report when the child stops with %s",
		async (reason) => {
			const createAgent = vi.fn(
				async (
					_name: string,
					report: WorkflowReport,
				): Promise<RuntimeSession> => ({
					prompt: async () => {
						report({ status: "completed", summary: "partial" });
						return reason;
					},
					dispose: async () => undefined,
				}),
			);
			const runtime = createWorkflowRuntime({
				routing: router(),
				workflow,
				agents,
				createAgent,
			});
			await runtime.prompt(request("/design topic"));
			expect(state(runtime).status).toBe("blocked");
			expect(createAgent).toHaveBeenCalledTimes(2);
		},
	);
	it("joins siblings even when a factory fails and never starts the next batch", async () => {
		const release = gate();
		const started = gate();
		const disposed = vi.fn(async () => undefined);
		const createAgent = vi.fn(
			async (name: string, report: WorkflowReport): Promise<RuntimeSession> => {
				if (name === "first") {
					throw new Error("Factory failed");
				}
				return {
					prompt: async () => {
						started.resolve();
						await release.promise;
						report({ status: "completed", summary: name });
						return "completed";
					},
					dispose: disposed,
				};
			},
		);
		const runtime = createWorkflowRuntime({
			routing: router(),
			workflow,
			agents,
			createAgent,
		});
		let settled = false;
		const turn = runtime.prompt(request("/design topic")).then(() => {
			settled = true;
		});
		await started.promise;
		expect(settled).toBe(false);
		release.resolve();
		await turn;
		expect(disposed).toHaveBeenCalledTimes(1);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(state(runtime).status).toBe("blocked");
	});
	it("snapshots an in-flight routing turn from the last safe routing checkpoint", async () => {
		const routing = router();
		const started = gate();
		const release = gate();
		routing.prompt.mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return "completed";
		});
		const createAgent = vi.fn();
		const runtime = createWorkflowRuntime({
			routing,
			workflow,
			agents,
			createAgent,
		});
		const turn = runtime.prompt(request("ordinary effect"));
		await started.promise;
		const snapshot = runtime.snapshot!();
		expect(routing.snapshot).toHaveBeenCalledTimes(1);
		const otherRouter = router();
		const restored = createWorkflowRuntime({
			routing: otherRouter,
			workflow,
			agents,
			createAgent,
		});
		restored.restore!(snapshot);
		await restored.prompt(request("continue"));
		expect(otherRouter.prompt).not.toHaveBeenCalled();
		expect(createAgent).not.toHaveBeenCalled();
		await restored.prompt(request("restart"));
		expect(otherRouter.prompt.mock.calls[0][0].content).toEqual([
			{ type: "text", text: "ordinary effect" },
		]);
		release.resolve();
		await turn;
	});
	it.each(["prompt", "dispose"])(
		"fails closed when %s throws after a valid report",
		async (failing) => {
			const runtime = createWorkflowRuntime({
				routing: router(),
				workflow,
				agents,
				createAgent: (_name, report) => ({
					prompt: async () => {
						report({ status: "completed", summary: "Reported" });
						if (failing === "prompt") {
							throw new Error("after report");
						}
						return "completed";
					},
					dispose: async () => {
						if (failing === "dispose") {
							throw new Error("cleanup failed");
						}
					},
				}),
			});
			await runtime.prompt(request("/design topic"));
			expect(state(runtime).status).toBe("blocked");
			expect(state(runtime).records.at(-1)?.status).toBe("pending");
		},
	);
	it("waits for delegated configuration before disposing routing", async () => {
		const release = gate();
		const started = gate();
		const routing = router();
		const runtime = createWorkflowRuntime({
			routing: {
				...routing,
				setConfig: async () => {
					started.resolve();
					await release.promise;
					return [];
				},
			},
			workflow,
			agents,
			createAgent: vi.fn(),
		});
		const setting = runtime.setConfig!("model", "next");
		await started.promise;
		const disposing = runtime.dispose();
		await Promise.resolve();
		expect(routing.dispose).not.toHaveBeenCalled();
		release.resolve();
		await setting;
		await disposing;
		expect(routing.dispose).toHaveBeenCalledTimes(1);
	});
	it("does not expose side effects for an already-aborted request", async () => {
		const controller = new AbortController();
		controller.abort();
		const createAgent = vi.fn();
		const routing = router();
		const runtime = createWorkflowRuntime({
			routing,
			workflow,
			agents,
			createAgent,
		});
		expect(await runtime.prompt(request("/design", controller.signal))).toBe(
			"cancelled",
		);
		expect(createAgent).not.toHaveBeenCalled();
		expect(routing.prompt).not.toHaveBeenCalled();
	});
});
