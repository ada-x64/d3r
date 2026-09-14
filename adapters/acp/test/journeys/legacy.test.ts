import {
	expectStop,
	expectTextOnce,
	type JourneyScripts,
	JOURNEY_MODEL,
	journeyStream,
	JOURNEY_PRIVATE_DIAGNOSTIC,
	JOURNEY_DIAGNOSTIC_LEAK,
	journeyCall as call,
	journeyResult,
	journeyDone as done,
	journeyText,
	journeyCheckpoint,
	journeyTools,
	reply,
	lastRequest,
	roleRequests,
} from "./helpers.ts";

import { RequestError } from "@agentclientprotocol/sdk";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createEmbeddedRuntime } from "../../../pi/embedded.ts";

import { deferred, waitForAbort } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	// oxlint-disable-next-line max-statements -- A true pre-stream exception must cross ACP as a request error and recover without implicit retry.
	it("legacy compatibility: reports a synchronous routing network throw as an ACP request error and requires explicit recovery", async () => {
		const greeting = "Ready to discuss the queue.";
		const recovered =
			"The earlier conversation is retained; no work was repeated.";
		const scripts: JourneyScripts = {
			router: [reply(greeting), [], reply(recovered)],
		};
		const j = await open(scripts, {
			streamResponse: (_role, content) => {
				if (content.length === 0) {
					throw Object.assign(
						new Error(`fetch failed: ${JOURNEY_PRIVATE_DIAGNOSTIC}`),
						{
							code: "ECONNRESET",
							cause: { message: JOURNEY_PRIVATE_DIAGNOSTIC },
						},
					);
				}
				return journeyStream(content);
			},
		});
		const f = await j.connect();
		const { sessionId } = await f.legacySession();
		const initialState = await f.state(sessionId);
		expect(initialState.inner).not.toHaveProperty("orchestrated");
		await f.select(sessionId, JOURNEY_MODEL);
		await expectStop(f.prompt(sessionId, "Hello"));
		const failedPrompt = "Discuss recovery before making a queue plan";
		const failureStart = f.updates.length;
		const requestError: unknown = await f
			.prompt(sessionId, failedPrompt)
			.catch((error: unknown) => error);
		const safeError =
			"Model request failed (provider `fixture`; model `offline`; code `ECONNRESET`). The provider connection failed. Check network connectivity and provider availability. No tool execution started in this invocation.";
		const failure = {
			stage: "model_request",
			category: "network",
			code: "ECONNRESET",
			provider: "fixture",
			model: "offline",
			toolsStarted: false,
		};
		const internalErrorCode = -32_603;
		expect(requestError).toBeInstanceOf(RequestError);
		expect(requestError).toMatchObject({
			code: internalErrorCode,
			message: `Internal error: ${safeError}`,
			data: { failure },
		});
		expect((requestError as RequestError).data).toEqual({ failure });
		expect(journeyText(f.updates.slice(failureStart))).toBe("");
		expect(journeyTools(f.updates)).toEqual([]);
		expect(j.requests.map(({ role }) => role)).toEqual(["router", "router"]);
		const checkpoint = await f.checkpoint(sessionId);
		expect(journeyCheckpoint(checkpoint).inner).toMatchObject({
			engine: null,
			routingInterrupted: true,
		});
		expect(
			JSON.stringify([
				{
					message: (requestError as RequestError).message,
					data: (requestError as RequestError).data,
				},
				f.updates,
				await f.saved(sessionId),
				j.requests,
				j.permissions,
			]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		const permissionsBefore = j.permissions.length;
		const requestsBefore = j.requests.length;
		await f.close();
		const resumed = await j.connect();
		await expect(resumed.load(sessionId)).resolves.toBeDefined();
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(requestsBefore);
		expect(j.permissions).toHaveLength(permissionsBefore);
		const recoveryStart = resumed.updates.length;
		await expectStop(resumed.prompt(sessionId, "continue"));
		expect(journeyText(resumed.updates.slice(recoveryStart))).toMatch(
			/Routing was interrupted[\s\S]*abandon[\s\S]*restart/,
		);
		expect(j.requests).toHaveLength(requestsBefore);
		await expectStop(resumed.prompt(sessionId, "abandon"));
		const routingStart = resumed.updates.length;
		await expectStop(
			resumed.prompt(sessionId, "Continue our earlier discussion"),
		);
		expect(journeyText(resumed.updates.slice(routingStart))).toBe(recovered);
		expect(j.requests.slice(requestsBefore).map(({ role }) => role)).toEqual([
			"router",
		]);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
			greeting,
		);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).not.toContain(
			failedPrompt,
		);
		expect(journeyTools(resumed.updates)).toEqual([]);
		expect(
			JSON.stringify([
				resumed.updates,
				await resumed.saved(sessionId),
				j.requests,
			]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		await expect(readdir(j.cwd)).resolves.toEqual(["AGENTS.md"]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Follow the evidence, buffered response, persisted replay and next routing turn together.
	it("legacy compatibility: synthesizes completed design evidence once with the current model, then replays and routes with the cached Markdown", async () => {
		const selected = {
			...JOURNEY_MODEL,
			id: "synthesis",
			name: "Selected model",
		};
		const prior = "Keep the queue offline; deployment has not been approved.";
		const greeting = "I will keep deployment separate from this design phase.";
		const request = "/design Plan a durable offline queue";
		const answer =
			"Use an append-only log; do not deploy until restart tests pass.";
		const reports = {
			aggregator:
				"Existing jobs must survive restarts; deployment is not approved.",
			researcher:
				"An append-only log avoids a network dependency but needs restart testing.",
			designer:
				"Saved design.md with log recovery and restart tests; no implementation or deployment was performed.",
		};
		const design =
			"# Durable queue\n\nUse an append-only log. Test recovery before deployment.\n";
		const opening =
			"## Design ready\n\nThe [queue design](design.md) records log-based recovery for durable offline jobs.";
		const conclusion =
			"\n\nAn append-only log preserves pending jobs without a network service, following your decision. Implementation and deployment have not started.\n\n**Next:** Review the design, use `/delegate` to plan implementation, and require passing restart tests before approving deployment.";
		const markdown = opening + conclusion;
		const buffered = deferred<void>();
		const release = deferred<void>();
		const scripts: JourneyScripts = {
			router: [
				reply(greeting),
				reply("Review the design before starting `/delegate`."),
			],
			aggregator: done(reports.aggregator),
			researcher: done(reports.researcher),
			designer: [
				call("write_file", { path: "design.md", content: design }),
				...done(reports.designer),
			],
			summary: [
				[
					{ type: "thinking", thinking: "Private summary deliberation" },
					{ type: "text", text: opening },
					{ type: "text", text: conclusion },
				],
			],
		};
		const attachmentText =
			"Attachment bytes: customer backlog must remain available offline.";
		const resourceReads: string[] = [];
		const j = await open(scripts, {
			models: [JOURNEY_MODEL, selected],
			createRuntime: (options) =>
				createEmbeddedRuntime({
					...options,
					resolveResource: async (resource, context) => {
						resourceReads.push(options.budgetLabel!);
						return options.resolveResource!(resource, context);
					},
				}),
			streamResponse: (role, content) =>
				journeyStream(content, async (index) => {
					// Both text deltas and the thought have entered Pi before its terminal event.
					const doneEventIndex = 4;
					if (role === "summary" && index === doneEventIndex) {
						buffered.resolve();
						await release.promise;
					}
				}),
		});
		const brief = resolve(j.cwd, "brief.txt");
		await writeFile(brief, attachmentText);
		const attachment = {
			type: "resource_link" as const,
			uri: pathToFileURL(brief).href,
			name: "queue brief",
			mimeType: "text/plain",
		};
		const f = await j.connect();
		const { sessionId } = await f.legacySession();
		const initialState = await f.state(sessionId);
		expect(initialState.inner).not.toHaveProperty("orchestrated");
		await f.select(sessionId, JOURNEY_MODEL);
		await f.prompt(sessionId, prior);
		await expectStop(
			f.peer.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: request }, attachment],
			}),
		);
		expect(j.requests.map(({ role }) => role).toSorted()).toEqual([
			"aggregator",
			"aggregator",
			"researcher",
			"researcher",
			"router",
		]);
		const waitingState = await f.state(sessionId);
		const waiting = waitingState.inner!;
		expect(waiting.engine).toMatchObject({
			status: "waiting",
			pause: { kind: "human" },
		});
		expect(waiting).not.toHaveProperty("summary");
		await f.select(sessionId, selected);
		const completionStart = f.updates.length;
		const pending = f.prompt(sessionId, answer);
		try {
			await buffered.promise;
			await f.peer.agent.request("session/list", {});
			expect(journeyText(f.updates.slice(completionStart))).toBe("");
			expect(
				journeyResult(
					lastRequest(j.requests, "designer").context,
					"write_file",
				),
			).toMatchObject({ isError: false });
			expect(await readFile(resolve(j.cwd, "design.md"), "utf8")).toBe(design);
			for (const [role, summary] of Object.entries(reports)) {
				expect(
					journeyTools(f.updates).findLast((row) => row.title === role),
				).toMatchObject({
					status: "completed",
					rawOutput: { status: "completed", summary },
				});
			}
		} finally {
			release.resolve();
		}
		await expectStop(pending);
		const summaries = roleRequests(j.requests, "summary");
		expect(summaries).toHaveLength(1);
		const [{ context, model }] = summaries;
		expect(model).toEqual(selected);
		expect(context.systemPrompt).toMatch(
			/^You summarize completed D3R workflows\./,
		);
		expect(context.systemPrompt).toContain("do not concatenate individual");
		expect(context.systemPrompt).not.toContain(
			"Preserve the offline user's requirements.",
		);
		expect(context.tools).toEqual([]);
		expect(context.messages).toHaveLength(1);
		const [message] = context.messages;
		expect(message.role).toBe("user");
		if (message.role !== "user" || typeof message.content === "string") {
			throw new Error("Expected one isolated user evidence message");
		}
		expect(message.content).toHaveLength(1);
		const [part] = message.content;
		if (part.type !== "text") {
			throw new Error("Expected text-only JSON evidence");
		}
		expect(JSON.parse(part.text)).toEqual({
			workflow: {
				command: "design",
				description: "Design phase - produce design.md from a topic",
			},
			operatorInput: [
				request,
				`Referenced resource: queue brief (${attachment.uri})`,
				answer,
			],
			priorContext: [
				`Routing user:\n${prior}`,
				`Routing response:\n${greeting}`,
			],
			results: [
				{
					role: "aggregator",
					status: "completed",
					outcome: { status: "completed", summary: reports.aggregator },
				},
				{
					role: "researcher",
					status: "completed",
					outcome: { status: "completed", summary: reports.researcher },
				},
				{
					status: "completed",
					question: "Discuss design questions before drafting",
					answer,
				},
				{
					role: "designer",
					status: "completed",
					outcome: { status: "completed", summary: reports.designer },
				},
			],
		});
		expect(part.text).not.toContain(attachmentText);
		expect(resourceReads.toSorted()).toEqual([
			"aggregator",
			"designer",
			"researcher",
		]);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"aggregator",
			"researcher",
			"designer",
			"workflow summary",
		]);
		const synthesis = j.runtimes.at(-1)!;
		expect(synthesis.options).toMatchObject({
			tools: [],
			maxTurns: 1,
			maxTotalTurns: 1,
			model: selected,
		});
		expect(new Set(j.runtimes.map(({ input }) => input.sessionId)).size).toBe(
			j.runtimes.length,
		);
		expect(journeyText(f.updates.slice(completionStart))).toBe(markdown);
		expect(
			f.updates.some(
				({ update }) => update.sessionUpdate === "agent_thought_chunk",
			),
		).toBe(false);
		expect(
			journeyTools(f.updates)
				.filter((row) => row.sessionUpdate === "tool_call")
				.map(({ title }) => title)
				.toSorted(),
		).toEqual([
			"aggregator",
			"d3r_report",
			"d3r_report",
			"d3r_report",
			"designer",
			"researcher",
			"write_file",
		]);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			"write_file",
		]);
		const checkpoint = await f.checkpoint(sessionId);
		const completed = journeyCheckpoint(checkpoint).inner!;
		expect(completed).not.toHaveProperty("topic");
		expect(completed).toMatchObject({
			summary: markdown,
			phase: "routing",
			engine: { status: "completed" },
		});
		expect(completed.engine!.records).toHaveLength(
			Object.keys(reports).length + 1,
		);
		const reconRecords = waiting.engine!.records.filter(
			({ status }) => status === "completed",
		);
		expect(completed.engine!.records.slice(0, reconRecords.length)).toEqual(
			reconRecords,
		);
		expect(
			completed
				.engine!.records.filter(({ role }) => role)
				.map(({ role, outcome, status }) => ({ role, outcome, status })),
		).toEqual(
			Object.entries(reports).map(([role, summary]) => ({
				role,
				outcome: { status: "completed", summary },
				status: "completed",
			})),
		);
		const effects = {
			requests: j.requests.length,
			runtimes: j.runtimes.length,
			permissions: j.permissions.length,
			resourceReads: resourceReads.length,
		};
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expectTextOnce(journeyText(resumed.updates), markdown);
		expect(j.requests).toHaveLength(effects.requests);
		expect(j.runtimes).toHaveLength(effects.runtimes);
		expect(j.permissions).toHaveLength(effects.permissions);
		expect(resourceReads).toHaveLength(effects.resourceReads);
		const routingStart = resumed.updates.length;
		await expectStop(resumed.prompt(sessionId, "What should I do next?"));
		expect(j.requests.slice(effects.requests).map(({ role }) => role)).toEqual([
			"router",
		]);
		const next = j.requests.at(-1)!;
		const routingState = await resumed.state(sessionId);
		expect(routingState.inner).not.toHaveProperty("topic");
		expect(next.model).toEqual(selected);
		expect(JSON.stringify(next.context.messages)).toContain(
			JSON.stringify(`Workflow summary (/design):\n${markdown}`).slice(1, -1),
		);
		expect(journeyText(resumed.updates.slice(routingStart))).toBe(
			"Review the design before starting `/delegate`.",
		);
		expect(journeyTools(resumed.updates.slice(routingStart))).toEqual([]);
		expect(await readFile(resolve(j.cwd, "design.md"), "utf8")).toBe(design);
		const retainedState = await resumed.state(sessionId);
		expect(retainedState.inner).toMatchObject({
			engine: null,
			history: expect.arrayContaining([
				{ type: "text", text: `Workflow summary (/design):\n${markdown}` },
			]),
		});
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	it.each([
		"provider failure",
		"JSON",
		"fenced JSON",
		"empty",
		"oversized",
		"cancelled",
	] as const)(
		"legacy compatibility: retains completed work across %s synthesis and reload without partial output or reruns",
		// oxlint-disable-next-line max-statements -- Keep final effects, failed synthesis, reload and continuation in one acceptance journey.
		async (failure) => {
			const partial = "Unfinished summary must never be shown";
			const reports = {
				planner: "Planned bounded queue tasks with explicit recovery tests.",
				schemer:
					"Saved tasks.md with the recovery schema; implementation has not started.",
			};
			const artifact =
				"# Queue tasks\n\nImplement recovery, then verify restart behavior.\n";
			const oversizedLength = 8193;
			const output = {
				"provider failure": partial,
				JSON: JSON.stringify({ summary: reports }),
				"fenced JSON": `## Done\n\n\`\`\`json\n${JSON.stringify(reports)}\n\`\`\``,
				empty: " \n ",
				oversized: "x".repeat(oversizedLength),
				cancelled: partial,
			}[failure];
			const fallback =
				"**Workflow /delegate completed.**\n\nSummary unavailable; the completed workflow results have been retained.\n\n**Next:** Review the results, then use `/develop` when ready.";
			const streamed = deferred<void>();
			const scripts: JourneyScripts = {
				planner: done(reports.planner),
				schemer: [
					call("write_file", { path: "tasks.md", content: artifact }),
					...done(reports.schemer),
				],
				summary: [
					[
						{ type: "thinking", thinking: "Private synthesis reasoning" },
						{ type: "text", text: output },
					],
				],
				router: [reply("The saved task plan is ready for review.")],
			};
			const j = await open(scripts, {
				streamResponse: (role, content, settings) =>
					journeyStream(content, async (index) => {
						const doneEventIndex = 3;
						if (role !== "summary" || index !== doneEventIndex) {
							return;
						}
						streamed.resolve();
						if (failure === "cancelled") {
							await waitForAbort(settings!.signal!);
						}
						if (failure === "provider failure") {
							throw new Error(
								"Private provider failure after partial synthesis",
							);
						}
					}),
			});
			const f = await j.connect();
			const { sessionId } = await f.legacySession();
			const initialState = await f.state(sessionId);
			expect(initialState.inner).not.toHaveProperty("orchestrated");
			await f.select(sessionId, JOURNEY_MODEL);
			const pending = f.prompt(sessionId, "/delegate Plan the durable queue");
			if (failure === "cancelled") {
				try {
					await streamed.promise;
					await f.peer.agent.request("session/list", {});
					expect(journeyText(f.updates)).toBe("");
					expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(
						artifact,
					);
				} finally {
					await f.cancel(sessionId);
				}
			}
			await expectStop(
				pending,
				failure === "cancelled" ? "cancelled" : "end_turn",
			);
			const expected = failure === "cancelled" ? "" : fallback;
			expect(journeyText(f.updates)).toBe(expected);
			expect(
				f.updates.filter(
					({ update }) => update.sessionUpdate === "agent_message_chunk",
				),
			).toHaveLength(failure === "cancelled" ? 0 : 1);
			expect(
				f.updates.some(
					({ update }) => update.sessionUpdate === "agent_thought_chunk",
				),
			).toBe(false);
			expect(JSON.stringify(f.updates)).not.toMatch(
				/Unfinished summary|Private synthesis reasoning|Private provider failure/,
			);
			const summaries = roleRequests(j.requests, "summary");
			expect(summaries).toHaveLength(1);
			expect(summaries[0].context.tools).toEqual([]);
			expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
				"planner",
				"schemer",
				"workflow summary",
			]);
			expect(
				journeyTools(f.updates)
					.filter((row) => row.sessionUpdate === "tool_call")
					.map(({ title }) => title),
			).toEqual([
				"planner",
				"d3r_report",
				"schemer",
				"write_file",
				"d3r_report",
			]);
			const checkpoint = await f.checkpoint(sessionId);
			const completed = journeyCheckpoint(checkpoint).inner!;
			expect(completed).toMatchObject({
				phase: "routing",
				engine: { status: "completed" },
			});
			if (failure === "cancelled") {
				expect(completed).not.toHaveProperty("summary");
			} else {
				expect(completed.summary).toBe(fallback);
			}
			expect(
				completed.engine!.records.map(({ role, status, outcome }) => ({
					role,
					status,
					outcome,
				})),
			).toEqual(
				Object.entries(reports).map(([role, summary]) => ({
					role,
					status: "completed",
					outcome: { status: "completed", summary },
				})),
			);
			const effects = {
				requests: j.requests.length,
				runtimes: j.runtimes.length,
				permissions: j.permissions.length,
			};
			await f.close();
			const resumed = await j.connect();
			await resumed.load(sessionId);
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(journeyText(resumed.updates)).toBe(expected);
			expect(j.requests).toHaveLength(effects.requests);
			expect(j.runtimes).toHaveLength(effects.runtimes);
			expect(j.permissions).toHaveLength(effects.permissions);
			const continuation = resumed.updates.length;
			await expectStop(resumed.prompt(sessionId, "What next?"));
			expect(
				j.requests.slice(effects.requests).map(({ role }) => role),
			).toEqual(["router"]);
			expect(roleRequests(j.requests, "summary")).toHaveLength(1);
			expect(journeyTools(resumed.updates.slice(continuation))).toEqual([]);
			expect(journeyText(resumed.updates.slice(continuation))).toBe(
				"The saved task plan is ready for review.",
			);
			const routingState = await resumed.state(sessionId);
			const routed = routingState.inner!;
			expect(routed.engine).toBeNull();
			for (const report of Object.values(reports)) {
				expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
					report,
				);
			}
			if (failure !== "cancelled") {
				expect(routed.history).toContainEqual({
					type: "text",
					text: `Workflow summary (/delegate):\n${fallback}`,
				});
			}
			expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(artifact);
			expect(
				j.permissions
					.slice(effects.permissions)
					.map(({ toolCall }) => toolCall.title),
			).toEqual([expect.stringMatching(/^Trust workspace/)]);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
		},
	);
});
