import { symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeJourneySuite } from "./harness.ts";
import {
	expectStop,
	journeyCall as call,
	journeyDone as done,
	journeyPhaseReply as phaseReply,
	journeyResult as result,
	journeyResultText as resultText,
	journeyText,
	lastRequest,
	reply,
	writeFiles,
} from "./helpers.ts";

/** Instruction aliases must not prevent recovery or become workspace tool grants. */
describe("native ACP instruction alias journey", () => {
	const { open } = nativeJourneySuite();

	// oxlint-disable-next-line max-statements -- A late alias, cold reload, fresh discovery and denied tool read form one regression.
	it("reloads a pinned session after adding an ancestor instruction alias without widening read access", async () => {
		const workspace = "repo/worktrees/task";
		const pinnedRule = "Task rule: preserve the typed-path checkpoint.";
		const sharedRule = "Shared rule: resolve typed paths before use.";
		const goal =
			"Audit whether inherited instructions grant read access to ../../AGENTS.md; do not edit files.";
		const j = await open(
			{
				router: [
					reply("Checkpoint staged."),
					reply("Continuing with the saved instructions."),
					call(
						"d3r_run_role",
						{
							role: "auditor",
							brief: {
								goal,
								context:
									"The ancestor instruction alias is outside the worktree.",
								acceptanceCriteria: [
									"Report the read outcome without changes.",
								],
							},
						},
						"audit-alias",
					),
					phaseReply("audit-alias", "Instruction alias audit"),
				],
				auditor: [
					call("read_file", { path: "../../AGENTS.md" }, "alias-read"),
					...done("Read access stayed confined to the worktree."),
				],
			},
			{ workspace, routerShortcuts: false },
		);
		const alias = resolve(j.root, "repo/AGENTS.md");
		const target = resolve(j.root, ".config/AGENTS.md");
		await writeFiles(j.root, {
			[`${workspace}/AGENTS.md`]: pinnedRule,
			".config/AGENTS.md": sharedRule,
		});

		const f = await j.connect();
		const { sessionId } = await f.session();
		expect(j.requests).toEqual([]);
		await expectStop(f.prompt(sessionId, "Stage this session for later."));
		const staged = await f.state(sessionId);
		const pin = staged.resources.instructions;
		expect(pin).toContain(pinnedRule);
		expect(pin).not.toContain(sharedRule);
		await f.closeSession(sessionId);
		await f.close();

		await symlink(relative(dirname(alias), target), alias, "file");
		const beforeReload = j.requests.length;
		const resumed = await j.connect();
		await expect(resumed.load(sessionId)).resolves.toEqual(expect.any(Object));
		expect(j.requests).toHaveLength(beforeReload);
		const restored = await resumed.state(sessionId);
		expect(restored.resources.instructions).toBe(pin);
		expect(journeyText(resumed.updates)).toContain("Checkpoint staged.");
		await expectStop(
			resumed.prompt(sessionId, "Which instructions still apply?"),
		);
		for (const { context } of j.requests) {
			expect(context.systemPrompt).toContain(pin);
			expect(context.systemPrompt).not.toContain(sharedRule);
		}

		const beforeNew = j.requests.length;
		const fresh = await resumed.session();
		expect(j.requests).toHaveLength(beforeNew);
		const freshState = await resumed.state(fresh.sessionId);
		const discovered = freshState.resources.instructions;
		expect(discovered).toContain(pinnedRule);
		expect(discovered).toContain(sharedRule);
		expect(discovered).toContain(alias);
		expect(discovered).not.toContain(target);
		await expectStop(resumed.prompt(fresh.sessionId, goal));
		for (const { context } of j.requests.slice(beforeNew)) {
			expect(context.systemPrompt).toContain(discovered);
		}
		const audited = lastRequest(j.requests, "auditor").context;
		expect(result(audited, "alias-read")).toMatchObject({ isError: true });

		expect(resultText(audited, "alias-read")).not.toContain(sharedRule);
		expect(journeyText(resumed.updates)).toContain(
			"Read access stayed confined to the worktree.",
		);
	});
});
