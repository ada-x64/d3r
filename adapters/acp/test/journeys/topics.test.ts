import {
	expectStop,
	type JourneyScripts,
	journeyCall as call,
	journeyResult,
	journeyUserText,
	journeyTopic,
	journeyPhaseReply,
	journeyPage,
	journeyDone as done,
	journeyCheckpoint,
	callWith,
	lastRequest,
} from "./helpers.ts";

import { SEED_ROOT } from "@d3r/core/vault/seed-root";
import { cp, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	// oxlint-disable-next-line max-statements -- Existing plans and explicit topic selection keep A -> B -> A document work isolated.
	it("reuses the default plan for /delegate, writes a new topic's research, then returns to the original topic without moving artifacts", async () => {
		const scripts: JourneyScripts = {};
		const j = await open(scripts, { routerShortcuts: false });
		const vault = resolve(j.cwd, ".agents/vault");
		await cp(SEED_ROOT, vault, { recursive: true });
		const goal = "Plan durable dispatch";
		const child = "process/tasks/queue-storage/schema.md";
		const plan = `# Plan: durable dispatch\n\nTask schema: ${child}\n\nPersist queued jobs and verify replay after restart.\n`;
		const amendment =
			"\n## Verification\n\nTest recovery from a truncated journal.\n";
		const research =
			"# Research: release notes\n\nThe supplied brief targets end users rather than API consumers. External prior art remains unverified.\n";
		const brief = {
			goal,
			context: "Retain jobs offline across restarts.",
			acceptanceCriteria: [
				"Use the plan's explicit child-task name for its schema.",
			],
		};
		scripts.router = [
			call("d3r_run_role", { role: "planner", brief }),
			journeyPhaseReply("d3r_run_role", "Plan ready"),
			callWith("d3r_start_phase", (context) => ({
				phase: "delegate",
				topic: journeyTopic(context),
				brief,
			})),
			journeyPhaseReply("d3r_start_phase", "Delegation complete"),
			call("d3r_run_role", {
				role: "researcher",
				brief: {
					goal: "Research unrelated release notes",
					context:
						"Release notes target end users, not API consumers; record the supplied facts without external research.",
					acceptanceCriteria: [
						"Write research.md in the new topic's default directory.",
					],
				},
			}),
			journeyPhaseReply("d3r_run_role", "Release notes research complete"),
			callWith("d3r_run_role", (context) => ({
				role: "planner",
				topic: /^Return to topic ([a-z0-9]+(?:-[a-z0-9]+)*)\b/m.exec(
					journeyUserText(context),
				)![1],
				brief: {
					...brief,
					context:
						"Update the original plan with the requested truncated-journal recovery test; preserve all artifact paths.",
				},
			})),
			journeyPhaseReply("d3r_run_role", "Original plan updated"),
		];
		scripts.planner = [
			call("vault_read", { path: ".misc/templates/plan.md" }, "template"),
			callWith("vault_write", (context) => ({
				mode: "doc",
				path: `process/designs/${journeyTopic(context)}/plan.md`,
				kind: "plan",
				frontmatter: { created: "2026-09-10", status: "draft" },
				body: plan,
			})),
			...done(
				"Planned durable dispatch with the explicit queue-storage child task.",
			),
			callWith(
				"vault_read",
				(context) => ({
					path: `process/designs/${journeyTopic(context)}/plan.md`,
				}),
				"existing-plan",
			),
			...done(
				"The existing plan already specifies the requested task slice; preserve it.",
			),
			call("vault_read", { path: ".misc/templates/plan.md" }, "template"),
			callWith(
				"vault_read",
				(context) => ({
					path: `process/designs/${journeyTopic(context)}/plan.md`,
				}),
				"original-plan",
			),
			callWith("vault_write", (context) => ({
				mode: "raw",
				path: `process/designs/${journeyTopic(context)}/plan.md`,
				contents: `${journeyPage(context, "original-plan").text}${amendment}`,
				snapshot: journeyPage(context, "original-plan").snapshot,
			})),
			...done(
				"Added the recovery test to the original plan without moving artifacts.",
			),
		];
		scripts.schemer = [
			callWith(
				"vault_read",
				(context) => ({
					path: `process/designs/${journeyTopic(context)}/plan.md`,
				}),
				"existing-plan",
			),
			call("vault_read", { path: ".misc/templates/schema.md" }, "template"),
			callWith("vault_write", (context) => ({
				mode: "raw",
				path: /^Task schema: (.+)$/m.exec(
					journeyPage(context, "existing-plan").text,
				)![1],
				contents:
					"# Queue storage schema\n\nPersist jobs before acknowledging them. Test replay across restarts.\n",
			})),
			...done("Created the schema at the plan's explicit child-task path."),
		];
		scripts.researcher = [
			call("vault_read", { path: ".misc/templates/research.md" }, "template"),
			callWith("vault_write", (context) => ({
				mode: "doc",
				path: `process/designs/${journeyTopic(context)}/research.md`,
				kind: "research",
				frontmatter: { created: "2026-09-10", status: "draft" },
				body: research,
			})),
			...done(
				"Recorded release-note facts and the unverified external research gap.",
			),
		];
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(
			f.prompt(
				sessionId,
				"Run only the planner for durable dispatch; write its plan with queue-storage as the explicit child task.",
			),
		);
		const checkpoint = await f.checkpoint(sessionId);
		const planned = journeyCheckpoint(checkpoint).inner!;
		const topic = planned.topic!;
		expect(topic).toMatch(/^plan-durable-dispatch-[a-z0-9]+$/);
		expect(planned).toMatchObject({
			standaloneRole: "planner",
			engine: { status: "completed" },
		});
		const originalPlan = await readFile(
			resolve(vault, `process/designs/${topic}/plan.md`),
			"utf8",
		);
		expect(originalPlan).toContain(plan);
		const planner = lastRequest(j.requests, "planner").context;
		expect(journeyPage(planner, "template").text).toBe(
			await readFile(resolve(SEED_ROOT, ".misc/templates/plan.md"), "utf8"),
		);
		expect(journeyResult(planner, "vault_write")).toMatchObject({
			isError: false,
		});
		const beforeReload = j.requests.length;
		await f.closeSession(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload);
		await expectStop(
			resumed.prompt(
				sessionId,
				"/delegate Continue the same topic using its existing plan; preserve the plan's task names.",
			),
		);
		const delegated = j.requests.slice(beforeReload);
		expect(journeyUserText(delegated[0].context)).toContain(
			"Most recent topic; reuse only for follow-on work on the same subject:",
		);
		expect(journeyTopic(delegated[0].context)).toBe(topic);
		const router = delegated.at(-1)!.context;
		expect(
			router.messages.flatMap((message) =>
				message.role === "assistant" ? message.content : [],
			),
		).toContainEqual(
			expect.objectContaining({
				type: "toolCall",
				name: "d3r_start_phase",
				arguments: { phase: "delegate", topic, brief },
			}),
		);
		expect(journeyResult(router, "d3r_start_phase")).toMatchObject({
			isError: false,
		});
		for (const role of ["planner", "schemer"]) {
			const { context } = lastRequest(delegated, role);
			expect(journeyTopic(context)).toBe(topic);
			expect(journeyPage(context, "existing-plan")).toMatchObject({
				path: `process/designs/${topic}/plan.md`,
				text: originalPlan,
			});
			expect(journeyUserText(context)).toContain(
				`taskDirectory: process/tasks/${topic}`,
			);
			expect(journeyUserText(context)).toContain(
				"Follow the plan's explicit child-task names",
			);
			expect(journeyUserText(context)).toContain(
				"Explicit user paths take precedence without moving existing artifacts.",
			);
			expect(journeyUserText(context)).toContain(
				"do not authorize writes, vault initialization, or commits",
			);
		}
		const schemer = lastRequest(delegated, "schemer").context;
		expect(journeyResult(schemer, "vault_write")).toMatchObject({
			isError: false,
		});
		expect(await readFile(resolve(vault, child), "utf8")).toContain(
			"Test replay across restarts.",
		);
		await expect(
			readdir(resolve(vault, "process/tasks", topic)),
		).rejects.toMatchObject({ code: "ENOENT" });
		const delegationState = await resumed.state(sessionId);
		expect(delegationState.inner).toMatchObject({
			topic,
			engine: { command: "delegate", status: "completed" },
		});
		const schema = await readFile(resolve(vault, child), "utf8");
		const beforeResearch = j.requests.length;
		await expectStop(
			resumed.prompt(
				sessionId,
				"Unrelated task: record research for release notes targeting end users, not API consumers. No external research is needed.",
			),
		);
		const researchState = await resumed.state(sessionId);
		const researched = researchState.inner!;
		expect(researched.topic).toMatch(
			/^research-unrelated-release-notes-[a-z0-9]+$/,
		);
		expect(researched.topic).not.toBe(topic);
		expect(researched).toMatchObject({
			standaloneRole: "researcher",
			engine: { status: "completed" },
		});
		const researchRequests = j.requests.slice(beforeResearch);
		expect(new Set(researchRequests.map(({ role }) => role))).toEqual(
			new Set(["router", "researcher"]),
		);
		const researcher = lastRequest(researchRequests, "researcher").context;
		expect(journeyTopic(researcher)).toBe(researched.topic);
		expect(journeyPage(researcher, "template").text).toBe(
			await readFile(resolve(SEED_ROOT, ".misc/templates/research.md"), "utf8"),
		);
		expect(journeyResult(researcher, "vault_write")).toMatchObject({
			isError: false,
		});
		const researchPath = `process/designs/${researched.topic}/research.md`;
		const savedResearch = await readFile(resolve(vault, researchPath), "utf8");
		expect(savedResearch).toContain(research);
		expect(
			await readFile(
				resolve(vault, `process/designs/${topic}/plan.md`),
				"utf8",
			),
		).toBe(originalPlan);
		const files = await readdir(vault, { recursive: true });
		const beforeReturn = j.requests.length;
		await expectStop(
			resumed.prompt(
				sessionId,
				`Return to topic ${topic} and have the planner add a truncated-journal recovery test to its existing plan. Do not move any artifacts.`,
			),
		);
		const returned = j.requests.slice(beforeReturn);
		expect(journeyTopic(returned[0].context)).toBe(researched.topic);
		expect(journeyUserText(returned[0].context)).toContain(
			`Return to topic ${topic}`,
		);
		expect(new Set(returned.map(({ role }) => role))).toEqual(
			new Set(["router", "planner"]),
		);
		const returningRouter = returned.at(-1)!.context;
		expect(
			returningRouter.messages
				.flatMap((message) =>
					message.role === "assistant" ? message.content : [],
				)
				.findLast(
					(part) => part.type === "toolCall" && part.name === "d3r_run_role",
				),
		).toMatchObject({ arguments: { role: "planner", topic } });
		expect(journeyResult(returningRouter, "d3r_run_role")).toMatchObject({
			isError: false,
		});
		const returningPlanner = lastRequest(returned, "planner").context;
		expect(journeyTopic(returningPlanner)).toBe(topic);
		expect(journeyPage(returningPlanner, "original-plan")).toMatchObject({
			path: `process/designs/${topic}/plan.md`,
			text: originalPlan,
		});
		expect(journeyResult(returningPlanner, "vault_write")).toMatchObject({
			isError: false,
		});
		const returnState = await resumed.state(sessionId);
		expect(returnState.inner).toMatchObject({
			topic,
			standaloneRole: "planner",
			engine: { status: "completed" },
		});
		expect(
			await readFile(
				resolve(vault, `process/designs/${topic}/plan.md`),
				"utf8",
			),
		).toBe(`${originalPlan}${amendment}`);
		expect(await readFile(resolve(vault, researchPath), "utf8")).toBe(
			savedResearch,
		);
		expect(await readFile(resolve(vault, child), "utf8")).toBe(schema);
		expect(await readdir(vault, { recursive: true })).toEqual(files);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.closeSession(sessionId);
	});
});
