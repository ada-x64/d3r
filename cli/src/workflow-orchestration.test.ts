/* oxlint-disable no-magic-numbers -- Evidence budgets and invocation counts are behavioral assertions. */
import { AgentSpec, Workflow } from "@d3r/core";
import { type EngineState } from "@d3r/core/engine";
import {
	type RuntimeActivity,
	type RuntimeContent,
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeStopReason,
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { type WorkflowContinuation } from "./workflow-continuations.ts";
import { type PhaseAction } from "./workflow-phase-tools.ts";
import {
	createWorkflowRuntime,
	type WorkflowReport,
	type WorkflowRuntimeOptions,
} from "./workflow-runtime.ts";
import { WorkflowTopicName, renderWorkflowTopic } from "./workflow-topic.ts";

/** Small real graphs expose human barriers, independent entry, and partial batches. */
const workflow = Workflow.parse({
	commands: {
		design: {
			description: "Agree on scope and plan",
			chain: [
				{ kind: "agent", name: "first" },
				{ kind: "human", prompt: "Approve the scope" },
				{ kind: "agent", name: "second" },
				{ kind: "human", prompt: "Approve the plan" },
				{ kind: "agent", name: "last" },
			],
		},
		develop: {
			description: "Implement directly from conversation",
			chain: [{ kind: "agent", name: "last" }],
		},
		audit: {
			description: "Inspect in parallel before concluding",
			chain: [
				{ kind: "parallel", agents: ["first", "second"] },
				{ kind: "agent", name: "last" },
			],
		},
	},
	vault: { dirs: [], template_kinds: [] },
});
/** No resource discovery, documents, providers, or workspace effects are needed. */
const agents = ["first", "second", "last"].map((name) => ({
	spec: AgentSpec.parse({
		name,
		tier: "low",
		description: name,
		capabilities: [],
	}),
	prompt: name,
}));
/** Handoffs contain conversation facts, not invented artifact references. */
const brief = {
	goal: "Stop cancelled searches",
	context: "Search keeps running after the user cancels.",
	acceptanceCriteria: [
		"Cancellation stops the search",
		"Regression tests pass",
	],
	constraints: ["Do not commit or push"],
};
/** Start without silently choosing a develop mode. */
const start = (phase: string): PhaseAction => ({
	action: "start",
	phase,
	brief,
});
/** Explicit gates make role settlement and cleanup separately observable. */
const gate = () => {
	let resolve: (() => void) | undefined = undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve: resolve! };
};
/** Listen before cancellation, including the already-aborted case. */
const untilAborted = (signal: AbortSignal): Promise<void> => {
	if (signal.aborted) {
		return Promise.resolve();
	}
	const stopped = gate();
	signal.addEventListener("abort", stopped.resolve, { once: true });
	return stopped.promise;
};
/** Keep assertions about delivered prose independent of attachment encoding. */
const textOf = (content: readonly RuntimeContent[]): string =>
	content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
/** A fake backend validates its own persisted conversations and settled effects. */
const RoleSnapshot = z
	.object({
		name: z.string(),
		messages: z.array(z.string()),
		effects: z.array(z.string()),
	})
	.strict();
/** Only these public checkpoint fields are inspected by the tests. */
const checkpoint = (runtime: RuntimeSession) =>
	runtime.snapshot!() as {
		engine: EngineState | null;
		continuations?: WorkflowContinuation[];
		input: RuntimeContent[];
		history: RuntimeContent[];
		phaseHistory?: RuntimeContent[];
		topic?: string;
		routingInput: RuntimeContent[];
		routingHistory: number;
		routing: unknown;
	};
/** Router scripts call the actual runtime transition under the prompt's tool context. */
interface RouterTurn {
	request: RuntimePrompt;
	context: RuntimeToolContext;
	run: (
		action: PhaseAction,
		context?: RuntimeToolContext,
	) => Promise<RuntimeToolResult>;
}
/** Roles retain backend-owned state rather than a test-side workflow state machine. */
type RoleBehavior = (
	report: WorkflowReport,
	request: RuntimePrompt,
	state: z.infer<typeof RoleSnapshot>,
) => Promise<RuntimeStopReason>;
/** Each ordinary role has an observable simulated effect and a structured report. */
const completeRole: RoleBehavior = async (report, _request, state) => {
	state.effects.push(`${state.name} effect`);
	report({ status: "completed", summary: `${state.name} finished` });
	return "completed";
};
/** Inject only IO; prompts, checkpoints, batch transitions, and recovery stay production-owned. */
const harness = (
	options: {
		graph?: Workflow;
		orchestratorContext?: WorkflowRuntimeOptions["orchestratorContext"];
	} = {},
) => {
	const control = {
		route: async ({
			request,
		}: RouterTurn): Promise<RuntimeStopReason | void> => {
			await request.emit({
				kind: "text",
				messageId: "reply",
				text: "Let's discuss the search.",
			});
		},
		role: completeRole,
		activity: async (_event: RuntimeActivity): Promise<void> => undefined,
		cleanup: async (_name: string): Promise<void> => undefined,
		snapshotFailure: "",
		restoreFailure: "",
	};
	const messages: string[] = [];
	const contexts: RuntimeToolContext[] = [];
	const chunks: string[] = [];
	const children: {
		name: string;
		state: z.infer<typeof RoleSnapshot>;
		session: ReturnType<typeof makeRole>;
	}[] = [];
	const makeRole = (name: string, report: WorkflowReport) => {
		const state = { name, messages: [] as string[], effects: [] as string[] };
		const session = {
			prompt: vi.fn(async (request: RuntimePrompt) => {
				state.messages.push(textOf(request.content));
				return control.role(report, request, state);
			}),
			snapshot: vi.fn(() => {
				if (control.snapshotFailure === name) {
					throw new Error("Role snapshot failed");
				}
				return structuredClone(state);
			}),
			restore: vi.fn((value: unknown) => {
				const saved = RoleSnapshot.parse(value);
				if (saved.name !== name || control.restoreFailure === name) {
					throw new Error("Role restore failed");
				}
				Object.assign(state, structuredClone(saved));
			}),
			dispose: vi.fn(async () => control.cleanup(name)),
		};
		children.push({ name, state, session });
		return session;
	};
	const createAgent = vi.fn(makeRole);
	const routing = {
		prompt: vi.fn(
			async (request: RuntimePrompt): Promise<RuntimeStopReason> => {
				messages.push(textOf(request.content));
				const context: RuntimeToolContext = {
					toolCallId: "phase-call",
					cwd: process.cwd(),
					roots: [process.cwd()],
					signal: request.signal,
				};
				contexts.push(context);
				const reason = await control.route({
					request,
					context,
					run: (action, tool = context) => runtime.runPhase(action, tool),
				});
				return reason ?? (request.signal.aborted ? "cancelled" : "completed");
			},
		),
		snapshot: vi.fn(() => ({ messages: [...messages] })),
		restore: vi.fn((value: unknown) => {
			const saved = z
				.object({ messages: z.array(z.string()) })
				.strict()
				.parse(value);
			messages.splice(0, messages.length, ...saved.messages);
		}),
		dispose: vi.fn(async () => undefined),
	};
	const runtime = createWorkflowRuntime({
		routing,
		workflow: options.graph ?? workflow,
		agents,
		createAgent,
		orchestrated: true,
		orchestratorContext: options.orchestratorContext,
	});
	onTestFinished(() => runtime.dispose());
	const prompt = (
		text: string,
		route = control.route,
		signal = new AbortController().signal,
	) => {
		control.route = route;
		return runtime.prompt({
			content: [{ type: "text", text }],
			signal,
			emit: async ({ text: chunk }) => {
				chunks.push(chunk);
			},
			activity: (event) => control.activity(event),
		});
	};
	return {
		runtime,
		routing,
		control,
		createAgent,
		children,
		contexts,
		chunks,
		prompt,
		saved: () => checkpoint(runtime),
	};
};
/** Cancel only after one sibling's outcome is recorded, then hold the other child's disposal. */
const partialBatch = async (failure?: "snapshot" | "cleanup") => {
	const h = harness();
	const controller = new AbortController();
	const secondStarted = gate();
	const firstFinished = gate();
	const cleanupStarted = gate();
	const release = gate();
	h.control.snapshotFailure = failure === "snapshot" ? "second" : "";
	h.control.role = async (report, request, state) => {
		if (state.name !== "second") {
			return completeRole(report, request, state);
		}
		state.effects.push("Partial edit settled before cancellation");
		secondStarted.resolve();
		await untilAborted(request.signal);
		return "cancelled";
	};
	h.control.activity = async (event) => {
		if (
			event.kind === "tool" &&
			event.title === "first" &&
			event.status === "completed"
		) {
			firstFinished.resolve();
		}
	};
	h.control.cleanup = async (name) => {
		if (name === "second") {
			cleanupStarted.resolve();
			await release.promise;
			if (failure === "cleanup") {
				throw new Error("Role cleanup failed");
			}
		}
	};
	const turn = h.prompt(
		"Inspect the search cancellation",
		async ({ run }) => {
			await run(start("audit"));
		},
		controller.signal,
	);
	await Promise.all([secondStarted.promise, firstFinished.promise]);
	controller.abort();
	await cleanupStarted.promise;
	return { h, turn, release: release.resolve };
};
/** Every tool result should remain model-facing prose, never an internal report dump. */
const expectProse = (result: RuntimeToolResult): void => {
	expect(result.text.trim().length).toBeGreaterThan(0);
	expect(() => JSON.parse(result.text)).toThrow();
	expect(result.text).not.toMatch(
		/"(?:records|continuations|activeBatch|outcome)"\s*:/,
	);
};

describe("workflow topics and host context", () => {
	it("assigns a generated topic before every agent factory and shares its map across parallel and later roles", async () => {
		const actions: PhaseAction[] = [
			start("audit"),
			{ action: "role", role: "first", brief },
		];
		await Promise.all(
			actions.map(async (action) => {
				const h = harness();
				const assigned: (string | undefined)[] = [];
				const makeRole = h.createAgent.getMockImplementation()!;
				h.createAgent.mockImplementation((name, report) => {
					assigned.push(h.saved().topic);
					return makeRole(name, report);
				});
				await h.prompt("Discuss cancellation without starting work");
				expect(h.saved().topic).toBeUndefined();
				await h.prompt("Inspect cancellation now", async ({ run }) => {
					expect(await run(action)).not.toMatchObject({ isError: true });
				});
				const topic = WorkflowTopicName.parse(h.saved().topic);
				expect(topic).toMatch(/^stop-cancelled-searches-[a-f0-9]{8}$/);
				expect(h.children.map(({ name }) => name)).toEqual(
					action.action === "start" ? ["first", "second", "last"] : ["first"],
				);
				expect(assigned).toEqual(h.children.map(() => topic));
				const map = renderWorkflowTopic(topic);
				for (const { session } of h.children) {
					const [[request]] = session.prompt.mock.calls;
					expect(request.content).toContainEqual({ type: "text", text: map });
					expect(textOf(request.content)).toContain(
						`process/designs/${topic}/research.md`,
					);
					expect(textOf(request.content)).toContain(`process/tasks/${topic}`);
				}
			}),
		);
	});

	it("keeps the topic across a reworded correction, resumed roles, reload, and completion archival", async () => {
		const h = harness();
		h.control.role = async (report, request, state) => {
			if (state.name === "second") {
				report({
					status: "needs_human",
					summary: "Cancel queued searches too?",
				});
				return "completed";
			}
			return completeRole(report, request, state);
		};
		await h.prompt("Inspect search cancellation", async ({ run }) => {
			await run(start("audit"));
		});
		const saved = h.saved();
		const topic = WorkflowTopicName.parse(saved.topic);
		expect(saved.engine).toMatchObject({ status: "waiting" });
		const restored = harness();
		restored.runtime.restore!(JSON.stringify(saved));
		expect(restored.saved().topic).toBe(topic);
		expect(restored.createAgent).not.toHaveBeenCalled();
		const correction =
			"Also stop queued requests, but preserve cached results.";
		await restored.prompt(correction, async ({ run, request }) => {
			expect(textOf(request.content)).toContain(renderWorkflowTopic(topic));
			const result = await run({
				action: "continue",
				instructions: correction,
			});
			expect(result.text).toContain("Status: completed");
			expect(restored.saved().topic).toBe(topic);
		});
		expect(restored.children.map(({ name }) => name)).toEqual([
			"second",
			"last",
		]);
		expect(
			restored.children[0].session.restore,
		).toHaveBeenCalledExactlyOnceWith(saved.continuations![0].checkpoint);
		for (const { session } of [...h.children, ...restored.children]) {
			expect(session.prompt.mock.calls[0][0].content).toContainEqual({
				type: "text",
				text: renderWorkflowTopic(topic),
			});
		}
		for (const { state } of restored.children) {
			expect(state.messages.at(-1)).toContain(correction);
		}
		const reloaded = harness();
		reloaded.runtime.restore!(JSON.stringify(restored.saved()));
		await reloaded.prompt(
			"Discuss the completed inspection",
			async ({ request }) => {
				expect(textOf(request.content)).toContain("Most recent topic");
				expect(textOf(request.content)).toContain(renderWorkflowTopic(topic));
			},
		);
		expect(reloaded.saved()).toMatchObject({ topic, engine: null });
		expect(reloaded.createAgent).not.toHaveBeenCalled();
	});

	it("retains an abandoned topic for explicit follow-on reuse but gives a new same-goal task a fresh suffix", async () => {
		const h = harness();
		await h.prompt("Design cancellation", async ({ run }) => {
			await run(start("design"));
		});
		const topic = WorkflowTopicName.parse(h.saved().topic);
		await h.prompt("Abandon this design", async ({ run }) => {
			expect(
				await run({
					action: "abandon",
					reason: "Inspect independently instead",
				}),
			).not.toMatchObject({ isError: true });
			const status = await run({ action: "status" });
			expect(status.text).toContain("Most recent topic");
			expect(status.text).toContain(renderWorkflowTopic(topic));
		});
		expect(h.saved()).toMatchObject({ topic, engine: null });
		await h.prompt(
			"Inspect that same topic independently",
			async ({ run, request }) => {
				expect(textOf(request.content)).toContain("Most recent topic");
				expect(textOf(request.content)).toContain(renderWorkflowTopic(topic));
				await run({ action: "role", role: "last", brief, topic });
			},
		);
		expect(h.saved().topic).toBe(topic);
		await h.prompt(
			"Start a new task with the same goal",
			async ({ run, request }) => {
				expect(textOf(request.content)).toContain("Most recent topic");
				expect(h.saved()).toMatchObject({ topic, engine: null });
				await run({ action: "role", role: "second", brief });
			},
		);
		const fresh = WorkflowTopicName.parse(h.saved().topic);
		expect(fresh).toMatch(/^stop-cancelled-searches-[a-f0-9]{8}$/);
		expect(fresh).not.toBe(topic);
		await h.prompt("Return to the original topic's design", async ({ run }) => {
			await run({ action: "start", phase: "design", brief, topic });
		});
		expect(h.saved().topic).toBe(topic);
		expect(h.children.map(({ name }) => name)).toEqual([
			"first",
			"last",
			"second",
			"first",
		]);
		for (const [index, child] of h.children.entries()) {
			expect(child.session.prompt.mock.calls[0][0].content).toContainEqual({
				type: "text",
				text: renderWorkflowTopic(index === 2 ? fresh : topic),
			});
		}
	});

	it("reuses a supplied safe topic exactly and never assigns one to rejected or already-aborted starts", async () => {
		const h = harness();
		await h.prompt("Do not accept an invalid start", async ({ run }) => {
			expect(await run(start("unknown"))).toMatchObject({ isError: true });
			expect(
				await run({ action: "role", role: "implementor", brief }),
			).toMatchObject({ isError: true });
		});
		expect(h.saved().topic).toBeUndefined();
		expect(h.createAgent).not.toHaveBeenCalled();
		const controller = new AbortController();
		await expect(
			h.prompt(
				"Cancel before accepting work",
				async ({ run }) => {
					controller.abort();
					await expect(run(start("audit"))).rejects.toThrow();
					await expect(
						run({
							action: "role",
							role: "first",
							brief,
							topic: "not-accepted",
						}),
					).rejects.toThrow();
				},
				controller.signal,
			),
		).resolves.toBe("cancelled");
		expect(h.saved().topic).toBeUndefined();
		expect(h.createAgent).not.toHaveBeenCalled();
		const topic = WorkflowTopicName.parse("existing-search-cancellation");
		await h.prompt("Use the existing topic", async ({ run }) => {
			await run({ action: "start", phase: "design", brief, topic });
		});
		const before = h.saved();
		expect(before.topic).toBe(topic);
		await h.prompt("Do not replace unfinished work", async ({ run }) => {
			expect(await run(start("audit"))).toMatchObject({ isError: true });
			expect(
				await run({
					action: "role",
					role: "last",
					brief,
					topic: "replacement-topic",
				}),
			).toMatchObject({ isError: true });
		});
		expect(h.saved()).toMatchObject({
			topic,
			engine: before.engine,
			input: before.input,
		});
		expect(h.children).toHaveLength(1);
		expect(
			h.children[0].session.prompt.mock.calls[0][0].content,
		).toContainEqual({
			type: "text",
			text: renderWorkflowTopic(topic),
		});
	});

	it("rejects malformed and non-orchestrated checkpoint topics atomically before routing restore", async () => {
		const source = harness();
		await source.prompt("Design the source task", async ({ run }) => {
			await run(start("design"));
		});
		const saved = source.saved();
		const target = harness();
		await target.prompt("Retain the target task", async ({ run }) => {
			await run({
				action: "start",
				phase: "design",
				brief,
				topic: "target-task",
			});
		});
		const before = target.saved();
		const malformed = [
			"",
			"../escape",
			"/absolute",
			"nested/topic",
			String.raw`nested\topic`,
			"Uppercase",
			"has space",
			"safe\n",
			"aux",
			"a".repeat(81),
			null,
			7,
			{ name: "topic" },
		];
		for (const invalid of [
			...malformed.map((topic) => ({ ...saved, topic })),
			{ ...saved, orchestrated: false },
			{ ...saved, orchestrated: undefined },
		]) {
			expect(() => target.runtime.restore!(JSON.stringify(invalid))).toThrow(
				/topic/i,
			);
			expect(target.routing.restore).not.toHaveBeenCalled();
			expect(target.saved()).toEqual(before);
		}
		expect(target.routing.prompt).toHaveBeenCalledOnce();
		expect(target.children).toHaveLength(1);
	});

	it("resumes an old active checkpoint without inventing a topic or silently rerouting its task", async () => {
		const source = harness();
		await source.prompt("Design cancellation", async ({ run }) => {
			await run(start("design"));
		});
		const legacy = source.saved();
		delete legacy.topic;
		const target = harness();
		await target.prompt("Inspect a different topic", async ({ run }) => {
			await run({
				action: "role",
				role: "first",
				brief,
				topic: "unrelated-topic",
			});
		});
		target.runtime.restore!(JSON.stringify(legacy));
		expect(target.saved().topic).toBeUndefined();
		expect(target.saved().engine).toEqual(legacy.engine);
		await target.prompt(
			"Explain where the original task paused",
			async ({ request, run }) => {
				expect(textOf(request.content)).toContain("Approve the scope");
				expect(textOf(request.content)).not.toMatch(
					/Shared topic|Topic name:|unrelated-topic/,
				);
				expect(await run(start("audit"))).toMatchObject({ isError: true });
			},
		);
		expect(target.saved().engine).toEqual(legacy.engine);
		expect(target.children).toHaveLength(1);
		await target.prompt(
			"Approve the scope, retaining the original artifact locations",
			async ({ run }) => {
				const result = await run({
					action: "continue",
					instructions: "Approve the original scope",
				});
				expect(result.isError).not.toBe(true);
				expect(result.text).toContain("Approve the plan");
			},
		);
		expect(target.children.map(({ name }) => name)).toEqual([
			"first",
			"second",
		]);
		expect(target.children[1].state.messages[0]).not.toMatch(
			/Shared topic|Topic name:|process\/designs\//,
		);
		expect(target.saved().topic).toBeUndefined();
		const reloaded = harness();
		reloaded.runtime.restore!(JSON.stringify(target.saved()));
		expect(reloaded.saved().topic).toBeUndefined();
		expect(reloaded.saved().engine).toEqual(target.saved().engine);
		expect(reloaded.createAgent).not.toHaveBeenCalled();
	});

	it("refreshes cancellable host metadata before routing without promoting it to user history or worker constraints", async () => {
		const metadata = [
			"Host observation: vault absent; HOST_ONLY_INITIAL",
			"Host observation: vault ready; HOST_ONLY_REFRESHED",
			"Host observation: HOST_ONLY_CANCELLED",
			"Host observation: vault changed again; HOST_ONLY_RECOVERED",
		];
		const orchestratorContext = vi.fn(
			async (_signal: AbortSignal) => metadata[0],
		);
		const h = harness({ orchestratorContext });
		await h.prompt("Discuss the cancellation fix", async ({ request }) => {
			expect(request.content.at(-1)).toEqual({
				type: "text",
				text: metadata[0],
			});
			expect(orchestratorContext).toHaveBeenCalledExactlyOnceWith(
				request.signal,
			);
		});
		orchestratorContext.mockResolvedValueOnce(metadata[1]);
		const content: RuntimeContent[] = [
			{ type: "text", text: "Design cancellation; do not commit or push" },
		];
		const original = structuredClone(content);
		h.control.route = async ({ request, run }) => {
			expect(request.content.at(-1)).toEqual({
				type: "text",
				text: metadata[1],
			});
			expect(textOf(request.content)).not.toContain(metadata[0]);
			expect(orchestratorContext).toHaveBeenCalledTimes(2);
			expect(orchestratorContext).toHaveBeenLastCalledWith(request.signal);
			await run(start("design"));
		};
		await h.runtime.prompt({
			content,
			signal: new AbortController().signal,
			emit: async () => undefined,
		});
		expect(content).toEqual(original);
		const before = h.saved();
		const entered = gate();
		orchestratorContext.mockImplementationOnce(async (signal) => {
			entered.resolve();
			await untilAborted(signal);
			expect(signal.aborted).toBe(true);
			return metadata[2];
		});
		const controller = new AbortController();
		const turn = h.prompt(
			"Discard this cancelled instruction",
			async ({ run }) => {
				await run({ action: "continue", instructions: "Approve the scope" });
			},
			controller.signal,
		);
		try {
			await entered.promise;
			expect(h.routing.prompt).toHaveBeenCalledTimes(2);
		} finally {
			controller.abort();
			await expect(turn).resolves.toBe("cancelled");
		}

		expect(h.routing.prompt).toHaveBeenCalledTimes(2);
		expect(h.saved()).toMatchObject({
			topic: before.topic,
			engine: before.engine,
			input: before.input,
			history: before.history,
			routingHistory: before.routingHistory,
		});
		orchestratorContext.mockResolvedValueOnce(metadata[3]);
		await h.prompt("Approve the original scope", async ({ request, run }) => {
			expect(request.content.at(-1)).toEqual({
				type: "text",
				text: metadata[3],
			});
			expect(textOf(request.content)).not.toContain(metadata[2]);
			expect(orchestratorContext).toHaveBeenCalledTimes(4);
			expect(orchestratorContext).toHaveBeenLastCalledWith(request.signal);
			await run({
				action: "continue",
				instructions: "Approve the original scope",
			});
		});
		const saved = h.saved();
		expect(
			textOf([
				...saved.input,
				...saved.history,
				...saved.routingInput,
				...(saved.phaseHistory ?? []),
			]),
		).not.toMatch(/HOST_ONLY_|Discard this cancelled instruction/);
		expect(h.children.map(({ name }) => name)).toEqual(["first", "second"]);
		for (const { state } of h.children) {
			expect(state.messages[0]).toContain(brief.constraints[0]);
			expect(state.messages[0]).not.toMatch(
				/HOST_ONLY_|Discard this cancelled instruction/,
			);
		}
	});
});

describe("persistent workflow orchestration", () => {
	it("keeps ordinary conversation and slash intent in the same routing session across restoration", async () => {
		const h = harness();
		await h.prompt("Why does cancellation matter?");
		await h.prompt("/develop is an option, but explain the tradeoff first");
		expect(h.routing.prompt).toHaveBeenCalledTimes(2);
		expect(h.createAgent).not.toHaveBeenCalled();
		expect(h.saved().engine).toBeNull();
		expect(h.routing.restore).not.toHaveBeenCalled();
		expect(h.routing.dispose).not.toHaveBeenCalled();
		expect(h.routing.snapshot().messages).toEqual([
			expect.stringContaining("Why does cancellation matter?"),
			expect.stringContaining("explain the tradeoff first"),
		]);
		expect(h.routing.prompt.mock.calls[1][0].content).not.toContainEqual({
			type: "text",
			text: "Why does cancellation matter?",
		});
		const saved = h.runtime.snapshot!();
		await h.runtime.dispose();
		const restored = harness();
		restored.runtime.restore!(JSON.stringify(saved));
		expect(restored.routing.prompt).not.toHaveBeenCalled();
		await restored.prompt("Keep discussing; do not start yet");
		expect(restored.routing.snapshot().messages).toHaveLength(3);
		expect(restored.createAgent).not.toHaveBeenCalled();
		expect(restored.chunks).toEqual(["Let's discuss the search."]);
	});

	it("does not archive cancelled text-only routing turns or advance their delivery position", async () => {
		await Promise.all(
			["stop reason", "signal"].map(async (cancellation) => {
				const h = harness();
				const approved =
					"Keep search ranking unchanged while fixing cancellation.";
				await h.prompt(approved);
				await h.prompt("Inspect the approved scope", async ({ run }) => {
					await run(start("audit"));
				});
				const before = h.saved();
				const controller = new AbortController();
				const entered = gate();
				const release = gate();
				const discarded = "Replace search ranking with sponsored results.";
				const partial = "Tentative ranking proposal, not a completed answer.";
				const turn = h.prompt(
					discarded,
					async ({ request }) => {
						await request.emit({
							kind: "text",
							messageId: "partial",
							text: partial,
						});
						entered.resolve();
						await release.promise;
						return cancellation === "signal" ? "completed" : "cancelled";
					},
					controller.signal,
				);
				try {
					await entered.promise;
					if (cancellation === "signal") {
						controller.abort();
					}
				} finally {
					release.resolve();
					await expect(turn).resolves.toBe("cancelled");
				}
				expect(controller.signal.aborted).toBe(cancellation === "signal");
				expect(h.saved().history.length).toBeGreaterThan(before.routingHistory);
				expect(textOf(h.saved().history)).not.toContain(discarded);
				expect(textOf(h.saved().history)).not.toContain(partial);
				expect(h.saved()).toMatchObject({
					routingHistory: before.routingHistory,
					engine: null,
				});
				expect(h.children).toHaveLength(3);
				expect(h.chunks).toContain(partial);
				await h.prompt(
					"Inspect cancellation under the agreed scope",
					async ({ run, request }) => {
						expect(textOf(request.content)).toContain("first finished");
						const result = await run(start("audit"));
						expect(result.text).toContain("Status: completed");
					},
				);
				expect(h.children).toHaveLength(6);
				for (const { state } of h.children.slice(3)) {
					expect(state.messages[0]).toContain(approved);
					expect(state.messages[0]).not.toContain(discarded);
					expect(state.messages[0]).not.toContain(partial);
				}
			}),
		);
	});

	it("preserves the generic runtime's legacy default when orchestration is omitted", async () => {
		const routing = {
			prompt: vi.fn(async (): Promise<RuntimeStopReason> => "completed"),
			dispose: vi.fn(async () => undefined),
		};
		const createAgent = vi.fn(
			(_name: string, report: WorkflowReport): RuntimeSession => ({
				prompt: async () => {
					report({ status: "completed", summary: "Inspected" });
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
		onTestFinished(() => runtime.dispose());
		await runtime.prompt({
			content: [{ type: "text", text: "/audit search" }],
			signal: new AbortController().signal,
			emit: async () => undefined,
		});
		expect(createAgent.mock.calls.map(([name]) => name)).toEqual([
			"first",
			"second",
			"last",
		]);
		expect(routing.prompt).not.toHaveBeenCalled();
	});

	it("rejects phase tools outside a prompt and from an aborted active context without effects", async () => {
		const h = harness();
		await h.prompt("Only discuss");
		const [context] = h.contexts;
		const actions: PhaseAction[] = [
			start("audit"),
			{ action: "status" },
			{ action: "continue", instructions: "resume" },
			{ action: "abandon", reason: "stop" },
		];
		await Promise.all(
			actions.map((action) =>
				expect(h.runtime.runPhase(action, context)).rejects.toThrow(),
			),
		);
		const controller = new AbortController();
		await expect(
			h.prompt(
				"Cancel before tools",
				async ({ run }) => {
					controller.abort();
					await Promise.all(
						actions.map((action) => expect(run(action)).rejects.toThrow()),
					);
				},
				controller.signal,
			),
		).resolves.toBe("cancelled");
		expect(h.saved().engine).toBeNull();
		expect(h.createAgent).not.toHaveBeenCalled();
		await h.runtime.dispose();
		await expect(h.runtime.runPhase(start("audit"), context)).rejects.toThrow();
	});

	it("rejects a non-aborted context from an earlier turn while another prompt is active", async () => {
		const h = harness();
		await h.prompt("Remember this conversation");
		const [stale] = h.contexts;
		expect(stale.signal.aborted).toBe(false);
		await h.prompt(
			"Still discussing, not authorizing work",
			async ({ run, context }) => {
				expect(context.signal).not.toBe(stale.signal);
				await expect(run(start("audit"), stale)).rejects.toThrow();
				await expect(run({ action: "status" }, stale)).rejects.toThrow();
				expectProse(await run({ action: "status" }));
			},
		);
		expect(h.createAgent).not.toHaveBeenCalled();
		expect(h.saved().engine).toBeNull();
	});

	it("allows only one start or continue per user turn and never auto-answers human checkpoints", async () => {
		const h = harness();
		await h.prompt("Design the cancellation fix", async ({ run, request }) => {
			const result = await run(start("design"));
			expect(result.text).toContain("Approve the scope");
			expect(
				await run({ action: "continue", instructions: "The router approves" }),
			).toMatchObject({ isError: true });
			expect(
				await run({ action: "abandon", reason: "Skip the checkpoint" }),
			).toMatchObject({ isError: true });
			const status = await run({ action: "status" });
			expect(status.text).toContain("Status: waiting");
			await request.emit({
				kind: "text",
				messageId: "question",
				text: result.text,
			});
		});
		expect(h.children.map(({ name }) => name)).toEqual(["first"]);
		expect(
			h
				.saved()
				.engine?.records.filter(({ kind }) => kind === "human")
				.every(({ answer }) => answer === undefined),
		).toBe(true);
		const waiting = h.saved().engine;
		await h.prompt("Why is approval needed?", async ({ run, request }) => {
			const status = await run({ action: "status" });
			expect(status.text).toContain("Approve the scope");
			await request.emit({
				kind: "text",
				messageId: "explanation",
				text: "Scope approval keeps implementation within your chosen limits.",
			});
		});
		expect(h.saved().engine).toEqual(waiting);
		expect(h.children).toHaveLength(1);
		await h.prompt("I approve the scope", async ({ run, request }) => {
			expect(textOf(request.content)).toContain("Approve the scope");
			const result = await run({
				action: "continue",
				instructions: "I approve the scope",
			});
			expect(result.text).toContain("Approve the plan");
			expect(
				await run({
					action: "continue",
					instructions: "Also approve the plan",
				}),
			).toMatchObject({ isError: true });
		});
		expect(h.children.map(({ name }) => name)).toEqual(["first", "second"]);
		await h.prompt("I approve the plan", async ({ run }) => {
			const result = await run({
				action: "continue",
				instructions: "I approve the plan",
			});
			expect(result.text).toContain("Status: completed");
		});
		expect(
			h
				.saved()
				.engine?.records.filter(({ kind }) => kind === "human")
				.map(({ answer }) => answer),
		).toEqual(["I approve the scope", "I approve the plan"]);
		expect(h.routing.prompt).toHaveBeenCalledTimes(4);
		expect(h.routing.restore).not.toHaveBeenCalled();
		expect(h.routing.dispose).not.toHaveBeenCalled();
	});

	it("permits explicit abandon then direct develop in one turn without documents or an assumed mode", async () => {
		const h = harness();
		await h.prompt("Design this", async ({ run }) => {
			await run(start("design"));
		});
		const [first] = h.children;
		await h.prompt(
			"Abandon design and develop from our conversation instead",
			async ({ run }) => {
				const abandoned = await run({
					action: "abandon",
					reason: "User chose implementation instead",
				});
				expect(abandoned.isError).not.toBe(true);
				expect(abandoned.text).toMatch(/effects remain/i);
				const result = await run(start("develop"));
				expect(result.isError).not.toBe(true);
				expect(result.text).toMatch(/semi.*auto/i);
			},
		);
		expect(h.saved().engine).toMatchObject({
			command: "develop",
			status: "waiting",
			mode: null,
			pause: { kind: "mode" },
		});
		expect(h.children).toHaveLength(1);
		expect(first.state.effects).toEqual(["first effect"]);
		await h.prompt("Use auto", async ({ run }) => {
			await run({ action: "continue", instructions: "auto" });
		});
		expect(h.saved().engine).toMatchObject({
			command: "develop",
			status: "completed",
			mode: "auto",
		});
		const worker = h.children.find(({ name }) => name === "last")!;
		expect(worker.state.messages[0]).toContain(brief.goal);
		expect(worker.state.messages[0]).toContain(brief.context);
		expect(worker.state.messages[0]).toContain(brief.constraints[0]);
		expect(worker.state.messages[0]).toContain("first finished");
		expect(h.children.map(({ name }) => name)).toEqual(["first", "last"]);
	});

	it("retains a rejected start in router discussion but excludes it from active role context after reload", async () => {
		const h = harness();
		const approved = "Keep search ranking unchanged while fixing cancellation.";
		await h.prompt(approved);
		await h.prompt("Design this", async ({ run }) => {
			await run(start("design"));
		});
		const before = h.saved();
		const replacement =
			"Start audit instead and replace search ranking with sponsored results.";
		const refusal = "The sponsored-ranking proposal is not authorized.";
		await h.prompt(replacement, async ({ run, request }) => {
			const result = await run({
				action: "start",
				phase: "audit",
				brief: { ...brief, goal: replacement },
			});
			expect(result.isError).toBe(true);
			expect(result.text).toContain("Approve the scope");
			const status = await run({ action: "status" });
			expect(status.text).toContain("Phase: design");
			await request.emit({ kind: "text", messageId: "refusal", text: refusal });
		});
		expect(h.saved().engine).toEqual(before.engine);
		expect(h.saved().input).toEqual(before.input);
		expect(h.children).toHaveLength(1);
		expect(h.children[0].state.effects).toEqual(["first effect"]);
		expect(h.routing.restore).not.toHaveBeenCalled();
		const saved = h.runtime.snapshot!();
		await h.runtime.dispose();
		const restored = harness();
		restored.runtime.restore!(JSON.stringify(saved));
		expect(restored.routing.snapshot().messages.join("\n")).toContain(
			replacement,
		);
		expect(textOf(restored.saved().history)).toContain(refusal);
		await restored.prompt(
			"I approve the original cancellation scope",
			async ({ run }) => {
				const result = await run({
					action: "continue",
					instructions: "Proceed with the cancellation-only design",
				});
				expect(result.text).toContain("Approve the plan");
			},
		);
		expect(restored.children.map(({ name }) => name)).toEqual(["second"]);
		const [worker] = restored.children;
		expect(worker.state.messages[0]).toContain(approved);
		expect(worker.state.messages[0]).toContain(
			"Proceed with the cancellation-only design",
		);
		expect(worker.state.messages[0]).not.toContain(replacement);
		expect(worker.state.messages[0]).not.toContain(refusal);
	});

	it("passes the current correction to a resumed needs_human role and later roles before routing archives the turn", async () => {
		const h = harness();
		h.control.role = async (report, request, state) => {
			if (state.name === "second") {
				state.effects.push("Inspected the cancellation API");
				report({
					status: "needs_human",
					summary: "Should queued searches be cancelled too?",
				});
				return "completed";
			}
			return completeRole(report, request, state);
		};
		await h.prompt("Inspect search cancellation", async ({ run }) => {
			const result = await run(start("audit"));
			expect(result.text).toContain("Should queued searches be cancelled too?");
		});
		const waiting = h.saved();
		expect(waiting.engine).toMatchObject({
			status: "waiting",
			pause: { kind: "report" },
		});
		expect(waiting.continuations).toHaveLength(1);
		const completed = waiting.engine!.records.find(
			({ role }) => role === "first",
		)!;
		expect(h.children.map(({ name }) => name)).toEqual(["first", "second"]);
		h.control.role = completeRole;
		const correction =
			"Cancel queued searches too, but preserve cached results.";
		const instructions =
			"Apply that correction and verify both cancellation cases.";
		await h.prompt(correction, async ({ run }) => {
			expect(textOf(h.saved().history)).not.toContain(correction);
			const result = await run({ action: "continue", instructions });
			expect(result.text).toContain("Status: completed");
			expect(textOf(h.saved().history)).not.toContain(correction);
			for (const { session } of h.children.slice(2)) {
				const [[request]] = session.prompt.mock.calls;
				expect(textOf(request.content)).toContain(correction);
				expect(textOf(request.content)).toContain(instructions);
			}
		});
		expect(h.children.map(({ name }) => name)).toEqual([
			"first",
			"second",
			"second",
			"last",
		]);
		const [continued, later] = h.children.slice(2);
		expect(continued.session.restore).toHaveBeenCalledExactlyOnceWith(
			waiting.continuations![0].checkpoint,
		);
		expect(continued.state.effects).toEqual([
			"Inspected the cancellation API",
			"second effect",
		]);
		expect(later.session.restore).not.toHaveBeenCalled();
		expect(
			h.saved().engine!.records.find(({ id }) => id === completed.id),
		).toEqual(completed);
		expect(h.saved().continuations).toEqual([]);
		expect(textOf(h.saved().history)).toContain(correction);
	});

	it("round-trips mixed needs_human and blocked or interrupted evidence without permitting replay", async () => {
		await Promise.all(
			["blocked", "interrupted"].map(async (sibling) => {
				const h = harness();
				const controller = new AbortController();
				const reported = gate();
				h.control.activity = async (event) => {
					if (
						event.kind === "tool" &&
						event.title === "first" &&
						event.status === "failed"
					) {
						reported.resolve();
					}
				};
				h.control.role = async (report, _request, state) => {
					state.effects.push(`${state.name} inspected the workspace`);
					if (state.name === "first") {
						report({
							status: "needs_human",
							summary: "Which search queue is in scope?",
						});
						return "completed";
					}
					await reported.promise;
					if (sibling === "interrupted") {
						controller.abort();
						return "cancelled";
					}
					report({
						status: "blocked",
						summary: "Required search index is unavailable",
					});
					return "completed";
				};
				await expect(
					h.prompt(
						"Inspect search cancellation",
						async ({ run }) => {
							await run(start("audit"));
						},
						controller.signal,
					),
				).resolves.toBe(sibling === "interrupted" ? "cancelled" : "completed");
				const saved = h.saved();
				expect(saved.engine).toMatchObject({ status: sibling });
				expect(
					saved.engine!.records.map(({ role, status }) => ({ role, status })),
				).toEqual([
					{ role: "first", status: "waiting" },
					{ role: "second", status: sibling },
					{ role: "last", status: "pending" },
				]);
				expect(saved.continuations).toEqual(
					saved
						.engine!.records.filter(
							({ status }) => status === "waiting" || status === "interrupted",
						)
						.map(({ id, role }) => ({
							recordId: id,
							checkpoint: h.children.find(({ name }) => name === role)!.state,
						})),
				);
				await h.runtime.dispose();
				const restored = harness();
				restored.runtime.restore!(JSON.stringify(saved));
				expect(restored.saved()).toEqual(saved);
				expect(restored.createAgent).not.toHaveBeenCalled();
				await restored.prompt(
					"The queue is known now; continue if safe",
					async ({ run }) => {
						const status = await run({ action: "status" });
						expect(status.text).toContain("Which search queue is in scope?");
						expect(
							await run({
								action: "continue",
								instructions: "Use the foreground queue",
							}),
						).toMatchObject({ isError: true });
					},
				);
				expect(restored.saved().engine).toEqual(saved.engine);
				expect(restored.saved().continuations).toEqual(saved.continuations);
				expect(restored.createAgent).not.toHaveBeenCalled();
			}),
		);
	});

	it("settles late cancellation as ready or completed without replaying recorded role effects", async () => {
		const graph = structuredClone(workflow);
		graph.commands.audit.chain = [
			{ kind: "agent", name: "first" },
			{ kind: "agent", name: "last" },
		];
		await Promise.all(
			["ready", "completed"].map(async (status) => {
				const h = harness({ graph });
				const controller = new AbortController();
				const cancelAfter = status === "ready" ? "first" : "last";
				const terminal: EngineState[] = [];
				h.control.activity = async (event) => {
					if (
						event.kind === "tool" &&
						event.title === cancelAfter &&
						event.status === "completed"
					) {
						terminal.push(h.saved().engine!);
						controller.abort();
					}
				};
				await expect(
					h.prompt(
						"Audit the cancellation fix",
						async ({ run }) => {
							await run(start("audit"));
						},
						controller.signal,
					),
				).resolves.toBe("cancelled");
				expect(terminal).toEqual([
					expect.objectContaining({ status: "running" }),
				]);
				expect(
					terminal[0].records.some((record) => record.status === "running"),
				).toBe(false);
				const saved = h.saved();
				expect(saved).toMatchObject({
					phase: status === "ready" ? "audit" : "routing",
					engine: { status },
					continuations: [],
				});
				expect(saved.engine!.records.map((record) => record.status)).toEqual([
					"completed",
					status === "ready" ? "pending" : "completed",
				]);
				await h.runtime.dispose();
				const restored = harness({ graph });
				restored.runtime.restore!(JSON.stringify(saved));
				expect(restored.saved().engine).toEqual(saved.engine);
				await restored.prompt(
					"Explain what remains; do not run anything",
					async ({ run }) => {
						expectProse(await run({ action: "status" }));
					},
				);
				expect(restored.createAgent).not.toHaveBeenCalled();
				await restored.prompt(
					"Continue only unstarted work",
					async ({ run }) => {
						const result = await run({
							action: "continue",
							instructions: "Run only the remaining audit step",
						});
						if (status === "ready") {
							expect(result.text).toContain("Status: completed");
						} else {
							expect(result.isError).toBe(true);
						}
					},
				);
				expect(restored.children.map(({ name }) => name)).toEqual(
					status === "ready" ? ["last"] : [],
				);
				expect(
					[...h.children, ...restored.children].map(
						({ state }) => state.effects,
					),
				).toEqual([["first effect"], ["last effect"]]);
				if (status === "ready") {
					expect(
						restored
							.saved()
							.engine!.records.find(({ role }) => role === "first"),
					).toEqual(saved.engine!.records.find(({ role }) => role === "first"));
				} else {
					expect(textOf(restored.saved().history)).toContain("last finished");
				}
			}),
		);
	});

	it("preserves successful reports when cancellation arrives during child disposal", async () => {
		const graph = structuredClone(workflow);
		graph.commands.audit.chain = [
			{ kind: "agent", name: "first" },
			{ kind: "agent", name: "last" },
		];
		await Promise.all(
			["ready", "completed"].map(async (status) => {
				const h = harness({ graph });
				const controller = new AbortController();
				const disposing = gate();
				const release = gate();
				const role = status === "ready" ? "first" : "last";
				h.control.cleanup = async (name) => {
					if (name === role) {
						disposing.resolve();
						await release.promise;
					}
				};
				const turn = h.prompt(
					"Audit the cancellation fix",
					async ({ run }) => {
						await run(start("audit"));
					},
					controller.signal,
				);
				try {
					await disposing.promise;
					const child = h.children.find(({ name }) => name === role)!;
					await expect(
						child.session.prompt.mock.results[0].value,
					).resolves.toBe("completed");
					controller.abort();
					expect(
						h.saved().engine!.records.find((record) => record.role === role),
					).toMatchObject({ status: "running" });
				} finally {
					release.resolve();
					await expect(turn).resolves.toBe("cancelled");
				}
				const saved = h.saved();
				expect(saved).toMatchObject({ engine: { status }, continuations: [] });
				expect(
					saved.engine!.records.find((record) => record.role === role),
				).toMatchObject({
					status: "completed",
					outcome: { status: "completed", summary: `${role} finished` },
				});
				await h.runtime.dispose();
				const restored = harness({ graph });
				restored.runtime.restore!(JSON.stringify(saved));
				expect(restored.saved().engine).toEqual(saved.engine);
				expect(restored.createAgent).not.toHaveBeenCalled();
				await restored.prompt(
					"Continue only unfinished work",
					async ({ run }) => {
						const result = await run({
							action: "continue",
							instructions: "Do not repeat completed inspection",
						});
						if (status === "ready") {
							expect(result.text).toContain("Status: completed");
						} else {
							expect(result.isError).toBe(true);
						}
					},
				);
				expect(restored.children.map(({ name }) => name)).toEqual(
					status === "ready" ? ["last"] : [],
				);
				expect(
					[...h.children, ...restored.children].map(
						({ state }) => state.effects,
					),
				).toEqual([["first effect"], ["last effect"]]);
			}),
		);
	});

	// oxlint-disable-next-line max-statements -- Follow one role from saved report through unsafe in-flight and fresh settled checkpoints.
	it("never resumes a busy worker from its predecessor's needs_human checkpoint", async () => {
		const graph = structuredClone(workflow);
		graph.commands.audit.chain = [
			{ kind: "agent", name: "first" },
			{ kind: "agent", name: "last" },
		];
		const original = harness({ graph });
		original.control.role = async (report, _request, state) => {
			state.effects.push("Initial queue inspection");
			report({ status: "needs_human", summary: "May I correct the queue?" });
			return "completed";
		};
		await original.prompt("Inspect the queue", async ({ run }) => {
			await run(start("audit"));
		});
		const prior = original.saved();
		expect(prior.engine).toMatchObject({
			status: "waiting",
			pause: { kind: "report" },
		});
		expect(prior.continuations).toHaveLength(1);
		await original.runtime.dispose();
		const resumed = harness({ graph });
		resumed.runtime.restore!(JSON.stringify(prior));
		const effected = gate();
		const release = gate();
		const controller = new AbortController();
		resumed.control.role = async (_report, _request, state) => {
			state.effects.push("Applied queue correction");
			effected.resolve();
			await release.promise;
			return "cancelled";
		};
		const recovery = harness({ graph });
		const turn = resumed.prompt(
			"Apply the queue correction",
			async ({ run }) => {
				await run({
					action: "continue",
					instructions: "Correct only the foreground queue",
				});
			},
			controller.signal,
		);
		try {
			await effected.promise;
			const busy = resumed.saved();
			expect(
				resumed.children[0].session.restore,
			).toHaveBeenCalledExactlyOnceWith(prior.continuations![0].checkpoint);
			expect(resumed.children[0].state.effects).toEqual([
				"Initial queue inspection",
				"Applied queue correction",
			]);
			expect(busy.engine).toMatchObject({ status: "running" });
			expect(busy.continuations).toEqual([]);
			recovery.runtime.restore!(JSON.stringify(busy));
			await recovery.prompt(
				"Continue the in-flight snapshot",
				async ({ run }) => {
					const result = await run({
						action: "continue",
						instructions: "Resume without repeating edits",
					});
					expect(result.isError).toBe(true);
				},
			);
			expect(recovery.createAgent).not.toHaveBeenCalled();
			expect(recovery.saved().engine).toMatchObject({ status: "interrupted" });
		} finally {
			controller.abort();
			release.resolve();
			await expect(turn).resolves.toBe("cancelled");
		}
		const fresh = resumed.saved();
		expect(fresh.continuations).toEqual([
			{
				recordId: prior.continuations![0].recordId,
				checkpoint: resumed.children[0].state,
			},
		]);
		expect(fresh.continuations).not.toEqual(prior.continuations);
		await resumed.runtime.dispose();
		recovery.runtime.restore!(JSON.stringify(fresh));
		recovery.control.role = async (report) => {
			report({
				status: "completed",
				summary: "Verified retained queue effects",
			});
			return "completed";
		};
		await recovery.prompt("Verify the retained correction", async ({ run }) => {
			const result = await run({
				action: "continue",
				instructions: "Verify existing edits; do not apply them again",
			});
			expect(result.text).toContain("Status: completed");
		});
		expect(recovery.children.map(({ name }) => name)).toEqual([
			"first",
			"last",
		]);
		expect(
			recovery.children[0].session.restore,
		).toHaveBeenCalledExactlyOnceWith(fresh.continuations![0].checkpoint);
		expect(recovery.children.map(({ state }) => state.effects)).toEqual([
			["Initial queue inspection", "Applied queue correction"],
			[],
		]);
		expect(recovery.saved().continuations).toEqual([]);
	});

	it.each(["duplicate", "foreign", "completed"] as const)(
		"rejects %s continuation IDs before routing restore and leaves the target unchanged",
		async (invalid) => {
			const { h, turn, release } = await partialBatch();
			release();
			await expect(turn).resolves.toBe("cancelled");
			const saved = h.saved();
			const [continuation] = saved.continuations!;
			expect(continuation).toBeDefined();
			const foreign = {
				...workflow,
				commands: { other: workflow.commands.audit },
			};
			const other = harness({ graph: foreign });
			await other.prompt("Inspect another graph", async ({ run }) => {
				await run(start("other"));
			});
			const rows =
				invalid === "duplicate"
					? [continuation, continuation]
					: [
							{
								...continuation,
								recordId:
									invalid === "completed"
										? saved.engine!.records.find(
												({ status }) => status === "completed",
											)!.id
										: other
												.saved()
												.engine!.records.find(({ role }) => role === "second")!
												.id,
							},
						];
			const target = harness();
			await target.prompt("Retain this target's own work", async ({ run }) => {
				await run(start("design"));
			});
			const before = target.runtime.snapshot!();
			expect(() =>
				target.runtime.restore!({ ...saved, continuations: rows }),
			).toThrow(/continuation/i);
			expect(target.routing.restore).not.toHaveBeenCalled();
			expect(target.runtime.snapshot!()).toEqual(before);
			expect(target.children.map(({ name }) => name)).toEqual(["first"]);
		},
	);

	// oxlint-disable-next-line max-statements -- Keep cancellation, cleanup, and explicit recovery in one journey.
	it("resumes only the interrupted sibling with retained effects after all child disposal has settled", async () => {
		const { h, turn, release } = await partialBatch();
		try {
			const pending = h.saved();
			expect(
				pending.engine?.records.find(({ role }) => role === "first"),
			).toMatchObject({
				status: "completed",
				outcome: { summary: "first finished" },
			});
			expect(pending.continuations).toEqual([]);
			expect(() =>
				h.runtime.prompt({
					content: [],
					signal: new AbortController().signal,
					emit: async () => undefined,
				}),
			).toThrow(/running/);
			const premature = harness();
			premature.runtime.restore!(JSON.stringify(pending));
			await premature.prompt(
				"Resume before cleanup is complete",
				async ({ run }) => {
					expect(
						await run({ action: "continue", instructions: "Resume" }),
					).toMatchObject({ isError: true });
				},
			);
			expect(premature.createAgent).not.toHaveBeenCalled();
		} finally {
			release();
			await turn;
		}
		expect(await turn).toBe("cancelled");
		const saved = h.saved();
		const interrupted = saved.engine!.records.find(
			({ role }) => role === "second",
		)!;
		const completed = saved.engine!.records.find(
			({ role }) => role === "first",
		)!;
		expect(interrupted.status).toBe("interrupted");
		expect(saved.continuations).toEqual([
			{
				recordId: interrupted.id,
				checkpoint: h.children.find(({ name }) => name === "second")!.state,
			},
		]);
		expect(
			h.children.every(
				({ session }) => session.dispose.mock.calls.length === 1,
			),
		).toBe(true);
		await h.runtime.dispose();
		const resumed = harness();
		resumed.runtime.restore!(JSON.stringify(saved));
		expect(resumed.createAgent).not.toHaveBeenCalled();
		await resumed.prompt("What was interrupted?", async ({ run }) => {
			const status = await run({ action: "status" });
			expect(status.text).toMatch(/completed roles are not replayed/i);
		});
		expect(resumed.createAgent).not.toHaveBeenCalled();
		resumed.control.role = async (report, request, state) => {
			if (state.name === "second") {
				expect(state.effects).toEqual([
					"Partial edit settled before cancellation",
				]);
				expect(state.messages).toHaveLength(2);
				expect(textOf(request.content)).toContain(
					"Preserve the edit; fix only cancellation",
				);
				state.effects.push("Cancellation corrected");
				report({ status: "completed", summary: "Correction verified" });
				return "completed";
			}
			return completeRole(report, request, state);
		};
		await resumed.prompt(
			"Preserve the edit; fix only cancellation",
			async ({ run }) => {
				const result = await run({
					action: "continue",
					instructions: "Preserve the edit; fix only cancellation",
				});
				expect(result.text).toContain("Status: completed");
			},
		);
		expect(resumed.children.map(({ name }) => name)).toEqual([
			"second",
			"last",
		]);
		expect(resumed.children[0].session.restore).toHaveBeenCalledExactlyOnceWith(
			saved.continuations![0].checkpoint,
		);
		expect(resumed.children[1].session.restore).not.toHaveBeenCalled();
		expect(
			resumed.saved().engine!.records.find(({ id }) => id === completed.id),
		).toEqual(completed);
		expect(resumed.saved().continuations).toEqual([]);
	});

	it.each(["snapshot", "cleanup"] as const)(
		"refuses resume after a cancelled role's %s fails, including after reload",
		async (failure) => {
			const { h, turn, release } = await partialBatch(failure);
			release();
			await expect(turn).resolves.toBe("cancelled");
			expect(h.saved().continuations).toEqual([]);
			const resumed = harness();
			resumed.runtime.restore!(JSON.stringify(h.runtime.snapshot!()));
			const before = resumed.saved().engine;
			await resumed.prompt("Continue safely", async ({ run }) => {
				const status = await run({ action: "status" });
				expect(status.text).toMatch(/workflow lacks a resumable checkpoint/i);
				const result = await run({
					action: "continue",
					instructions: "Resume",
				});
				expect(result.isError).toBe(true);
				expect(result.text).toMatch(/rather than rerunning completed steps/i);
			});
			expect(resumed.createAgent).not.toHaveBeenCalled();
			expect(resumed.saved().engine).toEqual(before);
		},
	);

	it("discards a failed role restore without prompting it or automatically replaying stale work", async () => {
		const { h, turn, release } = await partialBatch();
		release();
		await turn;
		const resumed = harness();
		resumed.control.restoreFailure = "second";
		resumed.runtime.restore!(JSON.stringify(h.runtime.snapshot!()));
		await resumed.prompt("Resume with my correction", async ({ run }) => {
			const result = await run({
				action: "continue",
				instructions: "Keep the settled edit",
			});
			expect(result.text).toContain("Status: blocked");
		});
		expect(resumed.children.map(({ name }) => name)).toEqual(["second"]);
		const [child] = resumed.children;
		expect(child.session.restore).toHaveBeenCalledTimes(1);
		expect(child.session.prompt).not.toHaveBeenCalled();
		expect(child.session.dispose).toHaveBeenCalledTimes(1);
		expect(resumed.saved().continuations).toEqual([]);
		const reloaded = harness();
		reloaded.runtime.restore!(JSON.stringify(resumed.runtime.snapshot!()));
		await reloaded.prompt("Try continuing again", async ({ run }) => {
			expect(
				await run({ action: "continue", instructions: "Try again" }),
			).toMatchObject({ isError: true });
		});
		expect(reloaded.createAgent).not.toHaveBeenCalled();
		expect(
			reloaded.saved().engine?.records.find(({ role }) => role === "first"),
		).toMatchObject({
			status: "completed",
			outcome: { summary: "first finished" },
		});
	});

	it("bounds status evidence as readable text while preserving complete persisted reports", async () => {
		const graph = Workflow.parse({
			commands: {
				evidence: {
					description: "Gather evidence",
					chain: [
						{
							kind: "parallel",
							agents: Array.from({ length: 20 }, () => "first"),
						},
						{ kind: "human", prompt: "Choose the next step" },
					],
				},
			},
			vault: { dirs: [], template_kinds: [] },
		});
		const h = harness({ graph });
		const reports: string[] = [];
		h.control.role = async (report) => {
			const summary = `Evidence item ${reports.length + 1}: ${"detail ".repeat(1000)}`;
			reports.push(summary.trim());
			report({ status: "completed", summary });
			return "completed";
		};
		await h.prompt("Inspect and summarize", async ({ run }) => {
			expectProse(await run({ action: "status" }));
			const result = await run(start("evidence"));
			expectProse(result);
			expect(result.text).toContain("Choose the next step");
			expect(result.text).not.toContain("Evidence item 4:");
			expect(result.text).toContain("Evidence item 5:");
			expect(result.text).toContain("truncated");
			// Allow bounded topic/path metadata alongside the unchanged 64 KiB evidence cap.
			expect(result.text.length).toBeLessThan(70_000);
			expect(result.text.match(/^### /gm)!.length).toBeLessThanOrEqual(16);
			expect(await run({ action: "status" })).toEqual(result);
		});
		const before = h.saved().engine;
		await h.prompt("Show current status", async ({ run, request }) => {
			expect(textOf(request.content).length).toBeLessThan(70_000);
			const result = await run({ action: "status" });
			expectProse(result);
			expect(result.text).toContain("Status: waiting");
		});
		expect(h.saved().engine).toEqual(before);
		expect(
			h
				.saved()
				.engine!.records.flatMap(({ outcome }) =>
					outcome ? [outcome.summary] : [],
				),
		).toEqual(reports);
		expect(h.children).toHaveLength(20);
	});
});

describe("independent role orchestration", () => {
	it("restores a paused role but rejects substituted roles and extra steps before routing restore", async () => {
		const { createEngine } = await import("@d3r/core/engine");
		const h = harness();
		h.control.role = async (report, _request, state) => {
			state.effects.push("Inspected cancellation");
			report({ status: "needs_human", summary: "Which search should stop?" });
			return "completed";
		};
		await h.prompt("Inspect cancellation independently", async ({ run }) => {
			await run({ action: "role", role: "first", brief });
		});
		const saved = h.saved();
		expect(saved).toMatchObject({
			phase: "routing",
			standaloneRole: "first",
			engine: { command: "standalone", status: "waiting" },
		});
		const expanded = structuredClone(saved.engine!.workflow);
		expanded.commands.standalone.chain.push({ kind: "agent", name: "last" });
		const target = harness();
		await target.prompt("Keep this design active", async ({ run }) => {
			await run(start("design"));
		});
		const before = target.runtime.snapshot!();
		for (const invalid of [
			{ ...saved, standaloneRole: "second" },
			{
				...saved,
				engine: createEngine(expanded, "standalone"),
				continuations: [],
			},
		]) {
			expect(() => target.runtime.restore!(invalid)).toThrow(
				/engine and session workflow pins differ/i,
			);
			expect(target.routing.restore).not.toHaveBeenCalled();
			expect(target.runtime.snapshot!()).toEqual(before);
		}
		expect(target.children.map(({ name }) => name)).toEqual(["first"]);

		const restored = harness();
		restored.runtime.restore!(JSON.stringify(saved));
		expect(restored.routing.restore).toHaveBeenCalledOnce();
		expect(restored.saved().engine).toEqual(saved.engine);
		expect(restored.createAgent).not.toHaveBeenCalled();
		await restored.prompt("Stop the cancelled search only", async ({ run }) => {
			const result = await run({
				action: "continue",
				instructions: "Stop the cancelled search only",
			});
			expect(result.text).toContain("Role: first");
			expect(result.text).toContain("Status: completed");
		});
		expect(restored.children.map(({ name }) => name)).toEqual(["first"]);
		expect(restored.children[0].session.restore).toHaveBeenCalledOnce();
		expect(restored.children[0].state.effects).toEqual([
			"Inspected cancellation",
			"first effect",
		]);
		expect(restored.children[0].state.messages.at(-1)).toContain(
			"Stop the cancelled search only",
		);
	});

	it("refuses a standalone review of an active phase and keeps its unapproved discussion out of resumed workers", async () => {
		const h = harness();
		const approved = "Only fix cancellation; keep search ranking unchanged.";
		await h.prompt(approved);
		await h.prompt("Design the cancellation fix", async ({ run }) => {
			await run(start("design"));
		});
		const before = h.saved();
		const proposal = "Run second independently to review sponsored ranking.";
		const unapproved = "Unapproved review suggestion: prioritize paid results.";
		await h.prompt(proposal, async ({ run, request }) => {
			const result = await run({
				action: "role",
				role: "second",
				brief: { ...brief, goal: proposal },
			});
			expect(result.isError).toBe(true);
			expect(result.text).toContain("Phase: design");
			expect(result.text).toContain("Approve the scope");
			await request.emit({
				kind: "text",
				messageId: "unapproved-review",
				text: unapproved,
			});
		});
		expect(h.saved().engine).toEqual(before.engine);
		expect(h.saved().input).toEqual(before.input);
		expect(h.children.map(({ name }) => name)).toEqual(["first"]);
		expect(h.children[0].state.effects).toEqual(["first effect"]);

		const restored = harness();
		restored.runtime.restore!(JSON.stringify(h.runtime.snapshot!()));
		expect(restored.routing.snapshot().messages.join("\n")).toContain(proposal);
		expect(textOf(restored.saved().history)).toContain(unapproved);
		await restored.prompt(
			"Approve the original scope only",
			async ({ run }) => {
				const result = await run({
					action: "continue",
					instructions: "Proceed with the cancellation-only design",
				});
				expect(result.text).toContain("Approve the plan");
			},
		);
		expect(restored.children.map(({ name }) => name)).toEqual(["second"]);
		const [worker] = restored.children;
		expect(worker.state.messages[0]).toContain(approved);
		expect(worker.state.messages[0]).toContain(
			"Proceed with the cancellation-only design",
		);
		expect(worker.state.messages[0]).not.toContain(proposal);
		expect(worker.state.messages[0]).not.toContain(unapproved);
	});

	it("shares busy and unfinished-work guards with phases while a standalone role runs and waits", async () => {
		const h = harness();
		const entered = gate();
		const release = gate();
		h.control.role = async (report, _request, state) => {
			state.effects.push("Inspected once");
			entered.resolve();
			await release.promise;
			report({ status: "needs_human", summary: "Confirm the search scope" });
			return "completed";
		};
		await h.prompt("Inspect independently", async ({ run }) => {
			const running = run({ action: "role", role: "first", brief });
			await entered.promise;
			try {
				const before = h.runtime.snapshot!();
				expect(await run(start("audit"))).toMatchObject({ isError: true });
				expect(
					await run({ action: "role", role: "second", brief }),
				).toMatchObject({ isError: true });
				expect(
					await run({ action: "abandon", reason: "Replace the running role" }),
				).toMatchObject({ isError: true });
				expect(h.runtime.snapshot!()).toEqual(before);
			} finally {
				release.resolve();
				await running;
			}
		});
		const waiting = h.saved();
		expect(waiting.engine).toMatchObject({
			command: "standalone",
			status: "waiting",
			pause: { kind: "report" },
		});
		await h.prompt("Start other work without abandoning", async ({ run }) => {
			const phase = await run(start("audit"));
			const role = await run({ action: "role", role: "second", brief });
			expect(phase.isError).toBe(true);
			expect(role.isError).toBe(true);
			expect(phase.text).toContain("Confirm the search scope");
			expect(role.text).toContain("Confirm the search scope");
		});
		expect(h.saved().engine).toEqual(waiting.engine);
		expect(h.saved().input).toEqual(waiting.input);
		expect(h.saved().continuations).toEqual(waiting.continuations);
		expect(h.children.map(({ name }) => name)).toEqual(["first"]);
		expect(h.children[0].state.effects).toEqual(["Inspected once"]);
	});

	it("cannot chain a completed role into a phase or answer a role checkpoint in the same user turn", async () => {
		const h = harness();
		await h.prompt("Run only first", async ({ run }) => {
			await run({ action: "role", role: "first", brief });
			expect(h.saved().engine?.status).toBe("completed");
			const before = h.runtime.snapshot!();
			const phase = await run(start("audit"));
			const continued = await run({
				action: "continue",
				instructions: "The router wants more work",
			});
			expect(phase.isError).toBe(true);
			expect(continued.isError).toBe(true);
			expect(phase.text).toMatch(/already ran in this turn/i);
			expect(continued.text).toMatch(/already ran in this turn/i);
			expect(h.runtime.snapshot!()).toEqual(before);
		});
		h.control.role = async (report) => {
			report({
				status: "needs_human",
				summary: "May I inspect archived data?",
			});
			return "completed";
		};
		await h.prompt("Run only second", async ({ run }) => {
			await run({ action: "role", role: "second", brief });
			const before = h.runtime.snapshot!();
			const result = await run({
				action: "continue",
				instructions: "The router approves archived data",
			});
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/already ran in this turn/i);
			expect(h.runtime.snapshot!()).toEqual(before);
			const status = await run({ action: "status" });
			expect(status.text).toContain("May I inspect archived data?");
		});
		expect(h.children.map(({ name }) => name)).toEqual(["first", "second"]);
		expect(h.children[1].session.prompt).toHaveBeenCalledOnce();
		expect(h.saved().engine?.status).toBe("waiting");
	});

	it("completes only the selected role without claiming phase completion or changing the phase picker", async () => {
		const h = harness();
		const commands = h.runtime.getCommands!();
		const config = h.runtime.getConfig!();
		await h.prompt("Run last without any prior phase", async ({ run }) => {
			const result = await run({ action: "role", role: "last", brief });
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("Role: last");
			expect(result.text).toContain("Status: completed");
			expect(result.text).toContain("not completion or approval of a phase");
			expect(result.text).not.toContain("Phase:");
		});
		expect(h.children.map(({ name }) => name)).toEqual(["last"]);
		expect(h.saved()).toMatchObject({
			phase: "routing",
			standaloneRole: "last",
			engine: { command: "standalone", status: "completed" },
		});
		expect(h.runtime.getCommands!()).toEqual(commands);
		expect(h.runtime.getConfig!()).toEqual(config);
		expect(h.children[0].state.messages[0]).toContain(brief.goal);
		expect(h.children[0].state.messages[0]).toContain(
			"this task does not approve or complete a phase",
		);
		await h.prompt("Now start design explicitly", async ({ run }) => {
			const result = await run(start("design"));
			expect(result.text).toContain("Phase: design");
			expect(result.text).toContain("Approve the scope");
		});
		expect(h.saved()).not.toHaveProperty("standaloneRole");
		expect(h.saved().engine).toMatchObject({
			command: "design",
			status: "waiting",
			pause: { kind: "human" },
		});
		expect(h.children.map(({ name }) => name)).toEqual(["last", "first"]);
	});

	it("restores a phase selected after standalone completion without replaying the role or starting the phase", async () => {
		const h = harness();
		await h.prompt("Run only first", async ({ run }) => {
			await run({ action: "role", role: "first", brief });
		});
		const completed = h.saved().engine;
		expect(completed).toMatchObject({
			command: "standalone",
			status: "completed",
		});
		const config = await h.runtime.setConfig!("phase", "design");
		expect(config).toContainEqual(
			expect.objectContaining({ id: "phase", value: "design" }),
		);
		expect(h.saved()).toMatchObject({
			phase: "design",
			standaloneRole: "first",
			engine: completed,
		});
		const saved = h.runtime.snapshot!();
		await h.runtime.dispose();

		const restored = harness();
		restored.runtime.restore!(JSON.stringify(saved));
		expect(restored.routing.restore).toHaveBeenCalledOnce();
		expect(restored.routing.prompt).not.toHaveBeenCalled();
		expect(restored.runtime.getConfig!()).toEqual(config);
		expect(restored.saved()).toMatchObject({
			phase: "design",
			standaloneRole: "first",
			engine: completed,
		});
		expect(restored.createAgent).not.toHaveBeenCalled();
		await restored.prompt("What is selected?", async ({ run }) => {
			const status = await run({ action: "status" });
			expect(status.text).toContain("No active workflow");
			expect(status.text).toContain("Preferred phase: design");
		});
		expect(restored.runtime.getConfig!()).toEqual(config);
		expect(restored.saved()).toMatchObject({ phase: "design", engine: null });
		expect(restored.saved()).not.toHaveProperty("standaloneRole");
		expect(restored.createAgent).not.toHaveBeenCalled();
		expect(h.children.map(({ name }) => name)).toEqual(["first"]);
		expect(h.children[0].session.prompt).toHaveBeenCalledOnce();
		expect(h.children[0].state.effects).toEqual(["first effect"]);
	});
});
