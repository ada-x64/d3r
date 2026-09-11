import {
	expectStop,
	type JourneyScripts,
	JOURNEY_INSPECTION_TOOLS,
	journeyCall as call,
	journeyDone as done,
	journeyResult as result,
	journeyResultText as resultText,
	journeyPhaseReply as phaseReply,
	journeyText as agentText,
	journeyStream as stream,
	journeyCheckpoint as parseState,
	reply,
	roleRequests,
	lastRequest,
	writeFiles,
} from "./helpers.ts";

import { RequestError } from "@agentclientprotocol/sdk";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deferred, waitForAbort } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";

describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();

	it.each(["needs_human", "cancelled"] as const)(
		"reloads a standalone auditor %s checkpoint, rejects active-role picker changes and continues only that auditor",
		// oxlint-disable-next-line max-statements -- Persistence, inert load, and retained worker evidence form one recovery journey.
		async (pause) => {
			const goal = "Audit local queue retention without starting develop.";
			const scope =
				"policy.txt leaves the retention period undecided; ask me rather than inventing a limit.";
			const question = "How many hours may an offline queue job be retained?";
			const answer =
				"Retain jobs for 72 hours; continue this audit, not implementation.";
			const finding =
				"**High - queue.txt:1:** the worktree retains jobs for 96 hours, exceeding the user's 72-hour limit.";
			const atRead = deferred<void>();
			const scripts: JourneyScripts = {
				router: [
					call(
						"d3r_run_role",
						{
							role: "auditor",
							brief: {
								goal,
								context: scope,
								acceptanceCriteria: [
									"Report retention mismatches inline; do not edit files.",
								],
							},
						},
						"audit-question",
					),
					...(pause === "needs_human"
						? [phaseReply("audit-question", "Retention decision needed")]
						: []),
					call("d3r_continue_phase", { instructions: answer }, "resume-audit"),
					phaseReply("resume-audit", "Retention audit complete"),
				],
				auditor: [
					call("read_file", { path: "policy.txt" }, "policy-read"),
					...(pause === "needs_human"
						? [
								call(
									"d3r_report",
									{ status: "needs_human", summary: question },
									"missing-limit",
								),
								reply("Worker-only waiting response"),
							]
						: [reply(question)]),
					call("read_file", { path: "queue.txt" }, "queue-read"),
					...done(finding, {}, "Worker-only resumed response"),
				],
			};
			const j = await open(scripts, {
				routerShortcuts: false,
				readTextFile: async ({ path }) => ({
					content: await readFile(path, "utf8"),
				}),
				streamResponse: (role, content, settings) =>
					stream(content, async (index) => {
						if (
							pause === "cancelled" &&
							role === "auditor" &&
							index === 0 &&
							content.some(
								(part) => part.type === "text" && part.text === question,
							)
						) {
							atRead.resolve();
							await waitForAbort(settings!.signal!);
						}
					}),
			});
			const policy =
				"Retention period: undecided. Queue jobs are stored locally.\n";
			const queue = "Queue retention: 96 hours.\n";
			await writeFiles(j.cwd, { "policy.txt": policy, "queue.txt": queue });
			const f = await j.connect();
			const { sessionId } = await f.session();
			const pin = await f.state(sessionId);
			const pending = f.prompt(sessionId, `${goal}\n${scope}`);
			if (pause === "cancelled") {
				try {
					await Promise.race([
						atRead.promise,
						pending.then(() => {
							throw new Error(
								"Turn ended before the auditor's settled-read cancellation boundary",
							);
						}),
					]);
					expect(
						result(j.requests.at(-1)!.context, "policy-read"),
					).toMatchObject({ isError: false });
					await f.cancel(sessionId);
					await expectStop(pending, "cancelled");
				} finally {
					await f.cancel(sessionId);
					await pending;
				}
			} else {
				await expectStop(pending);
			}
			const checkpoint = await f.checkpoint(sessionId);
			const waiting = parseState(checkpoint).inner!;
			expect(waiting).toMatchObject({
				orchestrated: true,
				standaloneRole: "auditor",
				phase: "routing",
				workflow: pin.resources.workflow,
				engine: {
					command: "standalone",
					status: pause === "needs_human" ? "waiting" : "interrupted",
					mode: null,
					pause:
						pause === "needs_human"
							? { kind: "report", message: question }
							: { kind: "interrupted" },
				},
			});
			expect(waiting.engine!.workflow).toEqual({
				commands: {
					standalone: {
						description: "Run auditor independently",
						chain: [{ kind: "agent", name: "auditor" }],
					},
				},
				vault: pin.resources.workflow.vault,
			});
			expect(waiting.engine!.records).toEqual([
				expect.objectContaining({
					kind: "agent",
					role: "auditor",
					loops: [],
					status: pause === "needs_human" ? "waiting" : "interrupted",
					...(pause === "needs_human"
						? { outcome: { status: "needs_human", summary: question } }
						: {}),
				}),
			]);
			const [worker] = waiting.engine!.records;
			expect(waiting.continuations?.map(({ recordId }) => recordId)).toEqual([
				worker.id,
			]);
			if (pause === "needs_human") {
				expect(
					resultText(j.requests.at(-1)!.context, "audit-question"),
				).toContain(
					"## Role: auditor\nStatus: waiting\nMode: standalone\nThis is an independent role task, not completion or approval of a phase.",
				);
				expect(agentText(f.updates)).toContain(question);
			} else {
				expect(worker).not.toHaveProperty("outcome");
				expect(JSON.stringify(waiting.continuations)).toContain("policy-read");
			}
			expect(agentText(f.updates)).not.toContain("72");
			expect(j.reads.map(({ path }) => path)).toEqual([
				resolve(j.cwd, "policy.txt"),
			]);
			expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
				"auditor",
			]);
			const beforeReload = {
				requests: j.requests.length,
				permissions: j.permissions.length,
				runtimes: j.runtimes.length,
			};
			await expect(
				f.configure(sessionId, "phase", "develop"),
			).rejects.toBeInstanceOf(RequestError);
			await expect(f.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			await f.closeSession(sessionId);
			await f.close();
			const resumed = await j.connect();
			await resumed.load(sessionId);
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			await expect(
				resumed.configure(sessionId, "phase", "delegate"),
			).rejects.toBeInstanceOf(RequestError);
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(j.requests).toHaveLength(beforeReload.requests);
			expect(j.permissions).toHaveLength(beforeReload.permissions);
			expect(j.runtimes).toHaveLength(beforeReload.runtimes);
			expect(j.reads.map(({ path }) => path)).toEqual([
				resolve(j.cwd, "policy.txt"),
			]);
			if (pause === "needs_human") {
				expect(agentText(resumed.updates)).toContain(question);
			}
			const start = resumed.updates.length;
			await expectStop(resumed.prompt(sessionId, answer));
			const recovery = j.requests.slice(beforeReload.requests);
			expect(new Set(recovery.map(({ role }) => role))).toEqual(
				new Set(["router", "auditor"]),
			);
			const auditor = roleRequests(recovery, "auditor")[0].context;
			for (const fact of [
				goal,
				scope,
				...(pause === "needs_human" ? [question] : []),
				answer,
				"Execute only auditor as a standalone role",
			]) {
				expect(JSON.stringify(auditor.messages)).toContain(fact);
			}
			expect(result(auditor, "policy-read")).toMatchObject({ isError: false });
			expect(resultText(auditor, "policy-read")).toContain(policy.trim());
			if (pause === "needs_human") {
				expect(result(auditor, "missing-limit")).toMatchObject({
					isError: false,
				});
			} else {
				expect(result(auditor, "missing-limit")).toBeUndefined();
			}
			const reported = lastRequest(recovery, "auditor").context;
			expect(result(reported, "queue-read")).toMatchObject({ isError: false });
			expect(resultText(reported, "queue-read")).toContain(queue.trim());
			expect(result(reported, "d3r_report")).toMatchObject({ isError: false });
			expect(j.reads.map(({ path }) => path)).toEqual([
				resolve(j.cwd, "policy.txt"),
				resolve(j.cwd, "queue.txt"),
			]);
			const completed = await resumed.state(sessionId);
			expect(completed.resources).toEqual(pin.resources);
			expect(completed.inner).toMatchObject({
				standaloneRole: "auditor",
				phase: "routing",
				workflow: pin.resources.workflow,
				engine: {
					command: "standalone",
					workflow: waiting.engine!.workflow,
					status: "completed",
					pause: null,
				},
			});
			expect(completed.inner!.engine!.records).toEqual([
				{
					...worker,
					status: "completed",
					outcome: { status: "completed", summary: finding },
				},
			]);
			expect(completed.inner!.continuations ?? []).toEqual([]);
			expect(completed.inner).not.toHaveProperty("summary");
			expect(result(recovery.at(-1)!.context, "resume-audit")).toMatchObject({
				isError: false,
			});
			expect(resultText(recovery.at(-1)!.context, "resume-audit")).toContain(
				"## Role: auditor\nStatus: completed\nMode: standalone",
			);
			expect(agentText(resumed.updates.slice(start))).toContain(finding);
			expect(agentText(resumed.updates.slice(start))).not.toMatch(
				/Worker-only|"status"|## Phase:|Workflow complete/,
			);
			expect(
				resumed.updates
					.slice(start)
					.filter(
						({ update }) => update.sessionUpdate === "agent_message_chunk",
					),
			).toHaveLength(1);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
				expect.stringMatching(/^Trust workspace/),
			]);
			expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
				"auditor",
				"routing",
				"auditor",
			]);
			for (const { context } of roleRequests(j.requests, "auditor")) {
				expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
					JOURNEY_INSPECTION_TOOLS,
				);
			}
			expect(await readdir(j.cwd)).toEqual([
				"AGENTS.md",
				"policy.txt",
				"queue.txt",
			]);
			expect(await readFile(resolve(j.cwd, "policy.txt"), "utf8")).toBe(policy);
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(queue);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
		},
	);
});
