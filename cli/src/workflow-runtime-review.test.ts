/* oxlint-disable no-magic-numbers -- Counts and indices describe boundary fixtures. */
import { AgentSpec, Workflow } from "@d3r/core";
import { type EngineState } from "@d3r/core/engine";
import {
	type RuntimeActivity,
	type RuntimeContent,
	type RuntimePrompt,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkflowReportTool,
	createWorkflowRuntime,
	type WorkflowReport,
} from "./workflow-runtime.ts";

/** Small native graphs expose accidental advancement after a poisoned report. */
const workflow = Workflow.parse({
	commands: {
		delegate: {
			description: "Delegate",
			chain: [
				{ kind: "agent", name: "planner" },
				{ kind: "agent", name: "schemer" },
			],
		},
	},
	vault: { dirs: [], template_kinds: [] },
});
/** Inert definitions need neither a provider nor model selection. */
const agents = ["planner", "schemer"].map((name) => ({
	spec: AgentSpec.parse({
		name,
		tier: "low",
		description: name,
		capabilities: [],
	}),
	prompt: name,
}));
/** Completion reports are explicit even for minimal fake role sessions. */
const done = { status: "completed", summary: "finished-role-marker" };
/** Public handoffs use only text, never thought chunks or opaque routing transcripts. */
const text = (content: readonly RuntimeContent[]): string =>
	content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
/** A tool boundary models embedded preflight, including failures that never call execute. */
const preflight = async (
	report: WorkflowReport,
	request: RuntimePrompt,
	args: unknown,
): Promise<boolean> => {
	const tool = createWorkflowReportTool(report);
	const parsed = tool.schema.safeParse(args);
	if (!parsed.success) {
		await request.activity?.({
			kind: "tool",
			toolCallId: "embedded:bad-report",
			title: tool.name,
			toolKind: tool.kind,
			status: "failed",
			rawOutput: {
				text: "Tool arguments failed schema validation",
				isError: true,
			},
		});
		return false;
	}
	await tool.execute(parsed.data, {
		toolCallId: "embedded:report",
		cwd: ".",
		roots: ["."],
		signal: request.signal,
	});
	return true;
};
/** All observations use wrapper APIs; the routing checkpoint deliberately has no readable messages. */
const harness = (
	behavior: (
		report: WorkflowReport,
		request: RuntimePrompt,
	) => Promise<RuntimeStopReason> = async (report) => {
		report(done);
		return "completed";
	},
) => {
	const chunks: string[] = [];
	const activities: RuntimeActivity[] = [];
	const calls: RuntimePrompt[] = [];
	const cleanup = vi.fn(async () => undefined);
	const routing = {
		prompt: vi.fn(
			async (request: RuntimePrompt): Promise<RuntimeStopReason> => {
				await request.emit({
					kind: "thought",
					messageId: "private",
					text: "thought-must-not-be-shared",
				});
				await request.emit({
					kind: "text",
					messageId: "reply",
					text: "assistant-",
				});
				await request.emit({
					kind: "text",
					messageId: "reply",
					text: "reply-marker",
				});
				return "completed";
			},
		),
		snapshot: () => ({ opaque: "checkpoint-must-not-be-shared" }),
		restore: vi.fn(),
		dispose: vi.fn(async () => undefined),
	};
	const createAgent = vi.fn(async (_name: string, report: WorkflowReport) => ({
		prompt: async (request: RuntimePrompt) => {
			calls.push(request);
			return behavior(report, request);
		},
		dispose: cleanup,
	}));
	const runtime = createWorkflowRuntime({
		workflow,
		agents,
		routing,
		createAgent,
	});
	const request = (value: string): RuntimePrompt => ({
		content: [{ type: "text", text: value }],
		signal: new AbortController().signal,
		emit: async ({ text: chunk }) => {
			chunks.push(chunk);
		},
		activity: async (event) => {
			activities.push(event);
		},
	});
	const prompt = (value: string) => runtime.prompt(request(value));
	const snapshot = () =>
		runtime.snapshot!() as {
			engine: EngineState | null;
			history: RuntimeContent[];
			routingHistory: number;
		};
	return {
		runtime,
		routing,
		createAgent,
		calls,
		chunks,
		activities,
		cleanup,
		request,
		prompt,
		snapshot,
	};
};

// oxlint-disable-next-line max-statements -- Independent review regressions share inert fixture construction only.
describe("workflow review boundaries", () => {
	it.each([true, false])(
		"poisons a valid report followed by preflight failure (client activities: %s)",
		async (clientActivity) => {
			const callback = vi.fn();
			const h = harness(async (report, request) => {
				const observed: WorkflowReport = (outcome) => {
					callback(outcome);
					report(outcome);
				};
				expect(await preflight(observed, request, done)).toBe(true);
				expect(
					await preflight(observed, request, { status: "completed" }),
				).toBe(false);
				return "completed";
			});
			const request = h.request("/delegate task");
			await h.runtime.prompt({
				...request,
				activity: clientActivity ? request.activity : undefined,
			});
			expect(callback).toHaveBeenCalledTimes(1);
			expect(h.createAgent).toHaveBeenCalledTimes(1);
			expect(h.snapshot().engine?.status).toBe("blocked");
			expect(h.snapshot().engine?.records[0].error).toMatch(
				/d3r_report validation or execution failed/,
			);
			if (clientActivity) {
				expect(
					h.activities.some(
						(event) =>
							event.kind === "tool" &&
							event.toolCallId === "embedded:bad-report" &&
							event.status === "failed",
					),
				).toBe(true);
				expect(h.activities.at(-1)).toMatchObject({ kind: "plan" });
				expect(
					h.activities.findLast(
						(event) => event.kind === "tool" && event.title === "planner",
					),
				).toMatchObject({
					status: "failed",
					rawOutput: { error: expect.stringContaining("d3r_report") },
				});
			}
		},
	);
	it("does not clear an earlier preflight failure with a later valid report", async () => {
		const h = harness(async (report, request) => {
			await preflight(report, request, { ...done, summary: "" });
			await preflight(report, request, done);
			return "completed";
		});
		await h.prompt("/delegate task");
		expect(h.snapshot().engine?.status).toBe("blocked");
	});
	it("preserves callback failure through tool events, stop reasons, and cleanup errors", async () => {
		const h = harness(async (report, request) => {
			report(done);
			try {
				report(done);
			} catch {
				/* Tool execution may catch callback errors. */
			}
			await preflight(report, request, { status: "completed" });
			return "token_limit";
		});
		h.cleanup.mockRejectedValue(new Error("sensitive cleanup diagnostic"));
		await h.prompt("/delegate task");
		expect(h.snapshot().engine?.records[0].error).toBe(
			"Invalid or duplicate d3r_report; workflow paused.",
		);
		expect(JSON.stringify(h.activities)).not.toContain("sensitive");
	});
	it("does not poison successful reporting for unrelated failed tools", async () => {
		const h = harness(async (report, request) => {
			report(done);
			await request.activity?.({
				kind: "tool",
				toolCallId: "read",
				title: "read_file",
				toolKind: "read",
				status: "failed",
			});
			return "completed";
		});
		await h.prompt("/delegate task");
		expect(h.snapshot().engine?.status).toBe("completed");
	});
	it.each(["factory", "prompt", "dispose", "emit"])(
		"sanitizes unexpected %s failures before public output or persistence",
		async (stage) => {
			const secret = "Bearer resource-editor-provider-private-diagnostic";
			const h = harness(async (report, request) => {
				if (stage === "prompt") {
					throw new Error(secret);
				}
				if (stage === "emit") {
					await request.emit({
						kind: "text",
						messageId: "answer",
						text: "safe",
					});
				}
				report(done);
				return "completed";
			});
			if (stage === "factory") {
				h.createAgent.mockRejectedValue(new Error(secret));
			}
			if (stage === "dispose") {
				h.cleanup.mockRejectedValue(new Error(secret));
			}
			const request = h.request("/delegate task");
			const emit: RuntimePrompt["emit"] = async (chunk) => {
				if (chunk.messageId.endsWith(":answer")) {
					throw new Error(secret);
				}
				await request.emit(chunk);
			};
			await h.runtime.prompt({ ...request, emit });
			expect(h.snapshot().engine?.status).toBe("blocked");
			expect(h.snapshot().engine?.records[0].error).toMatch(
				stage === "dispose"
					? /Role cleanup failed/
					: /Role setup or execution failed/,
			);
			expect(
				JSON.stringify([h.snapshot(), h.chunks, h.activities]),
			).not.toContain(secret);
		},
	);
	it("does not echo arbitrary runtime completion reasons", async () => {
		const h = harness(async (report) => {
			report(done);
			return "private invalid completion diagnostic" as RuntimeStopReason;
		});
		await h.prompt("/delegate task");
		expect(h.snapshot().engine?.records[0].error).toContain(
			"invalid completion reason",
		);
		expect(
			JSON.stringify([h.snapshot(), h.chunks, h.activities]),
		).not.toContain("private invalid");
	});
	it("never stringifies an untrusted thrown object", async () => {
		const toString = vi.fn(() => "secret");
		// oxlint-disable-next-line no-throw-literal -- Arbitrary provider rejection values are an untyped boundary.
		const h = harness(async () => {
			throw { toString };
		});
		await h.prompt("/delegate task");
		expect(toString).not.toHaveBeenCalled();
		expect(h.snapshot().engine?.records[0].error).toContain(
			"Role setup or execution failed",
		);
	});
	it("preserves known isolation protocol failures rather than trusting exception text", async () => {
		const h = harness();
		h.createAgent.mockResolvedValue(h.routing);
		await h.prompt("/delegate task");
		expect(h.snapshot().engine?.records[0].error).toBe(
			"createAgent must return a fresh, isolated runtime",
		);
	});
	it("hands incoming routing discussion and assembled text responses to children", async () => {
		const h = harness();
		await h.prompt("Use the green architecture");
		await h.prompt("/delegate implement the discussed plan");
		for (const call of h.calls) {
			const handoff = text(call.content);
			expect(handoff).toContain("Use the green architecture");
			expect(handoff).toContain("assistant-reply-marker");
			expect(handoff).not.toContain("thought-must-not-be-shared");
			expect(handoff).not.toContain("checkpoint-must-not-be-shared");
			expect(handoff.match(/Use the green architecture/g)).toHaveLength(1);
		}
	});
	it("injects workflow results into routing once per boundary, not every routing turn", async () => {
		const h = harness();
		await h.prompt("/delegate first task");
		await h.prompt("Explain the results");
		expect(text(h.routing.prompt.mock.calls[0][0].content)).toContain(
			"finished-role-marker",
		);
		await h.prompt("Thanks");
		expect(text(h.routing.prompt.mock.calls[1][0].content)).toBe("Thanks");
		expect(
			text(h.snapshot().history).match(/\/delegate first task/g),
		).toHaveLength(1);
		await h.prompt("/delegate second task");
		await h.prompt("Compare these results");
		const handoff = text(h.routing.prompt.mock.calls[2][0].content);
		expect(handoff).toContain("/delegate second task");
		expect(handoff).not.toContain("/delegate first task");
		expect(handoff.match(/Workflow outcomes/g)).toHaveLength(1);
		expect(text(h.snapshot().history).match(/Workflow outcomes/g)).toHaveLength(
			2,
		);
	});
	it("restores shared discussion and the delivered cursor without replay or duplicate handoff", async () => {
		const original = harness();
		await original.prompt("Remember this routing decision");
		const h = harness();
		h.runtime.restore!(JSON.stringify(original.runtime.snapshot!()));
		expect(h.routing.prompt).not.toHaveBeenCalled();
		await h.prompt("/delegate saved decision");
		expect(text(h.calls[0].content)).toContain(
			"Remember this routing decision",
		);
		await h.prompt("Explain");
		const next = harness();
		next.runtime.restore!(JSON.stringify(h.runtime.snapshot!()));
		await next.prompt("Only this new question");
		expect(text(next.routing.prompt.mock.calls[0][0].content)).toBe(
			"Only this new question",
		);
	});
	it("does not duplicate workflow handoffs or record partial answers across interrupted restart", async () => {
		const h = harness();
		await h.prompt("/delegate original");
		h.routing.prompt.mockImplementationOnce(async (request) => {
			await request.emit({
				kind: "text",
				messageId: "partial",
				text: "partial-is-not-final",
			});
			return "cancelled";
		});
		await h.prompt("Discuss results");
		const restored = harness();
		restored.runtime.restore!(JSON.stringify(h.runtime.snapshot!()));
		await restored.prompt("restart");
		const handoff = text(restored.routing.prompt.mock.calls[0][0].content);
		expect(handoff.match(/Workflow outcomes/g)).toHaveLength(1);
		expect(handoff.match(/Discuss results/g)).toHaveLength(1);
		expect(text(restored.snapshot().history)).not.toContain(
			"partial-is-not-final",
		);
		await restored.prompt("/delegate next");
		expect(
			text(restored.calls[0].content).match(/\/delegate original/g),
		).toHaveLength(1);
	});
	it("includes a blocked record's status and error when abandoning to routing", async () => {
		const h = harness(async (report, request) => {
			report(done);
			await preflight(report, request, {});
			return "completed";
		});
		await h.prompt("/delegate task");
		await h.prompt("abandon");
		await h.prompt("What failed?");
		expect(text(h.routing.prompt.mock.calls[0][0].content)).toContain(
			'"status":"blocked"',
		);
		expect(text(h.routing.prompt.mock.calls[0][0].content)).toContain(
			"d3r_report validation or execution failed",
		);
	});
});
