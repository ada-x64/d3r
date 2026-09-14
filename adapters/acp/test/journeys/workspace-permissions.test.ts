import {
	expectStop,
	type JourneyScripts,
	journeyCheckpoint as parseState,
	journeyCall as call,
	journeyDone as done,
	journeyResult as result,
	journeyResultText as resultText,
	journeyPhaseReply as phaseReply,
	journeyText as agentText,
	journeyToolGate as toolGate,
	callWith,
	lastRequest,
	journeyPage,
	workspaceSnapshot as snapshot,
	writeFiles,
} from "./helpers.ts";

import { SEED_ROOT } from "@d3r/core/vault/seed-root";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { nativeJourneySuite } from "./harness.ts";

describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();

	// oxlint-disable-next-line max-statements -- Direct implementation, role boundaries and protected disk effects form one journey.
	it("runs a direct implementor's writes and edits plus cross-role vault mutations with workspace trust alone", async () => {
		const gate = toolGate("stale-workspace-edit");
		const scripts: JourneyScripts = {};
		const j = await open(scripts, {
			routerShortcuts: false,
			streamResponse: (_role, content, settings) =>
				gate.stream(content, settings?.signal),
		});
		const vault = resolve(j.cwd, ".agents/vault");
		await cp(SEED_ROOT, vault, { recursive: true });
		const sentinel = "PRIVATE automatic-write sentinel";
		const privateFile = resolve(j.cwd, ".git/private.txt");
		const outside = resolve(j.root, "outside.txt");
		await writeFiles(j.cwd, { ".git/private.txt": sentinel });
		await writeFiles(j.root, { "outside.txt": sentinel });
		const original = "Queue: pending\n";
		const external = "Queue: ready\nOperator comment\n";
		const final = external.replace("ready", "done");
		const note = "notes/automatic.md";
		const moved = "notes/reviewed.md";

		const goal =
			"Implement the local queue in auto mode, with workspace files and a vault log; no commands.";
		scripts.router = [
			call(
				"d3r_run_role",
				{
					role: "implementor",
					mode: "auto",
					brief: {
						goal,
						context: "Preserve external edits and private paths.",
						acceptanceCriteria: [
							"Save the queue and counter, and update its vault log.",
						],
					},
				},
				"implement",
			),
			phaseReply("implement", "Implementation saved"),
			call(
				"d3r_run_role",
				{
					role: "reviewer",
					brief: {
						goal: "Review the queue and move its vault log; save notes/review.md.",
						context: goal,
						acceptanceCriteria: [
							"Verify the saved files before moving the log.",
						],
					},
				},
				"review",
			),
			phaseReply("review", "Review saved"),
			call(
				"d3r_run_role",
				{
					role: "auditor",
					brief: {
						goal: "Audit the saved review, remove the temporary vault log and save notes/audit.md.",
						context: goal,
						acceptanceCriteria: ["Read the log before removing it."],
					},
				},
				"audit",
			),
			phaseReply("audit", "Audit saved"),
		];
		scripts.implementor = [
			[
				["queue.txt", original, "create-queue"],
				["counter.txt", "Count: 0\n", "create-counter"],
			].flatMap(([path, content, id]) =>
				call("write_file", { path, content }, id),
			),
			[
				...call("read_file", { path: "queue.txt" }, "queue-read"),
				...call("read_file", { path: "counter.txt" }, "counter-read"),
			],
			(context) =>
				[
					["queue.txt", "pending", "ready", "queue-read", "edit-queue"],
					["counter.txt", "0", "1", "counter-read", "edit-counter"],
				].flatMap(([path, oldText, newText, readId, id]) =>
					call(
						"edit_file",
						{ path, oldText, newText, snapshot: snapshot(context, readId) },
						id,
					),
				),
			[
				...call("read_file", { path: "queue.txt" }, "before-external"),
				...call("read_file", { path: "counter.txt" }, "counter-edited"),
			],
			callWith(
				"edit_file",
				(context) => ({
					path: "queue.txt",
					oldText: "ready",
					newText: "done",
					snapshot: snapshot(context, "before-external"),
				}),
				"stale-workspace-edit",
			),
			call("read_file", { path: "queue.txt" }, "fresh-queue"),
			(context) => [
				...call(
					"edit_file",
					{
						path: "queue.txt",
						oldText: "ready",
						newText: "done",
						snapshot: snapshot(context, "fresh-queue"),
					},
					"fresh-workspace-edit",
				),
				...call(
					"write_file",
					{
						path: "counter.txt",
						content: "Count: 2\n",
						snapshot: snapshot(context, "counter-edited"),
					},
					"overwrite-counter",
				),
			],
			[
				...call(
					"write_file",
					{ path: "queue.txt", content: "Clobbered" },
					"missing-workspace-snapshot",
				),
				...call(
					"write_file",
					{ path: ".git/private.txt", content: "Clobbered" },
					"private-workspace-write",
				),
				...call(
					"write_file",
					{ path: outside, content: "Clobbered" },
					"outside-workspace-write",
				),
				...call(
					"vault_write",
					{ mode: "raw", path: note, contents: "State: pending\n" },
					"create-log",
				),
			],
			call("vault_read", { path: note }, "log-read"),
			callWith(
				"vault_edit",
				(context) => ({
					path: note,
					find: "pending",
					replace: "done",
					snapshot: journeyPage(context, "log-read").snapshot,
				}),
				"edit-log",
			),
			...done(
				"Saved queue.txt, counter.txt and the vault log with the operator comment intact.",
			),
		];
		scripts.reviewer = [
			[
				...call("read_file", { path: "queue.txt" }, "review-queue"),
				...call("read_file", { path: "counter.txt" }, "review-counter"),
				...call("vault_read", { path: note }, "review-log"),
			],
			callWith(
				"vault_mv",
				(context) => ({
					from: note,
					to: moved,
					snapshot: journeyPage(context, "review-log").snapshot,
				}),
				"move-log",
			),
			call(
				"vault_write",
				{
					mode: "raw",
					path: "notes/review.md",
					contents: "Queue and counter verified.\n",
				},
				"save-review",
			),
			...done(
				"Reviewed the saved files and moved the log.",
				{ review: "approved" },
				"Review complete.",
			),
		];
		scripts.auditor = [
			[
				...call("vault_read", { path: moved }, "audit-log"),
				...call("vault_read", { path: "notes/review.md" }, "audit-review"),
			],
			callWith(
				"vault_rm",
				(context) => ({
					path: moved,
					snapshot: journeyPage(context, "audit-log").snapshot,
				}),
				"remove-log",
			),
			call(
				"vault_write",
				{
					mode: "raw",
					path: "notes/audit.md",
					contents: "Review verified; temporary log removed.\n",
				},
				"save-audit",
			),
			...done("Audited the saved review and removed only the temporary log."),
		];
		const f = await j.connect();
		const { sessionId } = await f.session();
		j.approval.decide = async () => false;
		await expectStop(f.prompt(sessionId, goal));
		expect(j.requests).toEqual([]);
		await expect(readFile(resolve(j.cwd, "queue.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		j.approval.decide = async ({ toolCall }) =>
			toolCall.title?.startsWith("Trust workspace") === true;
		const pending = f.prompt(sessionId, goal);
		try {
			await Promise.race([
				gate.reached.promise,
				pending.then(() => {
					throw new Error(
						"Implementation ended before the stale snapshot gate",
					);
				}),
			]);
			await expect(readFile(resolve(j.cwd, "queue.txt"), "utf8")).resolves.toBe(
				"Queue: ready\n",
			);
			await writeFile(resolve(j.cwd, "queue.txt"), external);
			gate.release.resolve();
			await expectStop(pending);
		} finally {
			await f.cancel(sessionId);
			gate.release.resolve();
			await pending;
		}
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "implementor"]),
		);
		expect(parseState(await f.checkpoint(sessionId)).inner).toMatchObject({
			standaloneRole: "implementor",
			engine: { command: "standalone", status: "completed", mode: "auto" },
		});
		const implemented = lastRequest(j.requests, "implementor").context;
		for (const id of [
			"create-queue",
			"create-counter",
			"edit-queue",
			"edit-counter",
			"fresh-workspace-edit",
			"overwrite-counter",
			"create-log",
			"edit-log",
		]) {
			expect(result(implemented, id), id).toMatchObject({ isError: false });
		}
		for (const id of [
			"stale-workspace-edit",
			"missing-workspace-snapshot",
			"private-workspace-write",
			"outside-workspace-write",
		]) {
			expect(result(implemented, id), id).toMatchObject({ isError: true });
		}
		expect(resultText(implemented, "stale-workspace-edit")).toBe(
			"Tool execution failed. Check current state before retrying changes. This error is not itself a permission denial.",
		);
		expect(snapshot(implemented, "fresh-queue")).not.toBe(
			snapshot(implemented, "before-external"),
		);
		for (const line of external.trim().split("\n")) {
			expect(resultText(implemented, "fresh-queue")).toContain(line);
		}
		await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
			"State: done\n",
		);
		await expectStop(
			f.prompt(
				sessionId,
				"Review the files, move the temporary log and save notes/review.md.",
			),
		);
		const reviewed = lastRequest(j.requests, "reviewer").context;
		for (const line of final.trim().split("\n")) {
			expect(resultText(reviewed, "review-queue")).toContain(line);
		}
		expect(resultText(reviewed, "review-counter")).toContain("Count: 2");
		expect(journeyPage(reviewed, "review-log").text).toBe("State: done\n");
		for (const id of ["move-log", "save-review"]) {
			expect(result(reviewed, id), id).toMatchObject({ isError: false });
		}
		await expect(readFile(resolve(vault, moved), "utf8")).resolves.toBe(
			"State: done\n",
		);
		await expect(readFile(resolve(vault, note))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expectStop(
			f.prompt(
				sessionId,
				"Audit the review, remove the temporary log and save notes/audit.md.",
			),
		);
		const audited = lastRequest(j.requests, "auditor").context;
		expect(journeyPage(audited, "audit-log").text).toBe("State: done\n");
		expect(journeyPage(audited, "audit-review").text).toBe(
			"Queue and counter verified.\n",
		);
		for (const id of ["remove-log", "save-audit"]) {
			expect(result(audited, id), id).toMatchObject({ isError: false });
		}
		await expect(readFile(resolve(vault, moved))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await Promise.all(
			[
				[resolve(j.cwd, "queue.txt"), final],
				[resolve(j.cwd, "counter.txt"), "Count: 2\n"],
				[resolve(vault, "notes/review.md"), "Queue and counter verified.\n"],
				[
					resolve(vault, "notes/audit.md"),
					"Review verified; temporary log removed.\n",
				],
				[privateFile, sentinel],
				[outside, sentinel],
			].map(async ([path, content]) => {
				await expect(readFile(path, "utf8")).resolves.toBe(content);
			}),
		);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(agentText(f.updates)).toContain("Audited the saved review");
		expect(JSON.stringify([j.requests, f.updates])).not.toContain(sentinel);
		expect(JSON.stringify(await f.saved(sessionId))).not.toMatch(
			/allow_scope|d3r:native:workspace-edits/,
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
