/* oxlint-disable no-magic-numbers -- Call counts and indices express lifecycle assertions. */
import { readFileSync } from "node:fs";
import { AgentSpec, Workflow } from "@d3r/core";
import { compileWorkflow, type EngineState } from "@d3r/core/engine";
import {
	type RuntimeActivity,
	type RuntimeChunk,
	type RuntimeContent,
	type RuntimePrompt,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
	createWorkflowRuntime,
	type WorkflowReport,
	type WorkflowRuntimeOptions,
} from "./workflow-runtime.ts";
import {
	fallbackWorkflowSummary,
	type WorkflowSummaryInput,
} from "./workflow-summary.ts";

/** Production chains exercise human checkpoints, mode selection, loops, and archive roles. */
const workflow = Workflow.parse(
	parse(
		readFileSync(new URL("../../core/workflow.yaml", import.meta.url), "utf8"),
	),
);
/** Inert native role definitions keep all execution offline. */
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
/** The root emits only this synthesis, not a second collection of role reports. */
const markdown =
	"## Completed\n\nSplit the design into bounded tasks to isolate risky changes.\n\n**Next:** Run `/develop`.";
/** Independent expectations preserve report content and declaration order across handoffs. */
const delegateReports = [
	{
		role: "planner",
		status: "completed",
		outcome: { status: "completed", summary: "planner internal report" },
	},
	{
		role: "schemer",
		status: "completed",
		outcome: { status: "completed", summary: "schemer internal report" },
	},
];
/** Deterministic gates expose in-flight state without timing assumptions. */
const gate = () => {
	let resolve: (() => void) | undefined = undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve: resolve! };
};
/** Public handoffs contain typed content, not opaque model checkpoints. */
const text = (content: readonly RuntimeContent[]): string =>
	content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
/** Decode actual public handoff content without deriving expected reports from engine state. */
const handoffReports = (content: readonly RuntimeContent[]): unknown => {
	const label = "Workflow outcomes (declaration order):\n";
	const reports = content.filter(
		(item) => item.type === "text" && item.text.startsWith(label),
	);
	expect(reports).toHaveLength(1);
	return JSON.parse(text(reports).slice(label.length));
};
/** Only the added cache field is optional; absence preserves the old checkpoint shape. */
interface Saved {
	engine: EngineState | null;
	phase: string;
	history: RuntimeContent[];
	input: RuntimeContent[];
	summary?: string;
}
/** Fake effects and child output remain observable independently of root summary delivery. */
const harness = (
	summarize?: WorkflowRuntimeOptions["summarize"],
	behavior: (
		name: string,
		report: WorkflowReport,
		request: RuntimePrompt,
	) => Promise<RuntimeStopReason> = async (name, report) => {
		report({
			status: "completed",
			summary: `${name} internal report`,
			...(name === "reviewer" ? { review: "approved" } : {}),
		});
		return "completed";
	},
) => {
	const chunks: RuntimeChunk[] = [];
	const activities: RuntimeActivity[] = [];
	const effects = vi.fn();
	const cleanup = vi.fn(async () => undefined);
	const routing = {
		prompt: vi.fn(
			async (_request: RuntimePrompt): Promise<RuntimeStopReason> =>
				"completed",
		),
		snapshot: () => ({ opaque: "private-routing-checkpoint" }),
		restore: vi.fn(),
		dispose: vi.fn(async () => undefined),
	};
	const createAgent = vi.fn(async (name: string, report: WorkflowReport) => ({
		prompt: async (request: RuntimePrompt) => {
			effects(name, request.content);
			await request.activity?.({
				kind: "tool",
				toolCallId: `effect:${effects.mock.calls.length}`,
				title: "edit_file",
				toolKind: "edit",
				status: "completed",
			});
			await request.emit({
				kind: "text",
				messageId: "role",
				text: `${name} role card`,
			});
			return behavior(name, report, request);
		},
		dispose: cleanup,
	}));
	const runtime = createWorkflowRuntime({
		workflow,
		agents,
		routing,
		createAgent,
		summarize,
	});
	const request = (
		value: string,
		signal = new AbortController().signal,
	): RuntimePrompt => ({
		content: [{ type: "text", text: value }],
		signal,
		emit: async (chunk) => {
			chunks.push(chunk);
		},
		activity: async (event) => {
			activities.push(event);
		},
	});
	const prompt = (value: string) => runtime.prompt(request(value));
	const saved = () => runtime.snapshot!() as Saved;
	const rootText = () =>
		chunks
			.filter((chunk) => !chunk.parentToolCallId)
			.map((chunk) => chunk.text);
	return {
		runtime,
		routing,
		createAgent,
		effects,
		cleanup,
		chunks,
		activities,
		request,
		prompt,
		saved,
		rootText,
	};
};

describe("workflow completion synthesis", () => {
	it("waits for one buffered summary after all roles and effects, without using routing or adding a role", async () => {
		const started = gate();
		const release = gate();
		const summarize = vi.fn(
			async (_input: WorkflowSummaryInput, _signal: AbortSignal) => {
				started.resolve();
				await release.promise;
				return ` \n${markdown}\n `;
			},
		);
		const h = harness(summarize);
		const turn = h.prompt("/delegate topic");
		await started.promise;
		const before = h.saved();
		expect(before).toMatchObject({
			phase: "routing",
			engine: { status: "completed" },
		});
		expect(before).not.toHaveProperty("summary");
		expect(h.runtime.getConfig!().find(({ id }) => id === "phase")?.value).toBe(
			"routing",
		);
		expect(h.rootText()).toEqual([]);
		expect(h.cleanup).toHaveBeenCalledTimes(2);
		expect(h.createAgent.mock.calls.map(([name]) => name)).toEqual([
			"planner",
			"schemer",
		]);
		expect(h.effects).toHaveBeenCalledTimes(2);
		expect(h.chunks.map(({ text: chunk }) => chunk)).toEqual([
			"planner role card",
			"schemer role card",
		]);
		expect(h.chunks.every(({ parentToolCallId }) => parentToolCallId)).toBe(
			true,
		);
		expect(summarize).toHaveBeenCalledTimes(1);
		expect(h.routing.prompt).not.toHaveBeenCalled();
		const activityCount = h.activities.length;
		release.resolve();
		expect(await turn).toBe("completed");
		expect(h.rootText()).toEqual([markdown]);
		expect(h.saved()).toEqual({ ...before, summary: markdown });
		expect(h.activities).toHaveLength(activityCount);
		expect(
			h.activities.findLast(
				(event) => event.kind === "tool" && event.title === "schemer",
			),
		).toMatchObject({
			status: "completed",
			rawOutput: { status: "completed", summary: "schemer internal report" },
		});
		expect(handoffReports(h.effects.mock.calls[1][1])).toMatchObject([
			delegateReports[0],
		]);
	});
	it("passes detached completed evidence including discussion, attachments, and human answers", async () => {
		const summarize = vi.fn(
			async (_input: WorkflowSummaryInput, _signal: AbortSignal) => markdown,
		);
		const h = harness(summarize);
		await h.prompt("Keep the interface stable");
		const request = h.request("/design a queue");
		const attachments: RuntimeContent[] = [
			{ type: "resource_link", name: "design", uri: "file:///design.md" },
			{ type: "image", mimeType: "image/png", data: "diagram-data" },
		];
		await h.runtime.prompt({
			...request,
			content: [...request.content, ...attachments],
		});
		expect(summarize).not.toHaveBeenCalled();
		await h.prompt("Use a bounded queue");
		const before = h.saved();
		const [[evidence, signal]] = summarize.mock.calls;
		expect(Object.keys(evidence).toSorted()).toEqual([
			"command",
			"description",
			"history",
			"input",
			"records",
		]);
		expect(evidence).toEqual({
			command: "design",
			description: workflow.commands.design.description,
			input: before.input,
			history: before.history,
			records: before.engine!.records,
		});
		expect(evidence.input).toEqual([
			...request.content,
			...attachments,
			{ type: "text", text: "Use a bounded queue" },
		]);
		expect(text(evidence.history)).toContain("Keep the interface stable");
		expect(JSON.stringify(evidence)).not.toContain(
			"private-routing-checkpoint",
		);
		expect(evidence.records.map(({ role, answer }) => role ?? answer)).toEqual([
			"aggregator",
			"researcher",
			"Use a bounded queue",
			"designer",
		]);
		expect(evidence.records.every(({ status }) => status === "completed")).toBe(
			true,
		);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
		Object.assign(evidence.input[0], { text: "changed input" });
		Object.assign(evidence.history[0], { text: "changed history" });
		evidence.records[0].outcome!.summary = "changed report";
		evidence.records[2].answer = "changed answer";
		evidence.records[0].loops.push({ id: "changed", iteration: 1, max: 1 });
		expect(h.saved()).toEqual(before);
		await h.prompt("What next?");
		expect(
			handoffReports(h.routing.prompt.mock.calls[1][0].content),
		).toMatchObject([
			{
				role: "aggregator",
				status: "completed",
				outcome: { status: "completed", summary: "aggregator internal report" },
			},
			{
				role: "researcher",
				status: "completed",
				outcome: { status: "completed", summary: "researcher internal report" },
			},
			{ status: "completed", answer: "Use a bounded queue" },
			{
				role: "designer",
				status: "completed",
				outcome: { status: "completed", summary: "designer internal report" },
			},
		]);
		expect(h.createAgent).toHaveBeenCalledTimes(3);
		expect(summarize).toHaveBeenCalledTimes(1);
	});
	it("never summarizes mode or semi checkpoints and retains skipped loop records on completion", async () => {
		const summarize = vi.fn(
			async (_input: WorkflowSummaryInput, _signal: AbortSignal) => markdown,
		);
		const h = harness(summarize);
		await h.prompt("/develop implement");
		expect(h.saved().engine?.pause?.kind).toBe("mode");
		expect(summarize).not.toHaveBeenCalled();
		await h.prompt("semi");
		expect(h.saved().engine?.pause?.kind).toBe("semi");
		expect(summarize).not.toHaveBeenCalled();
		await h.prompt("Check the concurrency");
		expect(h.saved().engine?.pause?.kind).toBe("semi");
		expect(summarize).not.toHaveBeenCalled();
		await h.prompt("Audit it");
		expect(h.saved().engine?.status).toBe("completed");
		expect(summarize).toHaveBeenCalledTimes(1);
		const [[evidence]] = summarize.mock.calls;
		expect(evidence.records).toEqual(h.saved().engine!.records);
		expect(evidence.records.some(({ status }) => status === "skipped")).toBe(
			true,
		);
		expect(text(evidence.input)).toContain("Check the concurrency");
		expect(text(evidence.input)).toContain("Audit it");
	});
	it.each(["blocked", "needs_human", "cancelled"] as const)(
		"does not synthesize a %s workflow",
		async (status) => {
			const summarize = vi.fn(async () => markdown);
			const h = harness(summarize, async (_name, report) => {
				if (status === "cancelled") {
					return "cancelled";
				}
				report({ status, summary: "Need a decision" });
				return "completed";
			});
			await h.prompt("/delegate topic");
			expect(summarize).not.toHaveBeenCalled();
			expect(h.saved()).not.toHaveProperty("summary");
			expect(h.saved().engine?.status).not.toBe("completed");
			await h.prompt("continue");
			expect(summarize).not.toHaveBeenCalled();
			expect(h.effects).toHaveBeenCalledTimes(1);
		},
	);
});

describe("workflow summary failure and cancellation", () => {
	it.each([
		"missing",
		"throws",
		"empty",
		"oversized",
		"json",
		"fenced",
		"wrong type",
	])(
		"uses exactly one deterministic fallback when the hook is %s",
		async (failure) => {
			const values: Record<string, unknown> = {
				empty: " \n ",
				oversized: "x".repeat(8193),
				json: '{"summary":"raw role report"}',
				fenced: 'Done\n```json\n{"summary":"raw role report"}\n```',
				"wrong type": {},
			};
			const summarize = vi.fn(async () => {
				if (failure === "throws") {
					throw new Error("private-provider-diagnostic");
				}
				return values[failure] as string;
			});
			const h = harness(failure === "missing" ? undefined : summarize);
			expect(await h.prompt("/delegate topic")).toBe("completed");
			const fallback = fallbackWorkflowSummary(
				"delegate",
				Object.keys(workflow.commands),
			);
			expect(h.rootText()).toEqual([fallback]);
			expect(h.saved()).toMatchObject({
				summary: fallback,
				phase: "routing",
				engine: { status: "completed" },
			});
			expect(h.rootText().join("\n")).not.toMatch(
				/internal report|raw role report|private-provider-diagnostic|Workflow outcomes/,
			);
			expect(summarize).toHaveBeenCalledTimes(failure === "missing" ? 0 : 1);
			expect(h.routing.prompt).not.toHaveBeenCalled();
			await h.prompt("What next?");
			expect(text(h.routing.prompt.mock.calls[0][0].content)).toContain(
				fallback,
			);
			expect(h.effects).toHaveBeenCalledTimes(2);
			expect(summarize).toHaveBeenCalledTimes(failure === "missing" ? 0 : 1);
		},
	);
	it.each(["resolve", "reject", "invalid"])(
		"cancels a delayed summary that later %ss without success, fallback, or replay",
		async (result) => {
			const started = gate();
			const release = gate();
			const summarize = vi.fn(
				async (_input: WorkflowSummaryInput, _signal: AbortSignal) => {
					started.resolve();
					await release.promise;
					if (result === "reject") {
						throw new Error("aborted provider");
					}
					return result === "invalid" ? "{}" : markdown;
				},
			);
			const h = harness(summarize);
			const controller = new AbortController();
			const turn = h.runtime.prompt(
				h.request("/delegate topic", controller.signal),
			);
			await started.promise;
			const before = h.saved();
			controller.abort();
			expect(summarize.mock.calls[0][1].aborted).toBe(true);
			release.resolve();
			expect(await turn).toBe("cancelled");
			expect(h.saved()).toEqual(before);
			expect(h.saved()).toMatchObject({
				phase: "routing",
				engine: { status: "completed" },
			});
			expect(h.rootText()).toEqual([]);
			await h.prompt("restart");
			await h.prompt("A new question");
			expect(h.effects).toHaveBeenCalledTimes(2);
			expect(summarize).toHaveBeenCalledTimes(1);
			expect(h.rootText()).toEqual([]);
			expect(h.routing.prompt).toHaveBeenCalledTimes(2);
			expect(text(h.routing.prompt.mock.calls[0][0].content)).toContain(
				"schemer internal report",
			);
		},
	);
	it("disposal aborts and joins summary cleanup without changing completed work", async () => {
		const started = gate();
		const release = gate();
		const summarize = vi.fn(
			async (_input: WorkflowSummaryInput, signal: AbortSignal) => {
				started.resolve();
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				await release.promise;
				signal.throwIfAborted();
				return markdown;
			},
		);
		const h = harness(summarize);
		const turn = h.prompt("/delegate topic");
		await started.promise;
		const disposing = h.runtime.dispose();
		expect(summarize.mock.calls[0][1].aborted).toBe(true);
		expect(h.routing.dispose).not.toHaveBeenCalled();
		release.resolve();
		expect(await turn).toBe("cancelled");
		await disposing;
		expect(h.rootText()).toEqual([]);
		expect(h.routing.dispose).toHaveBeenCalledTimes(1);
	});
	it.each([true, false])(
		"propagates delivery failure without a second fallback (valid hook: %s)",
		async (valid) => {
			const summarize = vi.fn(async () => (valid ? markdown : "{}"));
			const h = harness(summarize);
			const request = h.request("/delegate topic");
			const failure = new Error("delivery failed after accepting message");
			const deliver = vi.fn(async (chunk: RuntimeChunk) => {
				await request.emit(chunk);
				if (!chunk.parentToolCallId) {
					throw failure;
				}
			});
			await expect(
				h.runtime.prompt({ ...request, emit: deliver }),
			).rejects.toBe(failure);
			expect(h.rootText()).toHaveLength(1);
			expect(h.saved()).toMatchObject({
				phase: "routing",
				engine: { status: "completed" },
				summary: h.rootText()[0],
			});
			await h.prompt("What next?");
			expect(h.rootText()).toHaveLength(1);
			expect(summarize).toHaveBeenCalledTimes(1);
			expect(h.effects).toHaveBeenCalledTimes(2);
		},
	);
});

describe("workflow summary checkpoint and history", () => {
	it.each([true, false])(
		"restores a completed checkpoint without generation or re-emission (cached: %s)",
		async (cached) => {
			const original = harness(async () => markdown);
			await original.prompt("/delegate original");
			const checkpoint = original.saved();
			if (!cached) {
				delete checkpoint.summary;
			}
			const summarize = vi.fn(async () => "Should not run");
			const h = harness(summarize);
			h.runtime.restore!(JSON.stringify(checkpoint));
			expect(h.saved()).toEqual(checkpoint);
			expect(h.rootText()).toEqual([]);
			expect(summarize).not.toHaveBeenCalled();
			expect(h.createAgent).not.toHaveBeenCalled();
			expect(h.routing.prompt).not.toHaveBeenCalled();
			await h.prompt("What next?");
			const handoff = text(h.routing.prompt.mock.calls[0][0].content);
			expect(
				handoffReports(h.routing.prompt.mock.calls[0][0].content),
			).toMatchObject(delegateReports);
			expect(handoff).toContain("/delegate original");
			expect(
				handoff.includes(`Workflow summary (/delegate):\n${markdown}`),
			).toBe(cached);
			expect(h.saved()).not.toHaveProperty("summary");
			expect(h.saved().engine).toBeNull();
			expect(h.rootText()).toEqual([]);
			expect(summarize).not.toHaveBeenCalled();
			expect(h.effects).not.toHaveBeenCalled();
			const next = harness(summarize);
			next.runtime.restore!(JSON.stringify(h.saved()));
			await next.prompt("Thanks");
			expect(text(next.routing.prompt.mock.calls[0][0].content)).toBe("Thanks");
		},
	);
	it("restores an in-flight summary checkpoint as completed without resuming the callback", async () => {
		const started = gate();
		const release = gate();
		const original = harness(async () => {
			started.resolve();
			await release.promise;
			return markdown;
		});
		const turn = original.prompt("/delegate original");
		await started.promise;
		const summarize = vi.fn(async () => markdown);
		const h = harness(summarize);
		h.runtime.restore!(JSON.stringify(original.saved()));
		expect(h.saved()).not.toHaveProperty("summary");
		await h.prompt("restart");
		expect(summarize).not.toHaveBeenCalled();
		expect(h.effects).not.toHaveBeenCalled();
		expect(h.rootText()).toEqual([]);
		release.resolve();
		await turn;
	});
	it("archives the summary beside unchanged outcomes and provides fresh evidence and cache per workflow", async () => {
		const second =
			"## Completed\n\nArchived the task for future reference.\n\n**Next:** Choose a new task in routing.";
		const summarize = vi
			.fn(
				async (_input: WorkflowSummaryInput, _signal: AbortSignal) => markdown,
			)
			.mockResolvedValueOnce(markdown)
			.mockResolvedValueOnce(second);
		const h = harness(summarize);
		await h.prompt("/delegate first");
		await h.prompt("/summarize second");
		expect(h.saved().summary).toBe(second);
		expect(h.saved().history).toEqual([
			{ type: "text", text: "/delegate first" },
			{
				type: "text",
				text: expect.stringContaining(
					"Workflow outcomes (declaration order):\n",
				),
			},
			{ type: "text", text: `Workflow summary (/delegate):\n${markdown}` },
		]);
		expect(handoffReports(h.saved().history)).toMatchObject(delegateReports);
		expect(text(h.effects.mock.calls[2][1])).toContain(markdown);
		expect(summarize).toHaveBeenCalledTimes(2);
		const [, [evidence, signal]] = summarize.mock.calls;
		expect(evidence.command).toBe("summarize");
		expect(evidence.history).toEqual(h.saved().history);
		expect(evidence.input).toEqual([
			{ type: "text", text: "/summarize second" },
		]);
		expect(evidence.records.map(({ role }) => role)).toEqual([
			"summarizer",
			"archivist",
		]);
		expect(evidence).not.toBe(summarize.mock.calls[0][0]);
		expect(signal).not.toBe(summarize.mock.calls[0][1]);
		expect(h.rootText()).toEqual([markdown, second]);
	});
	it.each([null, "", "{}", "x".repeat(8193)])(
		"rejects an invalid cached summary before restoring routing (case %#)",
		async (summary) => {
			const original = harness(async () => markdown);
			await original.prompt("/delegate topic");
			const h = harness();
			expect(() =>
				h.runtime.restore!({ ...original.saved(), summary }),
			).toThrow();
			expect(h.routing.restore).not.toHaveBeenCalled();
		},
	);
	it.each(["absent", "human", "mode", "semi", "blocked", "interrupted"])(
		"rejects a summary attached to an %s engine",
		async (state) => {
			const original = harness(undefined, async (name, report) => {
				if (state === "interrupted") {
					return "cancelled";
				}
				report({
					status: state === "blocked" ? "blocked" : "completed",
					summary: name,
				});
				return "completed";
			});
			if (state === "human") {
				await original.prompt("/design topic");
			}
			if (["mode", "semi"].includes(state)) {
				await original.prompt("/develop topic");
			}
			if (state === "semi") {
				await original.prompt("semi");
			}
			if (["blocked", "interrupted"].includes(state)) {
				await original.prompt("/delegate topic");
			}
			const h = harness();
			expect(() =>
				h.runtime.restore!({ ...original.saved(), summary: markdown }),
			).toThrow(/summary requires a completed engine/);
			expect(h.routing.restore).not.toHaveBeenCalled();
		},
	);
});
