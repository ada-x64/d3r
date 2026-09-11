import {
	expectStop,
	type JourneyScripts,
	journeyReport as reportCall,
	JOURNEY_SUMMARY,
	journeyCall as call,
	journeyDone as done,
	journeyResult as result,
	journeyResultText as resultText,
	journeyPhaseReply as phaseReply,
	journeyText as agentText,
	journeyStream as stream,
	journeyToolGate as toolGate,
	journeyToolText as toolText,
	journeyTools as toolUpdates,
	journeyCheckpoint as parseState,
	reply,
	roleRequests,
	lastRequest,
} from "./helpers.ts";

import { type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deferred, waitForAbort } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";

describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();

	it.each(["fresh report", "missing report"] as const)(
		"settles cancellation after a successful report before delivering a queued correction with %s",
		// oxlint-disable-next-line max-statements -- The two outcomes share the contested post-report cancellation boundary and real write evidence.
		async (reporting) => {
			const original = "Approved queue configuration.\n";
			const external =
				"User annotation added after cancellation; do not overwrite.\n";
			const corrected = "Keep jobs local; deployment remains unapproved.\n";
			const correction =
				"Continue the interrupted implementation. Preserve my queue.txt annotation, inspect it, and write the local-only correction to correction.txt.";
			const oldSummary =
				"Initial queue configuration was written before the correction.";
			const freshSummary =
				"Preserved the user annotation and wrote correction.txt for local-only jobs.";
			const terminalText =
				"Report accepted; terminal model stop is still pending.";
			const atStop = deferred<void>();
			const abortObserved = deferred<void>();
			const settle = deferred<void>();
			const order: string[] = [];
			const checkpoints: unknown[] = [];
			const scripts: JourneyScripts = {
				router: [
					call(
						"d3r_start_phase",
						{
							phase: "develop",
							mode: "auto",
							brief: {
								goal: "Configure an offline queue.",
								context: "Write queue.txt without deploying or committing.",
								acceptanceCriteria: ["The queue configuration remains local."],
							},
						},
						"initial-develop",
					),
					call(
						"d3r_continue_phase",
						{ instructions: correction },
						"correct-reported-work",
					),
					phaseReply(
						"correct-reported-work",
						reporting === "fresh report"
							? "Correction reviewed"
							: "Correction needs a fresh report",
					),
				],
				implementor: [
					call(
						"write_file",
						{ path: "queue.txt", content: original },
						"approved-queue",
					),
					call(
						"d3r_report",
						{ status: "completed", summary: oldSummary, allDone: true },
						"pre-cancel-report",
					),
					reply(terminalText),
					call("read_file", { path: "queue.txt" }, "current-queue"),
					call(
						"write_file",
						{ path: "correction.txt", content: corrected },
						"corrected-queue",
					),
					...(reporting === "fresh report"
						? [
								call(
									"d3r_report",
									{ status: "completed", summary: freshSummary, allDone: true },
									"fresh-report",
								),
							]
						: []),
					reply("The correction file is ready."),
				],
				...(reporting === "fresh report"
					? {
							reviewer: [
								call("read_file", { path: "correction.txt" }),
								...done(
									"Approved the corrected local-only queue configuration.",
									{ review: "approved" },
									"Corrected implementation reviewed.",
								),
							],
							auditor: [
								call("read_file", { path: "queue.txt" }),
								...done(
									"Audited the correction and preserved user annotation.",
								),
							],
						}
					: {}),
			};
			const j = await open(scripts, {
				routerShortcuts: false,
				streamResponse: (role, content, settings) =>
					stream(content, async (index) => {
						const terminalEventIndex = 2;
						if (
							role !== "implementor" ||
							index !== terminalEventIndex ||
							!content.some(
								(part) => part.type === "text" && part.text === terminalText,
							)
						) {
							return;
						}
						atStop.resolve();
						try {
							await waitForAbort(settings!.signal!);
						} catch (error) {
							order.push("abort observed");
							abortObserved.resolve();
							await settle.promise;
							throw error;
						}
					}),
			});
			const f = await j.connect();
			const { sessionId } = await f.session();
			const pending = f.prompt(
				sessionId,
				"Configure the offline queue in auto mode; do not deploy or commit.",
			);
			await Promise.race([
				atStop.promise,
				pending.then(() => {
					throw new Error(
						"Turn ended before the post-report cancellation boundary",
					);
				}),
			]);
			const beforeCorrection = j.requests.length;
			// Model the client's queued message: it must not become an ACP prompt until the cancelled turn acknowledges settlement.
			const queued = pending.then(async () => {
				order.push("cancel settled");
				checkpoints.push(await f.checkpoint(sessionId));
				await writeFile(resolve(j.cwd, "queue.txt"), external);
				order.push("correction sent");
				return f.prompt(sessionId, correction);
			});
			try {
				const reported = lastRequest(j.requests, "implementor").context;
				for (const id of ["approved-queue", "pre-cancel-report"]) {
					expect(result(reported, id), id).toMatchObject({ isError: false });
				}
				expect(resultText(reported, "pre-cancel-report")).toMatch(
					/report recorded/i,
				);
				expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(
					original,
				);
				expect(
					j.requests.some(
						({ role }) => role === "reviewer" || role === "auditor",
					),
				).toBe(false);
				await f.cancel(sessionId);
				await abortObserved.promise;
				await f.peer.agent.request("session/list", {});
				expect(order).toEqual(["abort observed"]);
				expect(j.requests).toHaveLength(beforeCorrection);
				expect(agentText(f.updates)).toBe("");
				settle.resolve();
				await expectStop(pending, "cancelled");
				await expectStop(queued);
			} finally {
				settle.resolve();
				await f.cancel(sessionId);
				await Promise.allSettled([pending, queued]);
			}
			expect(order).toEqual([
				"abort observed",
				"cancel settled",
				"correction sent",
			]);
			const interrupted = parseState(checkpoints[0]).inner!;
			expect(interrupted).toMatchObject({
				orchestrated: true,
				engine: { status: "interrupted" },
			});
			const interruptedWorker = interrupted.engine!.records.find(
				({ role }) => role === "implementor",
			)!;
			expect(interruptedWorker).toMatchObject({ status: "interrupted" });
			expect(interruptedWorker.outcome).toBeUndefined();
			expect(
				interrupted.continuations?.map(({ recordId }) => recordId),
			).toEqual([interruptedWorker.id]);
			const recovery = j.requests.slice(beforeCorrection);
			const resumedWorker = roleRequests(recovery, "implementor")[0].context;
			expect(JSON.stringify(resumedWorker.messages)).toContain(correction);
			for (const id of ["approved-queue", "pre-cancel-report"]) {
				expect(result(resumedWorker, id), id).toMatchObject({ isError: false });
			}
			const finishedWorker = lastRequest(recovery, "implementor").context;
			expect(resultText(finishedWorker, "current-queue")).toContain(
				external.trim(),
			);
			expect(result(finishedWorker, "corrected-queue")).toMatchObject({
				isError: false,
			});
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(
				external,
			);
			expect(await readFile(resolve(j.cwd, "correction.txt"), "utf8")).toBe(
				corrected,
			);
			const final = parseState(await f.checkpoint(sessionId)).inner!;
			const worker = final.engine!.records.find(
				({ id }) => id === interruptedWorker.id,
			)!;
			if (reporting === "fresh report") {
				expect(result(finishedWorker, "fresh-report")).toMatchObject({
					isError: false,
				});
				expect(worker).toMatchObject({
					status: "completed",
					outcome: { summary: freshSummary },
				});
				expect(final.engine).toMatchObject({ status: "completed" });
				expect(new Set(recovery.map(({ role }) => role))).toEqual(
					new Set(["router", "implementor", "reviewer", "auditor"]),
				);
				expect(agentText(f.updates)).toContain(
					"Approved the corrected local-only queue configuration.",
				);
			} else {
				expect(result(finishedWorker, "fresh-report")).toBeUndefined();
				expect(worker.status).toBe("blocked");
				expect(worker.outcome).toBeUndefined();
				expect(final.engine).toMatchObject({
					status: "blocked",
					pause: { kind: "failure" },
				});
				expect(agentText(f.updates)).toMatch(/missing or invalid d3r_report/i);
				expect(
					j.requests.some(
						({ role }) => role === "reviewer" || role === "auditor",
					),
				).toBe(false);
			}
			const phaseResult = resultText(
				lastRequest(j.requests, "router").context,
				"correct-reported-work",
			);
			expect(phaseResult).toContain(
				`Status: ${reporting === "fresh report" ? "completed" : "blocked"}`,
			);
			expect(phaseResult).not.toContain(oldSummary);
			expect(final.continuations ?? []).toEqual([]);
			expect(final).not.toHaveProperty("summary");
			expect(roleRequests(j.requests, "summary")).toEqual([]);
			expect(
				f.updates.filter(
					({ update }) => update.sessionUpdate === "agent_message_chunk",
				),
			).toHaveLength(1);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			const writes = toolUpdates(f.updates).flatMap((row) =>
				row.status === "completed"
					? (row.content?.filter((part) => part.type === "diff") ?? [])
					: [],
			);
			expect(writes).toEqual(
				[
					["queue.txt", original],
					["correction.txt", corrected],
				].map(([path, newText]) => ({
					type: "diff",
					path: resolve(j.cwd, path),
					oldText: null,
					newText,
				})),
			);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
		},
	);

	// oxlint-disable-next-line max-statements -- Cancellation, durable effects, reload, and correction are one recovery journey.
	it("orchestrates cancellation after an approved write and reloads only the interrupted role with the user's correction", async () => {
		const original = "Approved draft before cancellation.\n";
		const external =
			"User edited the approved draft while the session was closed.\n";
		const corrected =
			"Keep the draft; record the corrected local-only decision here.\n";
		const correction =
			"Continue only the interrupted designer. Preserve my draft edit; write corrected.txt instead of final.txt.";
		const scripts: JourneyScripts = {
			router: [
				call(
					"d3r_start_phase",
					{
						phase: "design",
						brief: {
							goal: "Design a local queue.",
							context: "Retain the user's approved drafts.",
							acceptanceCriteria: ["Record the chosen local-only design."],
						},
					},
					"design",
				),
				phaseReply("design", "Confirm the design"),
				call(
					"d3r_continue_phase",
					{
						instructions:
							"Use a local-only queue; write the draft and final decision.",
					},
					"draft",
				),
			],
			aggregator: done("Existing local jobs must survive restart."),
			researcher: done("A local-only queue avoids network dependencies."),
			designer: [
				call(
					"write_file",
					{ path: "draft.txt", content: original },
					"approved-draft",
				),
				call(
					"write_file",
					{ path: "final.txt", content: "Superseded decision.\n" },
					"pending-final",
				),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		const asked = deferred<RequestPermissionRequest>();
		const release = deferred<boolean>();
		j.approval.decide = async (permission) => {
			if (JSON.stringify(permission.toolCall.rawInput).includes("final.txt")) {
				asked.resolve(permission);
				return release.promise;
			}
			return true;
		};
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(f.prompt(sessionId, "/design Design a local queue"));
		const completedRecon = parseState(
			await f.checkpoint(sessionId),
		).inner!.engine!.records.filter(
			({ kind, status }) => kind === "agent" && status === "completed",
		);
		expect(completedRecon.map(({ role }) => role).toSorted()).toEqual([
			"aggregator",
			"researcher",
		]);
		const pending = f.prompt(
			sessionId,
			"Use a local-only queue; write the draft and final decision.",
		);
		try {
			const permission = await Promise.race([
				asked.promise,
				pending.then(() => {
					throw new Error("Turn ended before the second write permission");
				}),
			]);
			expect(permission.toolCall.title).toBe("write_file");
			expect(await readFile(resolve(j.cwd, "draft.txt"), "utf8")).toBe(
				original,
			);
			await expect(readFile(resolve(j.cwd, "final.txt"))).rejects.toMatchObject(
				{ code: "ENOENT" },
			);
			const designer = lastRequest(j.requests, "designer").context;
			expect(result(designer, "approved-draft")).toMatchObject({
				isError: false,
			});
			await f.cancel(sessionId);
			await expectStop(pending, "cancelled");
		} finally {
			release.resolve(false);
			await f.cancel(sessionId);
			await pending;
		}
		const checkpoint = await f.checkpoint(sessionId);
		const interrupted = parseState(checkpoint).inner!;
		expect(interrupted).toMatchObject({
			orchestrated: true,
			engine: { status: "interrupted" },
		});
		const interruptedRoles = interrupted.engine!.records.filter(
			({ status }) => status === "interrupted",
		);
		expect(interruptedRoles.map(({ role }) => role)).toEqual(["designer"]);
		expect(interrupted.continuations?.map(({ recordId }) => recordId)).toEqual(
			interruptedRoles.map(({ id }) => id),
		);
		expect(JSON.stringify(interrupted.continuations)).toContain(
			"approved-draft",
		);
		for (const record of completedRecon) {
			expect(interrupted.engine!.records).toContainEqual(record);
		}
		const beforeReload = {
			requests: j.requests.length,
			permissions: j.permissions.length,
			runtimes: j.runtimes.length,
		};
		await f.close();
		await writeFile(resolve(j.cwd, "draft.txt"), external);
		const resumed = await j.connect();
		await resumed.load(sessionId);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload.requests);
		expect(j.permissions).toHaveLength(beforeReload.permissions);
		expect(j.runtimes).toHaveLength(beforeReload.runtimes);
		scripts.router = [
			call("d3r_continue_phase", { instructions: correction }, "correct"),
			phaseReply("correct", "Corrected design ready"),
		];
		scripts.designer = [
			call("read_file", { path: "draft.txt" }, "current-draft"),
			call("write_file", { path: "corrected.txt", content: corrected }),
			...done(
				"Preserved the user's draft edit and saved corrected.txt with the local-only decision.",
			),
		];
		j.approval.decide = async () => true;
		const start = resumed.updates.length;
		await expectStop(resumed.prompt(sessionId, correction));
		expect(await readFile(resolve(j.cwd, "draft.txt"), "utf8")).toBe(external);
		expect(await readFile(resolve(j.cwd, "corrected.txt"), "utf8")).toBe(
			corrected,
		);
		await expect(readFile(resolve(j.cwd, "final.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const recovery = j.requests.slice(beforeReload.requests);
		expect(new Set(recovery.map(({ role }) => role))).toEqual(
			new Set(["router", "designer"]),
		);
		const designer = roleRequests(recovery, "designer")[0].context;
		expect(JSON.stringify(designer.messages)).toContain(correction);
		expect(result(designer, "approved-draft")).toMatchObject({
			isError: false,
		});
		expect(result(designer, "pending-final")).toMatchObject({ isError: true });
		expect(
			resultText(lastRequest(recovery, "designer").context, "current-draft"),
		).toContain(external.trim());
		expect(
			j.permissions
				.slice(beforeReload.permissions)
				.map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/), "write_file"]);
		const effects = toolUpdates(resumed.updates.slice(start)).flatMap((row) =>
			row.status === "completed"
				? (row.content?.filter((part) => part.type === "diff") ?? [])
				: [],
		);
		expect(effects).toEqual([
			{
				type: "diff",
				path: resolve(j.cwd, "corrected.txt"),
				oldText: null,
				newText: corrected,
			},
		]);
		const completed = parseState(await resumed.checkpoint(sessionId)).inner!;
		expect(completed.engine).toMatchObject({ status: "completed" });
		for (const record of interrupted.engine!.records.filter(
			({ status }) => status === "completed",
		)) {
			expect(completed.engine!.records).toContainEqual(record);
		}
		expect(completed.continuations ?? []).toEqual([]);
		expect(completed).not.toHaveProperty("summary");
		expect(agentText(resumed.updates.slice(start))).toContain(
			"Preserved the user's draft edit and saved corrected.txt",
		);
		expect(
			resumed.updates
				.slice(start)
				.filter(({ update }) => update.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
		expect(roleRequests(j.requests, "summary")).toEqual([]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	it.each(["failed", "cancelled"] as const)(
		"recovers a %s automatic /develop write without replay, then implements, reviews and audits through real tools",
		// oxlint-disable-next-line max-statements -- Failure, persisted recovery and successful retry are one acceptance journey.
		async (failure) => {
			const content = "Durable offline jobs\n";
			const write = call(
				"write_file",
				{ path: "queue.txt", content },
				"publish-queue",
			);
			const scripts: JourneyScripts = {
				implementor: [
					call("write_file", { path: 42, content }),
					write,
					...done(
						"Write failed; no implementation was made.",
						{ status: "blocked" },
						"A directory obstructed the write.",
					),
				],
			};
			const publication = toolGate("publish-queue");
			const j = await open(scripts, {
				streamResponse: (_role, response, settings) =>
					publication.stream(response, settings?.signal),
			});
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
			const f = await j.connect();
			const { sessionId } = await f.session();
			const request = "/develop Create queue.txt for durable offline jobs";
			await expectStop(f.prompt(sessionId, request));
			expect(agentText(f.updates)).toContain("Choose develop mode");
			expect(j.requests.map(({ role }) => role)).toEqual(["router", "router"]);
			expect(parseState(await f.checkpoint(sessionId)).inner).toMatchObject({
				orchestrated: true,
				engine: { status: "waiting", mode: null, pause: { kind: "mode" } },
			});
			const pending = f.prompt(sessionId, "auto");
			try {
				await Promise.race([
					publication.reached.promise,
					pending.then(() => {
						throw new Error(
							"Turn ended before the workspace write provider gate",
						);
					}),
				]);
				expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
					expect.stringMatching(/^Trust workspace/),
				]);
				expect(j.requests.at(-1)?.context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "write_file",
					isError: true,
				});
				await expect(
					readFile(resolve(j.cwd, "queue.txt")),
				).rejects.toMatchObject({ code: "ENOENT" });
				if (failure === "cancelled") {
					await f.cancel(sessionId);
				} else {
					await mkdir(resolve(j.cwd, "queue.txt"));
					publication.release.resolve();
				}
				await expectStop(
					pending,
					failure === "cancelled" ? "cancelled" : "end_turn",
				);
				if (failure === "failed") {
					const { context } = lastRequest(j.requests, "implementor");
					expect(result(context, "publish-queue")).toMatchObject({
						isError: true,
					});
					expect(resultText(context, "publish-queue")).toBe(
						"Tool execution failed; effects may have occurred. Do not automatically retry.",
					);
					await expect(readdir(resolve(j.cwd, "queue.txt"))).resolves.toEqual(
						[],
					);
					await rm(resolve(j.cwd, "queue.txt"), { recursive: true });
				}
			} finally {
				await f.cancel(sessionId);
				publication.release.resolve();
				await pending;
			}
			await expect(readFile(resolve(j.cwd, "queue.txt"))).rejects.toMatchObject(
				{ code: "ENOENT" },
			);
			if (failure === "failed") {
				expect(toolUpdates(f.updates).map(toolText).join("\n")).toContain(
					"Write failed",
				);
				expect(
					j.requests
						.findLast(({ role }) => role === "implementor")
						?.context.messages.at(-1),
				).toMatchObject({ toolName: "d3r_report", isError: false });
			}
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			const beforeReload = j.requests.length;
			await f.close();
			const resumed = await j.connect();
			await resumed.load(sessionId);
			const checkpoint = await resumed.checkpoint(sessionId);
			const replacement =
				"/develop Replace all local jobs with a cloud service";
			const conflictStart = resumed.updates.length;
			await expectStop(resumed.prompt(sessionId, replacement));
			expect(agentText(resumed.updates.slice(conflictStart))).toContain(
				"Cannot replace unfinished work",
			);
			const retained = parseState(await resumed.checkpoint(sessionId)).inner!;
			expect(retained.engine).toEqual(parseState(checkpoint).inner!.engine);
			expect(retained.input).toEqual(parseState(checkpoint).inner!.input);
			await expectStop(
				resumed.prompt(sessionId, failure === "failed" ? "continue" : "status"),
			);
			expect(j.requests.slice(beforeReload).map(({ role }) => role)).toEqual([
				"router",
				"router",
				"router",
				"router",
			]);
			expect(
				parseState(await resumed.checkpoint(sessionId)).inner!.engine,
			).toEqual(retained.engine);
			expect(
				result(
					j.requests.at(-1)!.context,
					failure === "failed" ? "d3r_continue_phase" : "d3r_phase_status",
				),
			).toMatchObject({ isError: failure === "failed" });
			await expect(readFile(resolve(j.cwd, "queue.txt"))).rejects.toMatchObject(
				{ code: "ENOENT" },
			);
			scripts.implementor = [
				write,
				reportCall("Created queue.txt for durable offline jobs."),
				reply("Implementation ready."),
			];
			scripts.reviewer = [
				call("read_file", { path: "queue.txt" }),
				reportCall("Verified queue.txt contents.", { review: "approved" }),
				reply("Review approved."),
			];
			scripts.auditor = [
				call("read_file", { path: "queue.txt" }),
				...done("Audited the durable queue.", {}, "Audit complete."),
			];
			const recoveryUpdates = resumed.updates.length;
			if (failure === "failed") {
				await expectStop(resumed.prompt(sessionId, "abandon"));
				await expectStop(resumed.prompt(sessionId, request));
			}
			const recoveryRequests = j.requests.length;
			await expectStop(
				resumed.prompt(sessionId, failure === "failed" ? "auto" : "continue"),
			);
			expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(content);
			expect(agentText(resumed.updates.slice(recoveryUpdates))).toContain(
				JOURNEY_SUMMARY,
			);
			const recovery = j.requests.slice(recoveryRequests);
			expect(roleRequests(recovery, "summary")).toEqual([]);

			const progression = recovery
				.filter(({ role }) => role !== "router")
				.map(({ role }) => role)
				.filter(
					(role, index, roles) => index === 0 || role !== roles[index - 1],
				);
			expect(progression).toEqual(["implementor", "reviewer", "auditor"]);
			for (const { role, context } of recovery) {
				expect(JSON.stringify(context.messages)).toContain(request);
				if (failure === "cancelled" && role !== "router") {
					expect(JSON.stringify(context.messages)).not.toContain(replacement);
				}
			}
			const completed = parseState(await resumed.checkpoint(sessionId)).inner!;
			expect(completed.engine).toMatchObject({ status: "completed" });
			expect(JSON.stringify(completed.input)).not.toContain(replacement);
			for (const record of retained.engine!.records.filter(
				({ status }) => status === "completed",
			)) {
				expect(completed.engine!.records).toContainEqual(record);
			}
			for (const role of ["reviewer", "auditor"]) {
				const contexts = roleRequests(recovery, role).map(
					({ context }) => context,
				);
				expect(JSON.stringify(contexts[0].messages)).toContain(request);
				expect(JSON.stringify(contexts[0].messages)).toContain(
					"Created queue.txt for durable offline jobs.",
				);
				expect(contexts[1].messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "read_file",
					isError: false,
				});
				expect(JSON.stringify(contexts[1].messages.at(-1))).toContain(
					content.trim(),
				);
			}
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
				expect.stringMatching(/^Trust workspace/),
			]);
			const effects = resumed.updates
				.slice(recoveryUpdates)
				.flatMap(({ update }) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "completed"
						? (update.content?.filter((part) => part.type === "diff") ?? [])
						: [],
				);
			expect(effects).toEqual([
				{
					type: "diff",
					path: resolve(j.cwd, "queue.txt"),
					oldText: null,
					newText: content,
				},
			]);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
			await resumed.closeSession(sessionId);
		},
	);
});
