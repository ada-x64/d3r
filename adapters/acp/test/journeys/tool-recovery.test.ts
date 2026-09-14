import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeJourneySuite } from "./harness.ts";
import {
	callWith,
	expectStop,
	type JourneyScripts,
	journeyCall as call,
	journeyPhaseReply as phaseReply,
	journeyResult as result,
	journeyResultText as resultText,
	journeyText,
	journeyTools,
	lastRequest,
	reply,
	writeFiles,
} from "./helpers.ts";

describe("native ACP tool recovery journeys", () => {
	const { open } = nativeJourneySuite();
	// oxlint-disable-next-line max-statements -- Preflight, retained review, direct retry and trust boundaries form one journey.
	it("retries a cwd preflight failure directly in the router without abandoning the paused reviewer", async () => {
		const scripts: JourneyScripts = {};
		const j = await open(scripts, {
			workspace: "repo/worktrees/known-refusal",
			routerShortcuts: false,
		});
		const parent = resolve(j.root, "repo");
		const vault = resolve(parent, ".agents/vault");
		const marker = resolve(parent, "wrongly-started.txt");
		const outside = resolve(parent, "private.txt");
		const sentinel = "PRIVATE parent data must not enter the review";
		await writeFiles(parent, {
			".agents/vault/notes/review.md": "Review pending.\n",
			"private.txt": sentinel,
		});
		const goal = "Review this worktree with an offline Node cwd probe.";
		const brief = {
			goal,
			context: "No network, servers or implementation.",
			acceptanceCriteria: ["Report inline."],
		};
		const bad = {
			command: process.execPath,
			args: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], 'started')",
				marker,
			],
			cwd: parent,
		};
		const retry = {
			command: process.execPath,
			args: ["-e", "console.log(process.cwd())"],
		};
		scripts.router = [
			call("d3r_run_role", { role: "reviewer", brief }, "review"),
			phaseReply("review", "Review paused"),
			call("run_command", retry, "retry"),
			(context) => reply(resultText(context, "retry")),
		];
		scripts.reviewer = [
			call("run_command", bad, "bad-cwd"),
			call("read_file", { path: outside }, "outside-read"),
			callWith("d3r_report", (context) => ({
				status: "needs_human",
				summary: resultText(context, "bad-cwd"),
			})),
			reply("Review remains paused; no command was started."),
		];
		const f = await j.connect();
		const { sessionId } = await f.session();
		const pin = await f.state(sessionId);
		await expectStop(f.prompt(sessionId, goal));
		const { inner: waiting } = await f.state(sessionId);
		expect(waiting).toMatchObject({
			standaloneRole: "reviewer",
			engine: {
				command: "standalone",
				status: "waiting",
				pause: { kind: "report" },
			},
		});
		expect(waiting!.continuations).toHaveLength(1);
		const reviewed = lastRequest(j.requests, "reviewer").context;
		expect(result(reviewed, "bad-cwd")).toMatchObject({ isError: true });
		expect(resultText(reviewed, "bad-cwd")).toBe(
			"Command was not started: cwd must be an accessible directory within the approved workspace roots. Omit cwd to use the session workspace, or correct it and retry. This is not a command approval denial.",
		);
		expect(result(reviewed, "outside-read")).toMatchObject({ isError: true });
		await expectStop(
			f.prompt(
				sessionId,
				"Run the Node cwd probe directly now, omitting cwd. Keep the reviewer paused; do not continue, abandon or cancel it.",
			),
		);
		const recovered = await f.state(sessionId);
		expect(recovered.inner!.engine).toEqual(waiting!.engine);
		expect(recovered.inner!.continuations).toEqual(waiting!.continuations);
		expect(recovered.resources).toEqual(pin.resources);
		expect(recovered.resources.vaultRoot).toBe(vault);
		expect(recovered.sources).toEqual(pin.sources);
		expect(j.requests.map(({ role }) => role).join(",")).toBe(
			"router,reviewer,reviewer,reviewer,reviewer,router,router,router",
		);
		const routed = lastRequest(j.requests, "router").context;
		expect(result(routed, "retry")).toMatchObject({ isError: false });
		expect(resultText(routed, "retry")).toBe(`${j.cwd}\n\nExit code: 0`);
		expect(journeyText(f.updates)).toContain(resultText(routed, "retry"));
		for (const context of [reviewed, routed]) {
			expect(context.systemPrompt).toContain(
				`Session workspace: ${j.cwd}\nFor run_command, omit cwd to use this workspace. The vault location is separate; its parent is not implicitly an approved command directory.`,
			);
		}
		expect(routed.systemPrompt).toContain(
			"A paused worker does not disable the router's command tool or require abandonment just to run those commands.",
		);
		const commands = journeyTools(f.updates).filter(
			({ sessionUpdate, kind }) =>
				sessionUpdate === "tool_call" && kind === "execute",
		);
		expect(commands.map(({ rawInput }) => rawInput)).toEqual([bad, retry]);
		expect(JSON.stringify(journeyTools(f.updates))).not.toMatch(
			/d3r_(?:start|continue|abandon)_phase/,
		);
		expect(j.permissions.map(({ toolCall }) => toolCall.rawInput)).toEqual([
			expect.objectContaining({
				cwd: j.cwd,
				vaultRoot: vault,
				additionalDirectories: [],
			}),
			expect.objectContaining(bad),
			expect.objectContaining({ ...retry, cwd: j.cwd }),
		]);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(outside, "utf8")).resolves.toBe(sentinel);
		const saved = JSON.stringify(await f.saved(sessionId));
		expect(saved).not.toMatch(
			/allow_scope|d3r:native:commands|d3r:native:workspace-edits/,
		);
		const evidence = JSON.stringify([reviewed.messages, f.updates]);
		expect(evidence).not.toMatch(
			/effects may have occurred|Do not automatically retry|Tool permission (?:denied|request failed)|permissions? (?:are )?(?:disabled|blocked)/i,
		);
		const observed = JSON.stringify([j.requests, f.updates, saved]);
		expect(observed).not.toContain(sentinel);
		expect(scripts).toEqual({ router: [], reviewer: [] });
	});
});
