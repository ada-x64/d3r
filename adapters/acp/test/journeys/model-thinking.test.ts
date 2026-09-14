import { describe, expect, it } from "vitest";
import { nativeJourneySuite } from "./harness.ts";
import {
	JOURNEY_MODEL,
	journeyCall as call,
	journeyDone as done,
	journeyPhaseReply as phaseReply,
	journeyStream,
	journeyText,
	expectStop,
	reply,
	roleRequests,
	type JourneyScripts,
} from "./helpers.ts";

/** Disjoint model capabilities catch accidental carry-over and universal off assumptions. */
const high = {
	...JOURNEY_MODEL,
	id: "high",
	reasoning: true,
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		max: "max",
	},
};
/** This model cannot accept the first model's max level. */
const low = {
	...JOURNEY_MODEL,
	id: "low",
	reasoning: true,
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
	},
};

/** The ACP control surface must follow the selected model, including after a reload. */
describe("native model capability journeys", () => {
	const { open } = nativeJourneySuite();

	it("loads thinking choices after model selection and hides fixed or unsupported controls", async () => {
		const fixed = {
			...high,
			id: "fixed",
			thinkingLevelMap: { ...high.thinkingLevelMap, max: null },
		};
		const j = await open(
			{ router: [reply("Ready."), reply("Still ready.")] },
			{
				models: [JOURNEY_MODEL, high, low, fixed],
				routerShortcuts: false,
			},
		);
		const f = await j.connect();
		const { sessionId, configOptions } = await f.newSession(j.cwd);
		expect(configOptions?.some(({ id }) => id === "thought_level")).toBe(false);
		await f.select(sessionId, high);
		await f.configure(sessionId, "thought_level", "max");
		const selected = await f.select(sessionId, low);
		expect(
			selected.configOptions?.find(({ id }) => id === "thought_level"),
		).toMatchObject({
			currentValue: "low",
			options: [
				{ value: "low", name: "low" },
				{ value: "high", name: "high" },
			],
		});
		const before = await f.state(sessionId);
		await expect(
			f.configure(sessionId, "thought_level", "max"),
		).rejects.toThrow();
		expect(await f.state(sessionId)).toEqual(before);
		expect(j.requests).toEqual([]);
		await expectStop(f.prompt(sessionId, "Discuss without starting work."));
		const hidden = await f.select(sessionId, fixed);
		expect(hidden.configOptions?.some(({ id }) => id === "thought_level")).toBe(
			false,
		);
		await expect(f.state(sessionId)).resolves.toMatchObject({
			selection: { thinking: "high" },
		});
		const plain = await f.select(sessionId, JOURNEY_MODEL);
		expect(plain.configOptions?.some(({ id }) => id === "thought_level")).toBe(
			false,
		);
		await expect(f.state(sessionId)).resolves.toMatchObject({
			selection: { thinking: "off" },
		});
		await f.closeSession(sessionId);
		await f.close();
		const restored = await j.connect();
		const loaded = await restored.load(sessionId);
		expect(loaded.configOptions?.some(({ id }) => id === "thought_level")).toBe(
			false,
		);
		await expectStop(restored.prompt(sessionId, "Continue the discussion."));
		expect(journeyText(restored.updates)).toContain("Still ready.");
	});

	it("resumes a retained worker on another model without an off transition or magic user keywords", async () => {
		const instructions =
			"Use a seven-day retention limit; assess the existing queue against it.";
		const scripts: JourneyScripts = {
			router: [
				call("d3r_run_role", {
					role: "reviewer",
					brief: {
						goal: "Review queue retention.",
						context: "The required retention limit is missing.",
						acceptanceCriteria: ["Ask for the limit before deciding."],
					},
				}),
				phaseReply("d3r_run_role", "Retention question"),
				call("d3r_continue_phase", { instructions }),
				phaseReply("d3r_continue_phase", "Review finished"),
			],
			reviewer: [
				...done("What retention limit should apply?", {
					status: "needs_human",
				}),
				...done("Reviewed the queue against the supplied seven-day limit.", {
					review: "approved",
				}),
			],
		};
		const thinking: { role: string; value: unknown }[] = [];
		const j = await open(scripts, {
			models: [low, high],
			routerShortcuts: false,
			streamResponse: (role, content, settings) => {
				thinking.push({ role, value: settings?.reasoning });
				return journeyStream(content);
			},
		});
		const f = await j.connect();
		const { sessionId } = await f.session(low);
		await f.configure(sessionId, "thought_level", "high");
		await expectStop(
			f.prompt(
				sessionId,
				"Review the queue and ask me for missing requirements.",
			),
		);
		const waiting = await f.state(sessionId);
		expect(waiting.inner?.continuations).toHaveLength(1);
		await f.closeSession(sessionId);
		await f.close();
		const restored = await j.connect();
		await restored.load(sessionId);
		await restored.select(sessionId, high);
		await restored.configure(sessionId, "thought_level", "max");
		await expectStop(restored.prompt(sessionId, instructions));
		const completed = await restored.state(sessionId);
		expect(completed.inner?.engine?.status).toBe("completed");
		expect(completed.inner?.continuations).toEqual([]);
		expect(completed.inner?.topic).toBe(waiting.inner?.topic);
		expect(roleRequests(j.requests, "reviewer").at(-1)?.model.id).toBe(high.id);
		expect(thinking.findLast(({ role }) => role === "reviewer")?.value).toBe(
			"max",
		);
		expect(journeyText(restored.updates)).toContain("seven-day limit");
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
