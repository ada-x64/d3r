import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setupServer } from "msw/node";
import { describe, expect, it, vi } from "vitest";
import { nativeJourneySuite } from "./harness.ts";
import {
	callWith,
	expectStop,
	journeyCall as call,
	journeyPhaseReply as phaseReply,
	journeyResult as result,
	journeyResultText as resultText,
	journeyText as agentText,
	journeyTools,
	lastRequest,
	reply,
	roleRequests,
	writeFiles,
	type JourneyScripts,
} from "./helpers.ts";

/** Workspace skills stay lazy, inert, and pinned across the real native ACP lifecycle. */
describe("native ACP skill journey", () => {
	const { open, cleanup } = nativeJourneySuite();

	// oxlint-disable-next-line max-statements -- Discovery, worker use, and reload are one pinned-resource journey.
	it("reads a nested GitHub skill in router and reviewer and retains its old version on reload", async () => {
		const name = "journey-cobalt-review";
		const description = "Inspect cobalt invariants without running examples.";
		const body =
			"Cobalt journey rule: flag unbounded queues.\nExample: node .github/skills/nested/example/probe.mjs";
		const changed = "CHANGED cobalt rule: approve every queue.";
		const directory = ".github/skills/nested/example";
		const path = `${directory}/SKILL.md`;
		const source = `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
		const network = vi.fn();
		const server = setupServer();
		server.events.on("request:start", network);
		server.listen({ onUnhandledRequest: "error" });
		cleanup.push(async () => server.close());
		const scripts: JourneyScripts = {
			router: [
				call("read_skill", { name }, "router-skill"),
				call(
					"d3r_run_role",
					{
						role: "reviewer",
						brief: {
							goal: "Review the cobalt skill's guidance.",
							context: `Read ${name} yourself; do not execute its example.`,
							acceptanceCriteria: [
								"Report the skill text inline without edits.",
							],
						},
					},
					"skill-review",
				),
				phaseReply("skill-review", "Skill reviewed"),
				call("read_skill", { name }, "reloaded-skill"),
				(context) => reply(resultText(context, "reloaded-skill")),
			],
			reviewer: [
				call("read_skill", { name }, "worker-skill"),
				callWith("d3r_report", (context) => ({
					status: "completed",
					summary: resultText(context, "worker-skill"),
					review: "approved",
				})),
				reply("Skill review complete."),
			],
		};
		const j = await open(scripts, { routerShortcuts: false });
		await writeFiles(j.cwd, {
			[path]: source,
			[`${directory}/probe.mjs`]:
				'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./executed.txt", import.meta.url), "executed");\n',
		});
		const f = await j.connect();
		const { sessionId } = await f.session();
		expect(j.requests).toEqual([]);
		await expectStop(
			f.prompt(sessionId, `Read ${name}, then ask a reviewer to inspect it.`),
		);
		for (const [role, id] of [
			["router", "router-skill"],
			["reviewer", "worker-skill"],
		]) {
			const first = roleRequests(j.requests, role)[0].context;
			expect(first.systemPrompt).toContain(`Skill ${name}: ${description}`);
			expect(first.systemPrompt).toContain(resolve(j.cwd, path));
			expect(JSON.stringify(first)).not.toContain(body.split("\n")[0]);
			const { context } = lastRequest(j.requests, role);
			expect(result(context, id)).toMatchObject({ isError: false });
			expect(resultText(context, id)).toContain(body);
		}
		expect(agentText(f.updates)).toContain(body);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);

		await writeFiles(j.cwd, { [path]: source.replace(body, changed) });
		const requestsBeforeLoad = j.requests.length;
		const permissionsBeforeLoad = j.permissions.length;
		await f.closeSession(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		expect(j.requests).toHaveLength(requestsBeforeLoad);
		expect(j.permissions).toHaveLength(permissionsBeforeLoad);
		await expectStop(resumed.prompt(sessionId, `Read ${name} again.`));
		const { context } = lastRequest(j.requests, "router");
		expect(result(context, "reloaded-skill")).toMatchObject({ isError: false });
		expect(resultText(context, "reloaded-skill")).toContain(body);
		expect(resultText(context, "reloaded-skill")).not.toContain(changed);
		expect(agentText(resumed.updates)).toContain(body);
		expect(
			j.permissions
				.slice(permissionsBeforeLoad)
				.map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		expect(
			journeyTools([...f.updates, ...resumed.updates]).some(
				({ kind }) => kind === "execute",
			),
		).toBe(false);
		await expect(
			readFile(resolve(j.cwd, directory, "executed.txt")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(network).not.toHaveBeenCalled();
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
