import { createSessionStore } from "@d3r/adapter-acp/server";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { nativeJourneySuite } from "./harness.ts";
import {
	callWith,
	expectStop,
	JOURNEY_INIT_TIMEOUT,
	journeyCall as call,
	journeyCheckpoint,
	journeyDone as done,
	journeyFailureStream,
	journeyPhaseReply as phaseReply,
	journeyResult as result,
	journeyResultText as resultText,
	journeyStream,
	journeyText,
	journeyTools,
	journeyTopic,
	journeyUserText,
	lastRequest,
	reply,
	roleRequests,
	workspaceSnapshot,
	writeFiles,
	type JourneyContext,
	type JourneyScripts,
} from "./helpers.ts";

/** Recovery uses the existing action, never abandonment or a replacement task. */
const expectContinuation = (
	context: JourneyContext,
	updates: Parameters<typeof journeyTools>[0],
) => {
	expect(
		result(context, "d3r_continue_phase"),
		resultText(context, "d3r_continue_phase").split("\n")[0],
	).toMatchObject({ isError: false });
	const titles = journeyTools(updates)
		.filter(({ sessionUpdate }) => sessionUpdate === "tool_call")
		.map(({ title }) => title);
	expect(titles).toContain("d3r_continue_phase");
	for (const action of [
		"d3r_abandon_phase",
		"d3r_start_phase",
		"d3r_run_role",
	]) {
		expect(titles).not.toContain(action);
	}
};

/** Explicit retry keeps the pinned task, settled effects, and workflow checkpoints. */
describe("native ACP blocked-role restart journeys", () => {
	const { open } = nativeJourneySuite();

	it.each([
		"retained",
		"older without worker snapshot",
		"provider failure",
	] as const)(
		"restarts a blocked semi implementor after close/load: %s",
		// oxlint-disable-next-line max-statements -- Durable recovery and non-replay must be observed across the same real ACP session.
		async (checkpointKind) => {
			const providerFailed = checkpointKind === "provider failure";
			const settledCalls = [
				"initial-read",
				"initial-write",
				...(providerFailed ? [] : ["blocked-report"]),
			];
			const brief = {
				goal: "Implement local queue retention in queue.txt.",
				context:
					"The proposed retention is 24 hours, pending operator confirmation.",
				acceptanceCriteria: [
					"Record the agreed retention and preserve operator notes.",
				],
				constraints: [
					"Only queue.txt; no commits, network, or follow-on roles.",
				],
			};
			const initial = "Retention: undecided.\n";
			const written = "Retention: 24 hours.\n";
			const blocked =
				"Wrote the provisional 24-hour retention to queue.txt; blocked on policy confirmation.";
			const correction =
				"Continue the same implementor in semi mode: I confirm 24-hour retention. Preserve my operator note.";
			const external = `${written}Operator note: keep the local-only path.\n`;
			const completed =
				"Verified the agreed 24-hour retention and preserved the operator note in queue.txt.";
			const scripts: JourneyScripts = {
				router: [
					call("d3r_run_role", { role: "implementor", mode: "semi", brief }),
					phaseReply("d3r_run_role", "Implementation blocked"),
					call("d3r_continue_phase", { instructions: correction }),
					phaseReply("d3r_continue_phase", "Implementation continued"),
				],
				implementor: [
					call("read_file", { path: "queue.txt" }, "initial-read"),
					callWith(
						"write_file",
						(context) => ({
							path: "queue.txt",
							content: written,
							snapshot: workspaceSnapshot(context, "initial-read"),
						}),
						"initial-write",
					),
					...(providerFailed
						? [[]]
						: [
								call(
									"d3r_report",
									{ status: "blocked", summary: blocked },
									"blocked-report",
								),
								reply(blocked),
							]),
					call("read_file", { path: "queue.txt" }, "current-read"),
					call(
						"run_command",
						{
							command: "git",
							args: [
								"--no-pager",
								"--no-optional-locks",
								"diff",
								"--no-ext-diff",
								"--no-color",
								"--",
								"queue.txt",
							],
						},
						"current-diff",
					),
					...done(completed, { allDone: true }),
				],
			};
			const j = await open(scripts, {
				routerShortcuts: false,
				streamResponse: (role, content) =>
					role === "implementor" && content.length === 0
						? journeyFailureStream(
								'429 {"error":{"code":"insufficient_quota"}}',
							)
						: journeyStream(content),
			});
			await writeFiles(j.cwd, { "queue.txt": initial });
			const git = (...args: string[]) =>
				promisify(execFile)(
					"git",
					["--no-pager", "--no-optional-locks", ...args],
					{ cwd: j.cwd, timeout: JOURNEY_INIT_TIMEOUT },
				);
			// An index baseline makes the later diff real without creating a fixture commit.
			await git("init", "--quiet");
			await git("add", "--", "queue.txt");
			const f = await j.connect();
			const { sessionId } = await f.session();
			await expectStop(
				f.prompt(
					sessionId,
					`Run only the implementor in semi mode. ${brief.goal}\n${brief.context}`,
				),
			);
			const checkpoint = await f.checkpoint(sessionId);
			const pin = journeyCheckpoint(checkpoint);
			const waiting = pin.inner!;
			const [worker] = waiting.engine!.records;
			expect(waiting).toMatchObject({
				orchestrated: true,
				standaloneRole: "implementor",
				phase: "routing",
				engine: { command: "standalone", mode: "semi", status: "blocked" },
			});
			expect(worker).toMatchObject({ role: "implementor", status: "blocked" });
			if (providerFailed) {
				expect(worker.error).toContain("HTTP 429; code `insufficient_quota`");
				expect(worker).not.toHaveProperty("outcome");
			} else {
				expect(worker.outcome).toEqual({ status: "blocked", summary: blocked });
			}
			const blocker = worker.error ?? blocked;
			expect(waiting.topic).toEqual(expect.any(String));
			const settled = lastRequest(j.requests, "implementor").context;
			for (const id of settledCalls) {
				expect(result(settled, id), id).toMatchObject({ isError: false });
			}
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(written);
			expect(journeyText(f.updates)).toContain(blocker);
			await f.closeSession(sessionId);
			await f.close();

			let reloadCheckpoint = checkpoint;
			if (checkpointKind === "older without worker snapshot") {
				// Remove only optional worker transcripts from a complete native journal, not its outcomes or resource pin.
				const store = createSessionStore(
					resolve(j.root, "home/.agents/d3r/private/sessions"),
				);
				const saved = (await store.get(sessionId))!;
				const native = journeyCheckpoint(checkpoint);
				delete native.inner!.continuations;
				reloadCheckpoint = { ...(checkpoint as object), runtime: native };
				await store.save({
					...saved,
					records: [
						...saved.records.slice(0, -1),
						{ kind: "checkpoint", state: reloadCheckpoint },
					],
				});
			}
			const beforeLoad = {
				requests: j.requests.length,
				permissions: j.permissions.length,
			};
			const resumed = await j.connect();
			await resumed.load(sessionId);
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(
				reloadCheckpoint,
			);
			expect(j.requests).toHaveLength(beforeLoad.requests);
			expect(j.permissions).toHaveLength(beforeLoad.permissions);

			// An identical replay of the initial write would erase this operator edit.
			await writeFiles(j.cwd, { "queue.txt": external });
			const start = resumed.updates.length;
			await expectStop(resumed.prompt(sessionId, correction));
			const recovery = j.requests.slice(beforeLoad.requests);
			const routed = lastRequest(recovery, "router").context;
			const updates = resumed.updates.slice(start);
			expectContinuation(routed, updates);
			expect(new Set(recovery.map(({ role }) => role))).toEqual(
				new Set(["router", "implementor"]),
			);
			const restarted = roleRequests(recovery, "implementor")[0].context;
			expect(restarted.systemPrompt).toContain("You are implementor.");
			for (const fact of [
				brief.goal,
				brief.context,
				...brief.acceptanceCriteria,
				...brief.constraints,
				blocker,
				correction,
			]) {
				expect(JSON.stringify(restarted.messages)).toContain(fact);
			}
			expect(journeyTopic(restarted)).toBe(waiting.topic);
			expect(journeyUserText(restarted)).toContain("Mode: semi");
			if (checkpointKind !== "older without worker snapshot") {
				expect(waiting.continuations).toEqual([
					expect.objectContaining({ recordId: worker.id }),
				]);
				for (const id of settledCalls) {
					expect(result(restarted, id), id).toEqual(result(settled, id));
				}
			} else {
				expect(
					restarted.messages.filter(
						({ role }) => role === "assistant" || role === "toolResult",
					),
				).toEqual([]);
				const guidance = journeyUserText(restarted);
				expect(guidance).toMatch(
					/(?:fresh|new) (?:same-role |worker |role )?conversation/i,
				);
				expect(guidance).toMatch(
					/(?:inspect|review|read)[^.\n]*(?:diff|changes|worktree|workspace|current state)/i,
				);
				expect(guidance).not.toContain(
					"using the retained conversation and tool results",
				);
			}
			const finished = lastRequest(recovery, "implementor").context;
			for (const id of ["current-read", "current-diff", "d3r_report"]) {
				expect(result(finished, id), id).toMatchObject({ isError: false });
			}
			expect(resultText(finished, "current-read")).toContain(written.trim());
			expect(resultText(finished, "current-read")).toContain(
				"Operator note: keep the local-only path.",
			);
			expect(resultText(finished, "current-diff")).toContain(
				"+Operator note: keep the local-only path.",
			);
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(
				external,
			);
			expect(journeyTools(updates)).not.toContainEqual(
				expect.objectContaining({
					sessionUpdate: "tool_call",
					title: "write_file",
				}),
			);
			const final = await resumed.state(sessionId);
			expect(final.resources).toEqual(pin.resources);
			expect(final.inner).toMatchObject({
				standaloneRole: "implementor",
				topic: waiting.topic,
				engine: {
					command: "standalone",
					mode: "semi",
					workflow: waiting.engine!.workflow,
					status: "completed",
					pause: null,
					records: [
						{
							id: worker.id,
							role: "implementor",
							status: "completed",
							outcome: {
								status: "completed",
								summary: completed,
								allDone: true,
							},
						},
					],
				},
			});
			expect(final.inner!.engine!.records[0]).not.toHaveProperty("error");
			expect(final.inner!.continuations ?? []).toEqual([]);
			expect(journeyText(updates)).toContain(completed);
			const continueTool = routed.tools!.find(
				({ name }) => name === "d3r_continue_phase",
			)!;
			expect(continueTool.parameters).toEqual(
				expect.objectContaining({
					properties: {
						instructions: expect.objectContaining({ type: "string" }),
					},
					required: ["instructions"],
				}),
			);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
		},
		JOURNEY_INIT_TIMEOUT,
	);

	// oxlint-disable-next-line max-statements -- Preserve the completed sibling through blocked recovery up to the shipped human checkpoint.
	it("retries only blocked research in /design and still waits for the existing human decision", async () => {
		const brief = {
			goal: "Design local queue expiration.",
			context:
				"Use policy.txt and supplied local documentation; no external research or artifact writes.",
			acceptanceCriteria: ["Discuss the research before drafting a design."],
		};
		const policy = "Offline jobs expire locally.\n";
		const siblingSummary =
			"Documentation confirms the queue is local; no network service is required.";
		const blocked =
			"Research blocked: the supplied policy has no retention period.";
		const correction =
			"Retry only the blocked researcher: use the operator's 72-hour retention policy. Do not draft yet.";
		const researched =
			"Confirmed the operator's 72-hour retention policy for local expiration.";
		const scripts: JourneyScripts = {
			router: [
				call("d3r_start_phase", { phase: "design", brief }),
				phaseReply("d3r_start_phase", "Research blocked"),
				call("d3r_phase_status", {}),
				phaseReply("d3r_phase_status", "Current research status"),
				call("d3r_continue_phase", { instructions: correction }),
				phaseReply("d3r_continue_phase", "Research ready for discussion"),
			],
			aggregator: [
				call("read_file", { path: "policy.txt" }, "docs-read"),
				...done(siblingSummary),
			],
			researcher: [
				call("read_file", { path: "policy.txt" }, "policy-read"),
				call(
					"d3r_report",
					{ status: "blocked", summary: blocked },
					"blocked-research",
				),
				reply(blocked),
				...done(researched),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		await writeFiles(j.cwd, { "policy.txt": policy });
		const f = await j.connect();
		const { sessionId } = await f.session();
		const pin = await f.state(sessionId);
		await expectStop(
			f.prompt(sessionId, `/design ${brief.goal}\n${brief.context}`),
		);
		const blockedState = await f.state(sessionId);
		const waiting = blockedState.inner!;
		expect(waiting).toMatchObject({
			orchestrated: true,
			engine: {
				command: "design",
				workflow: pin.resources.workflow,
				status: "blocked",
			},
		});
		const sibling = waiting.engine!.records.find(
			({ role }) => role === "aggregator",
		)!;
		const worker = waiting.engine!.records.find(
			({ role }) => role === "researcher",
		)!;
		expect(sibling).toMatchObject({
			status: "completed",
			outcome: { status: "completed", summary: siblingSummary },
		});
		expect(worker).toMatchObject({
			status: "blocked",
			outcome: { status: "blocked", summary: blocked },
		});
		expect(
			resultText(lastRequest(j.requests, "aggregator").context, "docs-read"),
		).toContain(policy.trim());
		expect(journeyText(f.updates)).toContain(blocked);
		expect(roleRequests(j.requests, "designer")).toEqual([]);
		const siblings = roleRequests(j.requests, "aggregator");
		const researchers = roleRequests(j.requests, "researcher");
		await expectStop(
			f.prompt(sessionId, "What is blocked? Just show status; do not retry."),
		);
		const status = await f.state(sessionId);
		expect(status.inner!.engine).toEqual(waiting.engine);
		expect(roleRequests(j.requests, "aggregator")).toEqual(siblings);
		expect(roleRequests(j.requests, "researcher")).toEqual(researchers);
		const beforeRetry = j.requests.length;
		const start = f.updates.length;
		await expectStop(f.prompt(sessionId, correction));
		const recovery = j.requests.slice(beforeRetry);
		const routed = lastRequest(recovery, "router").context;
		const updates = f.updates.slice(start);
		expectContinuation(routed, updates);
		expect(new Set(recovery.map(({ role }) => role))).toEqual(
			new Set(["router", "researcher"]),
		);
		const restarted = roleRequests(recovery, "researcher")[0].context;
		for (const fact of [
			brief.goal,
			brief.context,
			blocked,
			siblingSummary,
			correction,
		]) {
			expect(JSON.stringify(restarted.messages)).toContain(fact);
		}
		for (const id of ["policy-read", "blocked-research"]) {
			expect(result(restarted, id), id).toMatchObject({ isError: false });
		}
		expect(
			result(lastRequest(recovery, "researcher").context, "d3r_report"),
		).toMatchObject({ isError: false });
		expect(journeyTopic(restarted)).toBe(waiting.topic);
		const final = await f.state(sessionId);
		expect(final.resources).toEqual(pin.resources);
		expect(final.inner).toMatchObject({
			topic: waiting.topic,
			engine: {
				command: "design",
				workflow: waiting.engine!.workflow,
				mode: waiting.engine!.mode,
				status: "waiting",
				pause: {
					kind: "human",
					message: "Discuss design questions before drafting",
				},
			},
		});
		expect(final.inner!.engine!.records).toContainEqual(sibling);
		expect(
			final.inner!.engine!.records.find(({ id }) => id === worker.id),
		).toMatchObject({
			role: "researcher",
			status: "completed",
			outcome: { status: "completed", summary: researched },
		});
		expect(final.inner!.continuations ?? []).toEqual([]);
		expect(roleRequests(j.requests, "aggregator")).toEqual(siblings);
		expect(roleRequests(j.requests, "designer")).toEqual([]);
		for (const evidence of [
			siblingSummary,
			researched,
			"Discuss design questions before drafting",
		]) {
			expect(journeyText(updates)).toContain(evidence);
		}

		expect(await readFile(resolve(j.cwd, "policy.txt"), "utf8")).toBe(policy);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
