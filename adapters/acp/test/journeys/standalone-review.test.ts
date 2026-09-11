import {
	expectStop,
	type JourneyScripts,
	reply,
	journeyReport as reportCall,
	roleRequests,
	JOURNEY_INSPECTION_TOOLS,
	journeyCall as call,
	journeyDone as done,
	journeyResult as result,
	journeyResultText as resultText,
	journeyPhaseReply as phaseReply,
	journeyText as agentText,
	callWith,
	lastRequest,
	workspaceSnapshot,
} from "./helpers.ts";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { nativeJourneySuite } from "./harness.ts";

describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();

	// oxlint-disable-next-line max-statements -- Standalone approval and a later explicit develop must remain separate lifecycles.
	it("keeps standalone reviewer approval independent and starts the normal develop graph only when requested", async () => {
		const original = "export const first = (jobs) => jobs[0];\n";
		const source = "export const first = (jobs) => jobs.at(0) ?? null;\n";
		const approval =
			"Approved queue.mjs:1 for the existing nonempty-input contract; this is standalone review evidence, not develop approval.";
		const goal = "Now develop an empty-queue fallback returning null.";
		const scope = "Only queue.mjs; do not commit or create vault artifacts.";
		const criterion =
			"An empty queue returns null and a nonempty queue returns its first job.";
		const reports = {
			implementor: "Implemented the empty-queue fallback in queue.mjs.",
			reviewer: "Approved the new null fallback after inspecting queue.mjs:1.",
			auditor:
				"Audited the null fallback independently of the earlier standalone approval.",
		};
		const scripts: JourneyScripts = {
			router: [
				call(
					"d3r_run_role",
					{
						role: "reviewer",
						brief: {
							goal: "Review queue.mjs independently.",
							context:
								"The current contract accepts nonempty queues; do not implement or audit anything else.",
							acceptanceCriteria: [
								"Return an inline verdict, not a report file.",
							],
						},
					},
					"standalone-review",
				),
				phaseReply("standalone-review", "Independent review"),
				call(
					"d3r_start_phase",
					{
						phase: "develop",
						brief: { goal, context: scope, acceptanceCriteria: [criterion] },
					},
					"choose-develop-mode",
				),
				phaseReply("choose-develop-mode", "Choose develop mode"),
				call(
					"d3r_continue_phase",
					{ instructions: "auto" },
					"develop-after-review",
				),
				phaseReply(
					"develop-after-review",
					"Fallback implemented, reviewed and audited",
				),
			],
			reviewer: [
				call("read_file", { path: "queue.mjs" }, "standalone-source"),
				...done(
					approval,
					{ review: "approved" },
					"Worker-only standalone approval",
				),
				call("read_file", { path: "queue.mjs" }, "develop-review-source"),
				reportCall(reports.reviewer, { review: "approved" }),
				reply("Worker-only develop approval"),
			],
			implementor: [
				call("read_file", { path: "queue.mjs" }),
				callWith("write_file", (context) => ({
					path: "queue.mjs",
					content: source,
					snapshot: workspaceSnapshot(context, "read_file"),
				})),
				...done(
					reports.implementor,
					{ allDone: true },
					"Worker-only implementation",
				),
			],
			auditor: [
				call("read_file", { path: "queue.mjs" }, "develop-audit-source"),
				...done(reports.auditor),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		await writeFile(resolve(j.cwd, "queue.mjs"), original);
		const f = await j.connect();
		const { sessionId } = await f.session();
		const pin = await f.state(sessionId);
		await expectStop(
			f.prompt(
				sessionId,
				"Review queue.mjs against its nonempty-input contract only; give an inline verdict, without implementation or audit.",
			),
		);
		const reviewed = await f.state(sessionId);
		expect(reviewed.resources).toEqual(pin.resources);
		expect(reviewed.inner).toMatchObject({
			standaloneRole: "reviewer",
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: { command: "standalone", status: "completed", pause: null },
		});
		expect(reviewed.inner!.engine!.workflow).toEqual({
			commands: {
				standalone: {
					description: "Run reviewer independently",
					chain: [{ kind: "agent", name: "reviewer" }],
				},
			},
			vault: pin.resources.workflow.vault,
		});
		expect(reviewed.inner!.engine!.records).toEqual([
			expect.objectContaining({
				kind: "agent",
				role: "reviewer",
				loops: [],
				status: "completed",
				outcome: { status: "completed", summary: approval, review: "approved" },
			}),
		]);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"reviewer",
		]);
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "reviewer"]),
		);
		expect(
			resultText(
				lastRequest(j.requests, "reviewer").context,
				"standalone-source",
			),
		).toContain(original.trim());
		expect(
			resultText(j.requests.at(-1)!.context, "standalone-review"),
		).toContain(
			"## Role: reviewer\nStatus: completed\nMode: standalone\nThis is an independent role task, not completion or approval of a phase.",
		);
		expect(agentText(f.updates)).toContain(approval);
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(original);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		const beforeDevelop = j.requests.length;
		await expectStop(f.prompt(sessionId, `${goal}\n${scope}\n${criterion}`));
		const waiting = await f.state(sessionId);
		expect(waiting.resources).toEqual(pin.resources);
		expect(waiting.inner).not.toHaveProperty("standaloneRole");
		expect(waiting.inner).toMatchObject({
			phase: "develop",
			workflow: pin.resources.workflow,
			engine: {
				command: "develop",
				workflow: pin.resources.workflow,
				status: "waiting",
				mode: null,
				pause: { kind: "mode" },
			},
		});
		expect(
			waiting.inner!.engine!.records.every(
				({ status, outcome }) => status === "pending" && outcome === undefined,
			),
		).toBe(true);
		expect(
			waiting
				.inner!.engine!.records.filter(({ kind }) => kind === "agent")
				.map(({ role }) => role),
		).toEqual([
			"implementor",
			"reviewer",
			"implementor",
			"reviewer",
			"implementor",
			"reviewer",
			"auditor",
		]);
		expect(j.requests.slice(beforeDevelop).map(({ role }) => role)).toEqual([
			"router",
			"router",
		]);
		expect(agentText(f.updates)).toContain("Choose develop mode");
		const start = f.updates.length;
		await expectStop(f.prompt(sessionId, "auto"));
		const completed = await f.state(sessionId);
		expect(completed.resources).toEqual(pin.resources);
		expect(completed.inner).not.toHaveProperty("standaloneRole");
		expect(completed.inner).not.toHaveProperty("summary");
		expect(completed.inner).toMatchObject({
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: {
				command: "develop",
				workflow: pin.resources.workflow,
				status: "completed",
				mode: "auto",
				pause: null,
			},
		});
		expect(
			completed
				.inner!.engine!.records.filter(
					({ kind, status }) => kind === "agent" && status === "completed",
				)
				.map(({ role, outcome }) => ({ role, summary: outcome!.summary })),
		).toEqual(
			Object.entries(reports).map(([role, summary]) => ({ role, summary })),
		);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"reviewer",
			"implementor",
			"reviewer",
			"auditor",
		]);
		for (const { role, context } of j.requests.filter(
			(entry) => entry.role !== "router",
		)) {
			expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
				role === "implementor"
					? [...JOURNEY_INSPECTION_TOOLS, "edit_file", "vault_edit"].toSorted()
					: JOURNEY_INSPECTION_TOOLS,
			);
		}
		expect(
			result(lastRequest(j.requests, "implementor").context, "write_file"),
		).toMatchObject({ isError: false });
		for (const [role, id] of [
			["reviewer", "develop-review-source"],
			["auditor", "develop-audit-source"],
		]) {
			const { context } = lastRequest(j.requests, role);
			expect(result(context, id)).toMatchObject({ isError: false });
			expect(resultText(context, id)).toContain(source.trim());
		}
		expect(
			result(j.requests.at(-1)!.context, "develop-after-review"),
		).toMatchObject({ isError: false });
		expect(
			resultText(j.requests.at(-1)!.context, "develop-after-review"),
		).toContain("## Phase: develop\nStatus: completed\nMode: auto");
		for (const summary of Object.values(reports)) {
			expect(agentText(f.updates.slice(start))).toContain(summary);
		}
		expect(agentText(f.updates.slice(start))).not.toMatch(
			/Worker-only|"status"|Workflow complete/,
		);
		expect(
			f.updates
				.slice(start)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(roleRequests(j.requests, "summary")).toEqual([]);
		expect(await readdir(j.cwd)).toEqual(["AGENTS.md", "queue.mjs"]);
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(source);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
