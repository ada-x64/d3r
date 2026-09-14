import {
	expectStop,
	expectTextOnce,
	type JourneyScripts,
	journeyReport as reportCall,
	JOURNEY_MODEL,
	JOURNEY_SUMMARY,
	journeyCall as call,
	journeyDone as done,
	journeyResult as result,
	journeyResultText as resultText,
	journeyPhaseReply as phaseReply,
	journeyText as agentText,
	journeyCheckpoint as parseState,
	reply,
	roleRequests,
	lastRequest,
} from "./helpers.ts";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeModelKey } from "../../../../cli/src/native-models.ts";

import { nativeJourneySuite } from "./harness.ts";

describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();

	// oxlint-disable-next-line max-statements -- Conversation, actual effects, and subsequent discussion form one acceptance journey.
	it("orchestrates conversation directly into develop, then discusses the actual reviewed results", async () => {
		const goal =
			"Add an offline enqueue helper that preserves insertion order.";
		const scope =
			"Only queue.mjs; no dependencies, network, commits, or deployment.";
		const criterion =
			"Appending a job returns both jobs in their original order without mutating the input.";
		const source = "export const enqueue = (jobs, job) => [...jobs, job];\n";
		const reports = {
			implementor:
				"Created queue.mjs; the Node assertion passed for insertion order and unchanged input.",
			reviewer:
				"Approved the helper after reading queue.mjs; scope is limited to the requested file.",
			auditor:
				"Audited the offline helper and test evidence; no dependencies or deployment were added.",
		};
		const scripts: JourneyScripts = {
			router: [
				reply(
					"I can implement that directly. What is the scope, acceptance criterion, and develop mode?",
				),
				call(
					"d3r_start_phase",
					{
						phase: "develop",
						brief: {
							goal,
							context: scope,
							acceptanceCriteria: [criterion],
							constraints: ["Do not commit or deploy."],
						},
					},
					"choose-mode",
				),
				phaseReply("choose-mode", "Choose develop mode"),
				call("d3r_continue_phase", { instructions: "auto" }, "develop"),
				phaseReply("develop", "Offline helper ready"),
				(context) =>
					reply(
						`## Next decision\n\n${resultText(context, "develop").includes(reports.auditor) ? "The reviewed helper is complete. Deployment remains unapproved; no further work was started." : "Missing previous audit evidence."}`,
					),
			],
			implementor: [
				call("write_file", { path: "queue.mjs", content: source }),
				call("run_command", {
					command: process.execPath,
					args: [
						"--input-type=module",
						"-e",
						"import assert from 'node:assert/strict'; import { enqueue } from './queue.mjs'; const jobs = ['first']; assert.deepEqual(enqueue(jobs, 'second'), ['first', 'second']); assert.deepEqual(jobs, ['first']); console.log('queue assertions passed');",
					],
				}),
				reportCall(reports.implementor, { allDone: true }),
				reply("Worker implementation response"),
			],
			reviewer: [
				call("read_file", { path: "queue.mjs" }),
				...done(
					reports.reviewer,
					{ review: "approved" },
					"Worker review response",
				),
			],
			auditor: [
				call("read_file", { path: "queue.mjs" }),
				...done(reports.auditor),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(f.prompt(sessionId, goal));
		expect(j.requests.map(({ role }) => role)).toEqual(["router"]);
		expect(parseState(await f.checkpoint(sessionId)).inner).toMatchObject({
			orchestrated: true,
			engine: null,
		});
		await expectStop(
			f.prompt(sessionId, `${scope}\n${criterion}\nImplement directly.`),
		);
		expect(
			parseState(await f.checkpoint(sessionId)).inner!.engine,
		).toMatchObject({
			command: "develop",
			mode: null,
			status: "waiting",
			pause: { kind: "mode" },
		});
		expect(j.requests.every(({ role }) => role === "router")).toBe(true);
		expect(await readdir(j.cwd)).toEqual(["AGENTS.md"]);
		expect(agentText(f.updates)).toContain("Choose develop mode");
		const start = f.updates.length;
		await expectStop(f.prompt(sessionId, "auto"));
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(source);
		const files = await readdir(j.cwd);
		expect(files.toSorted()).toEqual(["AGENTS.md", "queue.mjs"]);
		const workers = j.requests.filter(({ role }) => role !== "router");
		expect(new Set(workers.map(({ role }) => role))).toEqual(
			new Set(Object.keys(reports)),
		);
		for (const role of Object.keys(reports)) {
			const [{ context }] = roleRequests(workers, role);
			for (const fact of [goal, scope, criterion, "Do not commit or deploy."]) {
				expect(JSON.stringify(context.messages)).toContain(fact);
			}
			expect(context.systemPrompt).toMatch(
				/\bno prior phase or formal vault documents are required\b/i,
			);
			expect(context.tools?.map(({ name }) => name)).not.toContain(
				"d3r_start_phase",
			);
		}
		const implemented = lastRequest(workers, "implementor").context;
		expect(result(implemented, "run_command")).toMatchObject({
			isError: false,
		});
		expect(resultText(implemented, "run_command")).toContain(
			"queue assertions passed",
		);
		const final = lastRequest(j.requests, "router").context;
		expect(result(final, "develop")).toMatchObject({ isError: false });
		expect(resultText(final, "develop")).toContain(
			"## Phase: develop\nStatus: completed\nMode: auto",
		);
		for (const report of Object.values(reports)) {
			expectTextOnce(agentText(f.updates.slice(start)), report);
		}
		expect(agentText(f.updates.slice(start))).toMatch(
			/^## Offline helper ready/,
		);
		expect(agentText(f.updates.slice(start))).not.toMatch(
			/Worker .* response|"status"/,
		);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"implementor",
			"reviewer",
			"auditor",
		]);
		expect(roleRequests(j.requests, "summary")).toEqual([]);
		const completed = parseState(await f.checkpoint(sessionId)).inner!;
		expect(completed.engine).toMatchObject({ status: "completed" });
		expect(completed).not.toHaveProperty("summary");
		const beforeDiscussion = j.requests.length;
		const permissions = j.permissions.length;
		await expectStop(
			f.prompt(
				sessionId,
				"What did review find, and can we discuss deployment without starting it?",
			),
		);
		expect(j.requests.slice(beforeDiscussion).map(({ role }) => role)).toEqual([
			"router",
		]);
		expect(j.permissions).toHaveLength(permissions);
		expect(agentText(f.updates)).toContain(
			"Deployment remains unapproved; no further work was started.",
		);
		for (const report of Object.values(reports)) {
			expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
				report,
			);
		}
		for (const { context } of roleRequests(j.requests, "router")) {
			expect(context.systemPrompt).toMatch(
				/^You are D3R's native workflow orchestrator in Zed\./,
			);
			expect(context.tools?.map(({ name }) => name)).toEqual(
				expect.arrayContaining([
					"d3r_start_phase",
					"d3r_continue_phase",
					"d3r_abandon_phase",
					"d3r_phase_status",
				]),
			);
		}
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- The checkpoint and user-directed phase switch must share a persistent conversation.
	it("orchestrates /design discussion without auto-answering, then abandons it for direct develop", async () => {
		const brief = {
			goal: "Create a local queue marker.",
			context: "No network or formal design artifacts are needed.",
			acceptanceCriteria: ["queue.txt contains offline only."],
		};
		const scripts: JourneyScripts = {
			router: [
				call("d3r_start_phase", { phase: "design", brief }, "design"),
				call(
					"d3r_continue_phase",
					{ instructions: "Invent an answer and draft now." },
					"auto-answer",
				),
				phaseReply("design", "Design questions"),
				call("d3r_phase_status", {}, "discussion"),
				phaseReply("discussion", "Still discussing; no answer submitted"),
				call(
					"d3r_abandon_phase",
					{
						reason:
							"The user explicitly skipped design and requested direct implementation.",
					},
					"skip",
				),
				call("d3r_phase_status", {}, "after-abandon"),
				call(
					"d3r_start_phase",
					{ phase: "develop", brief, mode: "auto" },
					"direct",
				),
				phaseReply("direct", "Direct implementation reviewed"),
			],
			aggregator: done("The workspace needs only a local marker."),
			researcher: done(
				"No network research is necessary; confirm the design scope with the user.",
			),
			implementor: [
				call("write_file", { path: "queue.txt", content: "offline\n" }),
				reportCall("Created the requested offline marker.", { allDone: true }),
				reply("Marker created."),
			],
			reviewer: [
				call("read_file", { path: "queue.txt" }),
				...done(
					"Approved the exact offline marker contents.",
					{ review: "approved" },
					"Review complete.",
				),
			],
			auditor: done(
				"Audited the marker; no design artifact or network operation was created.",
			),
		};
		const j = await open(scripts, { routerShortcuts: false });
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(
			f.prompt(sessionId, "/design Create a local queue marker"),
		);
		const waiting = parseState(await f.checkpoint(sessionId)).inner!;
		expect(waiting).toMatchObject({
			orchestrated: true,
			engine: {
				command: "design",
				status: "waiting",
				pause: { kind: "human" },
			},
		});
		const firstFinal = j.requests.at(-1)!.context;
		expect(result(firstFinal, "auto-answer")).toMatchObject({ isError: true });
		expect(resultText(firstFinal, "auto-answer")).toContain(
			"already ran in this turn",
		);
		expect(resultText(firstFinal, "design")).toContain(
			"Discuss design questions before drafting",
		);
		expect(agentText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(roleRequests(j.requests, "designer")).toEqual([]);
		const beforeDiscussion = j.requests.length;
		await expectStop(
			f.prompt(
				sessionId,
				"Why would we need a design document? Let's discuss; do not draft yet.",
			),
		);
		expect(
			j.requests.slice(beforeDiscussion).every(({ role }) => role === "router"),
		).toBe(true);
		expect(parseState(await f.checkpoint(sessionId)).inner!.engine).toEqual(
			waiting.engine,
		);
		expect(agentText(f.updates)).toContain(
			"Still discussing; no answer submitted",
		);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		const start = f.updates.length;
		await expectStop(
			f.prompt(
				sessionId,
				"Skip and abandon design. Develop the marker directly in auto mode.",
			),
		);
		expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(
			"offline\n",
		);
		expect(await readdir(j.cwd)).not.toContain("design.md");
		const final = j.requests.at(-1)!.context;
		expect(result(final, "skip")).toMatchObject({ isError: false });
		expect(resultText(final, "skip")).toContain("Existing effects remain");
		expect(waiting.topic).toMatch(/^create-a-local-queue-marker-[a-z0-9]+$/);
		expect(result(final, "after-abandon")).toMatchObject({ isError: false });
		for (const [id, text] of [
			["after-abandon", `Topic name: ${waiting.topic}`],
			[
				"after-abandon",
				"Most recent topic; reuse only for follow-on work on the same subject:",
			],
			["direct", "## Phase: develop\nStatus: completed\nMode: auto"],
		]) {
			expect(resultText(final, id), id).toContain(text);
		}
		expectTextOnce(
			agentText(f.updates.slice(start)),
			"Approved the exact offline marker contents.",
		);
		expect(agentText(f.updates.slice(start))).not.toMatch(
			/Marker created\.|Review complete\./,
		);
		expect(
			j.requests.some(({ role }) => role === "designer" || role === "summary"),
		).toBe(false);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"aggregator",
			"researcher",
			"implementor",
			"reviewer",
			"auditor",
		]);
		const completed = parseState(await f.checkpoint(sessionId)).inner!;
		expect(completed.engine).toMatchObject({
			command: "develop",
			status: "completed",
		});
		expect(completed.topic).toMatch(/^create-a-local-queue-marker-[a-z0-9]+$/);
		expect(completed.topic).not.toBe(waiting.topic);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Clarification, reload, sibling preservation, and completion prove one real needs_human handoff.
	it("clarifies a missing fact through needs_human and resumes only the waiting worker's retained conversation", async () => {
		const question =
			"How many hours should an offline job be retained before expiration?";
		const answer =
			"Retain each offline job for 72 hours; continue research using that limit.";
		const siblingSummary =
			"The queue runs locally; no network service is required.";
		const researchSummary =
			"The user chose a 72-hour retention limit; expiration can remain local.";
		const design =
			"# Queue expiration\n\nRetain offline jobs for 72 hours, then expire them locally.\n";
		const scripts: JourneyScripts = {
			router: [
				call(
					"d3r_start_phase",
					{
						phase: "design",
						brief: {
							goal: "Design expiration for offline jobs.",
							context:
								"The retention period is undecided; policy.txt contains the known facts.",
							acceptanceCriteria: [
								"Expiration uses the retention period chosen by the user, not an invented default.",
							],
						},
					},
					"clarify",
				),
				phaseReply("clarify", "Retention decision needed"),
				call("d3r_continue_phase", { instructions: answer }, "answer"),
				phaseReply("answer", "Research clarified; confirm before drafting"),
				call(
					"d3r_continue_phase",
					{
						instructions:
							"Draft the local expiration design using the agreed retention limit.",
					},
					"draft-design",
				),
				phaseReply("draft-design", "Expiration design ready"),
			],
			aggregator: done(siblingSummary),
			researcher: [
				call("read_file", { path: "policy.txt" }, "retention-read"),
				call(
					"d3r_report",
					{ status: "needs_human", summary: question },
					"missing-retention",
				),
				reply("Waiting for the user's retention decision."),
				call(
					"d3r_report",
					{ status: "completed", summary: researchSummary },
					"clarified-retention",
				),
				reply("Research now has the missing fact."),
			],
			designer: [
				call("write_file", { path: "expiration.md", content: design }),
				...done(
					"Saved expiration.md with the agreed 72-hour local retention policy.",
				),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		await writeFile(
			resolve(j.cwd, "policy.txt"),
			"Offline jobs expire locally. Retention period: undecided.\n",
		);
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(
			f.prompt(
				sessionId,
				"Design local expiration; ask me for the missing retention period.",
			),
		);
		const checkpoint = await f.checkpoint(sessionId);
		const waiting = parseState(checkpoint).inner!;
		expect(waiting).toMatchObject({
			orchestrated: true,
			engine: {
				status: "waiting",
				pause: { kind: "report", message: question },
			},
		});
		const sibling = waiting.engine!.records.find(
			({ role }) => role === "aggregator",
		)!;
		const waitingWorker = waiting.engine!.records.find(
			({ role }) => role === "researcher",
		)!;
		expect(sibling).toMatchObject({
			status: "completed",
			outcome: { summary: siblingSummary },
		});
		const siblingRequests = roleRequests(j.requests, "aggregator");
		expect(waitingWorker).toMatchObject({
			status: "waiting",
			outcome: { status: "needs_human", summary: question },
		});
		expect(waiting.continuations?.map(({ recordId }) => recordId)).toEqual([
			waitingWorker.id,
		]);
		const initial = roleRequests(j.requests, "researcher")[0].context;
		expect(JSON.stringify(initial.messages)).toContain(
			"retention period is undecided",
		);
		expect(JSON.stringify(initial.messages)).not.toContain("72 hours");
		const reported = lastRequest(j.requests, "researcher").context;
		expect(result(reported, "missing-retention")).toMatchObject({
			isError: false,
		});
		expect(resultText(reported, "retention-read")).toContain(
			"Retention period: undecided",
		);
		expect(agentText(f.updates)).toContain(question);
		expectTextOnce(agentText(f.updates), "## Retention decision needed");
		expect(agentText(f.updates)).not.toContain(
			"Waiting for the user's retention decision.",
		);
		expect(roleRequests(j.requests, "designer")).toEqual([]);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		const beforeReload = {
			requests: j.requests.length,
			permissions: j.permissions.length,
			runtimes: j.runtimes.length,
		};
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload.requests);
		expect(j.permissions).toHaveLength(beforeReload.permissions);
		expect(j.runtimes).toHaveLength(beforeReload.runtimes);
		expect(agentText(resumed.updates)).toContain(question);
		await expectStop(resumed.prompt(sessionId, answer));
		const clarification = j.requests.slice(beforeReload.requests);
		expect(new Set(clarification.map(({ role }) => role))).toEqual(
			new Set(["router", "researcher"]),
		);
		const resumedWorker = roleRequests(clarification, "researcher")[0].context;
		expect(JSON.stringify(resumedWorker.messages)).toContain(answer);
		for (const id of ["missing-retention", "retention-read"]) {
			expect(result(resumedWorker, id), id).toMatchObject({ isError: false });
		}
		expect(
			result(
				lastRequest(clarification, "researcher").context,
				"clarified-retention",
			),
		).toMatchObject({ isError: false });
		const clarified = parseState(await resumed.checkpoint(sessionId)).inner!;
		expect(clarified.engine).toMatchObject({
			status: "waiting",
			pause: { kind: "human" },
		});
		expect(clarified.engine!.records).toContainEqual(sibling);
		expect(
			clarified.engine!.records.find(({ id }) => id === waitingWorker.id),
		).toMatchObject({
			status: "completed",
			outcome: { status: "completed", summary: researchSummary },
		});
		expect(clarified.continuations ?? []).toEqual([]);
		expect(agentText(resumed.updates)).toContain(researchSummary);
		await expect(
			readFile(resolve(j.cwd, "expiration.md")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expectStop(
			resumed.prompt(
				sessionId,
				"Draft the local expiration design using the agreed retention limit.",
			),
		);
		expect(await readFile(resolve(j.cwd, "expiration.md"), "utf8")).toBe(
			design,
		);
		const designer = roleRequests(j.requests, "designer")[0].context;
		for (const fact of [answer, siblingSummary, researchSummary]) {
			expect(JSON.stringify(designer.messages)).toContain(fact);
		}
		const completed = parseState(await resumed.checkpoint(sessionId)).inner!;
		expect(completed.engine).toMatchObject({ status: "completed" });
		expect(completed.engine!.records).toContainEqual(sibling);
		expect(roleRequests(j.requests, "aggregator")).toEqual(siblingRequests);
		expect(agentText(resumed.updates)).toContain(
			"Saved expiration.md with the agreed 72-hour local retention policy.",
		);
		expect(roleRequests(j.requests, "summary")).toEqual([]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Keep the human checkpoint, reconnect, and final effect in one journey.
	it("finishes /design after parallel recon, a persisted human checkpoint and fresh workspace trust", async () => {
		const recon = (summary: string) => [
			call("read_file", { path: "brief.txt" }),
			...done(summary),
		];
		const design = "Use a local queue; retain pending jobs across restarts.\n";
		const scripts: JourneyScripts = {
			router: [
				reply("I am D3R. I coordinate design, implementation, and review."),
			],
			aggregator: recon("Existing jobs must survive restarts."),
			researcher: recon("A local queue meets the offline requirement."),
			designer: [
				call("write_file", { path: "design.md", content: design }),
				reportCall("Designed the durable local queue."),
				reply("The design is ready in design.md."),
			],
		};
		const j = await open(scripts);
		await writeFile(
			resolve(j.cwd, "brief.txt"),
			"Jobs must survive restarts without a network service.",
		);
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		const request = "/design Plan an offline job queue using brief.txt";
		const greeting = "Hi! tell me about yourself.";
		await expectStop(f.prompt(sessionId, greeting));
		// The baseline protects the setup UX, not IDs, envelopes or streaming chunk boundaries.
		expect(agentText(f.updates)).toMatchInlineSnapshot(
			`"Select a model in Zed's Model picker before sending a prompt, or choose an explicit CLI preset configured in .agents/models.json. No model request or MCP connection was made."`,
		);
		expect(j.requests).toEqual([]);
		expect(j.permissions).toEqual([]);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		j.approval.decide = async () => false;
		const deniedStart = f.updates.length;
		await expectStop(f.prompt(sessionId, greeting));
		expect(agentText(f.updates.slice(deniedStart))).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toEqual([]);
		j.approval.decide = async () => true;
		const greetingStart = f.updates.length;
		await expectStop(f.prompt(sessionId, greeting));
		expect(agentText(f.updates.slice(greetingStart))).toContain("I am D3R");
		expect(JSON.stringify(j.requests[0].context.messages)).toContain(greeting);
		const reconStart = j.requests.length;
		await expectStop(f.prompt(sessionId, request));
		expect(agentText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(
			new Set(j.requests.slice(reconStart).map(({ role }) => role)),
		).toEqual(new Set(["router", "aggregator", "researcher"]));
		for (const role of ["aggregator", "researcher"]) {
			const contexts = roleRequests(j.requests, role).map(
				({ context }) => context,
			);
			expect(contexts[0].systemPrompt).toContain(
				"Preserve the offline user's requirements.",
			);
			expect(JSON.stringify(contexts[0].messages)).toContain(request);
			expect(contexts[1].messages.at(-1)).toMatchObject({
				role: "toolResult",
				toolName: "read_file",
				isError: false,
			});
			expect(JSON.stringify(contexts[1].messages.at(-1))).toContain(
				"Jobs must survive restarts without a network service.",
			);
		}
		await expect(readFile(resolve(j.cwd, "design.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const beforeReload = j.requests.length;
		const permissionsBefore = j.permissions.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		expect(agentText(resumed.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.permissions).toHaveLength(permissionsBefore);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		const answer = "Use a local queue and retain pending jobs across restarts.";
		j.approval.decide = async () => false;
		const untrustedStart = resumed.updates.length;
		await expectStop(resumed.prompt(sessionId, answer));
		expect(agentText(resumed.updates.slice(untrustedStart))).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toHaveLength(beforeReload);
		await expect(readFile(resolve(j.cwd, "design.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		j.approval.decide = async () => true;
		const conflictStart = resumed.updates.length;
		const replacement = "/design Replace the queue with a lunar calendar";
		await expectStop(resumed.prompt(sessionId, replacement));
		expect(agentText(resumed.updates.slice(conflictStart))).toContain(
			"Cannot replace unfinished work",
		);
		expect(agentText(resumed.updates.slice(conflictStart))).toMatch(
			/Phase: design[\s\S]*Status: waiting/,
		);
		const retained = parseState(await resumed.checkpoint(sessionId)).inner!;
		expect(retained.engine).toEqual(parseState(checkpoint).inner!.engine);
		expect(retained.input).toEqual(parseState(checkpoint).inner!.input);
		expect(j.requests.slice(beforeReload).map(({ role }) => role)).toEqual([
			"router",
			"router",
		]);
		await expectStop(resumed.prompt(sessionId, answer));
		expect(await readFile(resolve(j.cwd, "design.md"), "utf8")).toBe(design);
		expect(agentText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		const continuation = j.requests.slice(beforeReload);
		expect(new Set(continuation.map(({ role }) => role))).toEqual(
			new Set(["router", "designer"]),
		);
		expect(roleRequests(j.requests, "summary")).toEqual([]);
		const [{ context }] = roleRequests(continuation, "designer");
		expect(JSON.stringify(context.messages)).not.toContain(replacement);
		expect(
			JSON.stringify(
				parseState(await resumed.checkpoint(sessionId)).inner!.input,
			),
		).not.toContain(replacement);
		for (const text of [
			greeting,
			request,
			answer,
			"Existing jobs must survive restarts.",
			"A local queue meets the offline requirement.",
		]) {
			expect(JSON.stringify(context.messages)).toContain(text);
		}
		expect(
			context.tools?.find(({ name }) => name === "write_file")?.parameters,
		).toMatchObject({
			type: "object",
			required: expect.arrayContaining(["path", "content"]),
			properties: { path: { type: "string" }, content: { type: "string" } },
		});
		expect(context.tools?.map(({ name }) => name)).not.toContain("run_command");
		expect(
			j.permissions
				.slice(permissionsBefore)
				.map(({ toolCall }) => toolCall.title),
		).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^Trust workspace/),
				"write_file",
			]),
		);
		expect(resumed.updates.map(({ update }) => update)).toContainEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call_update",
				status: "completed",
				content: expect.arrayContaining([
					{
						type: "diff",
						path: resolve(j.cwd, "design.md"),
						oldText: null,
						newText: design,
					},
				]),
			}),
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.closeSession(sessionId);
	});
});
