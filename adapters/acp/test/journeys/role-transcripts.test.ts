import {
	expectStop,
	type JourneyScripts,
	JOURNEY_SUMMARY,
	journeyStream,
	journeyReport,
	journeyText,
	journeyToolText,
	journeyTools,
	reply,
	journeyDone as done,
	lastRequest,
} from "./helpers.ts";

import { describe, expect, it } from "vitest";

import { deferred } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	// oxlint-disable-next-line max-statements -- Prove live overlap, independent context, durable replay and continuation in one real-stack journey.
	it("keeps overlapping role text and thoughts in their cards through reload and continuation", async () => {
		const roles = ["aggregator", "researcher"] as const;
		const started = {
			aggregator: deferred<void>(),
			researcher: deferred<void>(),
		};
		const streamed = {
			aggregator: deferred<void>(),
			researcher: deferred<void>(),
		};
		const release = deferred<void>();
		const finish = deferred<void>();
		const scripts: JourneyScripts = {
			router: [reply("Coordinator greeting")],
			designer: done("Designed from both outcomes", {}, "Designer response"),
		};
		for (const role of roles) {
			scripts[role] = [
				[
					{ type: "text", text: `${role} opening` },
					{ type: "thinking", thinking: `${role} private thought` },
					{ type: "text", text: `${role} closing` },
					...journeyReport(`${role} structured outcome`),
				],
				reply(`${role} final response`),
			];
		}
		const j = await open(scripts, {
			streamResponse: (role, content) =>
				journeyStream(content, async (index) => {
					if (
						(role === "aggregator" || role === "researcher") &&
						content.some((part) => part.type === "thinking")
					) {
						if (index === 1) {
							started[role].resolve();
							await release.promise;
						}
						// Three deltas have passed through the real embedded loop, but neither report has run.
						const doneEventIndex = 4;
						if (index === doneEventIndex) {
							streamed[role].resolve();
							await finish.promise;
						}
					}
				}),
		});
		const f = await j.connect();
		const { sessionId } = await f.session();
		await f.prompt(sessionId, "Hello coordinator");
		const pending = f.prompt(sessionId, "/design Investigate two approaches");
		try {
			await Promise.all(roles.map((role) => started[role].promise));
			const initial = journeyTools(f.updates).filter(
				(update) =>
					update.sessionUpdate === "tool_call" &&
					roles.some((role) => role === update.title),
			);
			expect(initial.map(({ title }) => title).toSorted()).toEqual([...roles]);
			expect(initial.every(({ status }) => status === "in_progress")).toBe(
				true,
			);
			release.resolve();
			await Promise.all(roles.map((role) => streamed[role].promise));
			await f.peer.agent.request("session/list", {});
			for (const row of initial) {
				const live = journeyTools(f.updates).findLast(
					(update) => update.toolCallId === row.toolCallId,
				)!;
				expect(live.status).toBe("in_progress");
				expect(journeyToolText(live)).toContain(
					`Response\n\n${row.title} opening`,
				);
				expect(journeyToolText(live)).toContain(
					`Response\n\n${row.title} closing`,
				);
				expect(journeyToolText(live)).toContain(
					`Thought\n\n${row.title} private thought`,
				);
			}
			expect(journeyText(f.updates)).toBe("Coordinator greeting");
		} finally {
			release.resolve();
			finish.resolve();
		}
		await expectStop(pending);
		const completed = roles.map(
			(role) =>
				journeyTools(f.updates).findLast((update) => update.title === role)!,
		);
		for (const [index, role] of roles.entries()) {
			const row = completed[index];
			expect(row).toMatchObject({
				status: "completed",
				rawOutput: {
					status: "completed",
					summary: `${role} structured outcome`,
				},
			});
			expect(journeyToolText(row)).toContain(`${role} final response`);
			const other = role === "aggregator" ? "researcher" : "aggregator";
			expect(journeyToolText(row)).not.toContain(other);
			const ownContext = lastRequest(j.requests, role);
			expect(JSON.stringify(ownContext.context.messages)).toContain(
				`${role} private thought`,
			);
			expect(JSON.stringify(ownContext.context.messages)).not.toContain(
				`${other} private thought`,
			);
		}
		expect(
			f.updates.every((notification) => notification.sessionId === sessionId),
		).toBe(true);
		expect(
			f.updates.some(
				({ update }) => update.sessionUpdate === "agent_thought_chunk",
			),
		).toBe(false);
		expect(journeyText(f.updates)).not.toMatch(
			/opening|closing|private thought|final response/,
		);
		const beforeReload = j.requests.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		expect(j.requests).toHaveLength(beforeReload);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		for (const row of completed) {
			const replay = journeyTools(resumed.updates).filter(
				(update) => update.toolCallId === row.toolCallId,
			);
			const initialAndLatest = 2;
			expect(replay).toHaveLength(initialAndLatest);
			expect(replay[0].status).toBe("in_progress");
			expect(replay[1]).toEqual(row);
		}
		expect(journeyText(resumed.updates)).not.toMatch(
			/opening|closing|private thought|final response/,
		);
		expect(
			resumed.updates.some(
				({ update }) => update.sessionUpdate === "agent_thought_chunk",
			),
		).toBe(false);
		await expectStop(resumed.prompt(sessionId, "Combine both approaches"));
		const designer = j.requests
			.slice(beforeReload)
			.find(({ role }) => role === "designer")!;
		for (const role of roles) {
			expect(JSON.stringify(designer.context.messages)).toContain(
				`${role} structured outcome`,
			);
			expect(JSON.stringify(designer.context.messages)).not.toContain(
				`${role} private thought`,
			);
		}
		expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		expect(journeyText(resumed.updates)).not.toContain("Designer response");
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
