import {
	expectStop,
	type JourneyScripts,
	journeyCall as call,
	journeyDone as done,
	journeyPhaseReply as phaseReply,
	journeyPage,
	journeyResult,
	journeyResultText,
	journeyText,
	journeyUserText,
	callWith,
	lastRequest,
	reply,
	writeFiles,
} from "./helpers.ts";

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { nativeJourneySuite } from "./harness.ts";

describe("native ACP routing preference journeys", () => {
	const { open } = nativeJourneySuite();

	it("chooses a different phase from the picker without starting the preferred chain", async () => {
		const goal =
			"Plan the implementation from our conversation, without a design phase or document writes.";
		const scripts: JourneyScripts = {
			router: [
				call("d3r_start_phase", {
					phase: "delegate",
					brief: {
						goal,
						context: "Add an offline FIFO queue.",
						acceptanceCriteria: ["Return an inline plan and task schema."],
					},
				}),
				phaseReply("d3r_start_phase", "Plan ready"),
			],
			planner: done("Plan: implement the queue and test FIFO behavior."),
			schemer: done(
				"Task: add the queue and regression tests; preserve insertion order.",
			),
		};
		const j = await open(scripts, { routerShortcuts: false });
		const f = await j.connect();
		const { sessionId } = await f.session();
		await f.configure(sessionId, "phase", "design");
		await expectStop(f.prompt(sessionId, goal));
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "planner", "schemer"]),
		);
		expect(journeyUserText(j.requests[0].context)).toContain(
			"Preferred phase: design (routing preference, not a requirement)",
		);
		const { context } = lastRequest(j.requests, "router");
		expect(journeyResult(context, "d3r_start_phase")).toMatchObject({
			isError: false,
		});
		expect(await f.state(sessionId)).toMatchObject({
			inner: { engine: { command: "delegate", status: "completed" } },
		});
		expect(journeyText(f.updates)).toContain("Plan ready");
		expect(scripts).toEqual({ router: [], planner: [], schemer: [] });
	});

	it.each([
		{ phase: "routing", reload: false },
		{ phase: "design", reload: false },
		{ phase: "design", reload: true },
	])(
		"cleans the vault directly with $phase selected (reload: $reload)",
		// oxlint-disable-next-line max-statements -- Selection, optional reload and snapshot-backed cleanup share one real ACP journey.
		async ({ phase, reload }) => {
			const old = "# Obsolete note\nSafe to delete at the user's request.\n";
			const keep = "# Current note\nKeep this content unchanged.\n";
			const summary = "Removed notes/old.md; notes/keep.md is unchanged.";
			const scripts: JourneyScripts = {
				router: [
					call("vault_ls", { path: "notes" }),
					call("vault_read", { path: "notes/old.md" }),
					callWith("vault_rm", (context) => ({
						path: "notes/old.md",
						snapshot: journeyPage(context, "vault_read").snapshot,
					})),
					reply(summary),
				],
			};
			const j = await open(scripts, {
				workspace: "repo/worktrees/topic",
				routerShortcuts: false,
			});
			const vault = resolve(j.root, "repo/.agents/vault");
			await writeFiles(vault, { "notes/old.md": old, "notes/keep.md": keep });
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
			let f = await j.connect();
			const { sessionId } = await f.session();
			await f.configure(sessionId, "phase", phase);
			if (reload) {
				await f.close();
				f = await j.connect();
				await f.load(sessionId);
			}
			expect(j.requests).toEqual([]);
			expect(j.permissions).toEqual([]);
			expect(await f.state(sessionId)).toMatchObject({ phase, inner: null });
			const request =
				"Clean the vault: list notes, read notes/old.md, then delete it. Leave notes/keep.md unchanged.";
			await expectStop(f.prompt(sessionId, request));

			await expect(
				readFile(resolve(vault, "notes/old.md")),
			).rejects.toMatchObject({
				code: "ENOENT",
			});
			await expect(
				readFile(resolve(vault, "notes/keep.md"), "utf8"),
			).resolves.toBe(keep);
			expect(await readdir(resolve(vault, "notes"))).toEqual(["keep.md"]);
			expect(journeyText(f.updates)).toBe(summary);
			expect(new Set(j.requests.map(({ role }) => role))).toEqual(
				new Set(["router"]),
			);
			expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
			]);
			expect(await f.state(sessionId)).toMatchObject({
				phase,
				inner: { phase, engine: null, orchestrated: true },
			});
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			expect(scripts.router).toEqual([]);

			const { context } = lastRequest(j.requests, "router");
			expect(journeyPage(context, "vault_read").text).toBe(old);
			expect(JSON.parse(journeyResultText(context, "vault_ls"))).toMatchObject({
				entries: expect.arrayContaining([
					expect.objectContaining({ name: "old.md", kind: "file" }),
					expect.objectContaining({ name: "keep.md", kind: "file" }),
				]),
			});
			expect(
				context.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => message.toolName),
			).toEqual(["vault_ls", "vault_read", "vault_rm"]);
			for (const name of ["vault_ls", "vault_read", "vault_rm"]) {
				expect(journeyResult(context, name)).toMatchObject({ isError: false });
			}
			for (const { context: observed } of j.requests) {
				expect(journeyUserText(observed)).toContain(request);
				expect(journeyUserText(observed)).toContain(
					`Preferred phase: ${phase} (routing preference, not a requirement)`,
				);
				expect(observed.tools?.map(({ name }) => name)).toEqual(
					expect.arrayContaining([
						"vault_ls",
						"vault_read",
						"vault_find",
						"vault_write",
						"vault_edit",
						"vault_mv",
						"vault_rm",
						"vault_lint",
					]),
				);
				expect(observed.systemPrompt).toContain(vault);
				expect(observed.systemPrompt).toMatch(
					/routing preference, not a requirement/i,
				);
				expect(observed.systemPrompt).toMatch(
					/Handle routine vault maintenance directly/i,
				);
			}
		},
	);

	// oxlint-disable-next-line max-statements -- Initialized reload, unrelated cleanup and retained worker state form one acceptance journey.
	it("cleans an unrelated vault note after reloading a paused reviewer without advancing its workflow", async () => {
		const goal =
			"Review notes/keep.md; ask me for its retention limit before deciding, and do not modify files.";
		const question = "How many hours should these notes be retained?";
		const old = "# Obsolete note\nUnrelated to the pending retention review.\n";
		const keep = "# Retention policy\nRetention limit: undecided.\n";
		const summary =
			"Removed notes/old.md. The retention review remains paused.";
		const scripts: JourneyScripts = {
			router: [
				call("d3r_run_role", {
					role: "reviewer",
					brief: {
						goal,
						context: "The retention limit has not been decided.",
						acceptanceCriteria: [
							"Ask for the missing limit; do not invent one.",
						],
					},
				}),
				phaseReply("d3r_run_role", "Retention decision needed"),
				call("vault_read", { path: "notes/old.md" }),
				callWith("vault_rm", (context) => ({
					path: "notes/old.md",
					snapshot: journeyPage(context, "vault_read").snapshot,
				})),
				reply(summary),
			],
			reviewer: [
				call("vault_read", { path: "notes/keep.md" }, "review-note"),
				...done(question, { status: "needs_human" }),
			],
		};
		const j = await open(scripts, {
			workspace: "repo/worktrees/topic",
			routerShortcuts: false,
		});
		const vault = resolve(j.root, "repo/.agents/vault");
		await writeFiles(vault, { "notes/old.md": old, "notes/keep.md": keep });
		j.approval.decide = async ({ toolCall }) =>
			toolCall.title?.startsWith("Trust workspace") === true;
		const f = await j.connect();
		const { sessionId } = await f.session();
		await f.configure(sessionId, "phase", "design");
		await expectStop(f.prompt(sessionId, goal));
		const saved = await f.state(sessionId);
		const waiting = saved.inner!;
		expect(waiting).toMatchObject({
			standaloneRole: "reviewer",
			topic: expect.any(String),
			engine: {
				command: "standalone",
				status: "waiting",
				pause: { kind: "report", message: question },
			},
		});
		expect(waiting.continuations).toHaveLength(1);
		expect(journeyText(f.updates)).toContain(question);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		const beforeReload = {
			requests: j.requests.length,
			permissions: j.permissions.length,
		};
		await f.closeSession(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		await expect(resumed.state(sessionId)).resolves.toEqual(saved);
		expect(j.requests).toHaveLength(beforeReload.requests);
		expect(j.permissions).toHaveLength(beforeReload.permissions);
		const start = resumed.updates.length;
		const request =
			"Unrelated cleanup: read notes/old.md and delete it. Leave notes/keep.md and the paused review unchanged; do not resume or abandon it.";
		await expectStop(resumed.prompt(sessionId, request));
		const cleanup = j.requests.slice(beforeReload.requests);
		expect(cleanup.map(({ role }) => role)).toEqual([
			"router",
			"router",
			"router",
		]);
		const { context } = lastRequest(cleanup, "router");
		expect(
			context.messages
				.slice(cleanup[0].context.messages.length)
				.flatMap((message) =>
					message.role === "assistant" ? message.content : [],
				)
				.filter((part) => part.type === "toolCall")
				.map(({ name }) => name),
		).toEqual(["vault_read", "vault_rm"]);
		expect(journeyPage(context, "vault_read").text).toBe(old);
		expect(journeyResult(context, "vault_rm")).toMatchObject({
			isError: false,
		});
		await expect(
			readFile(resolve(vault, "notes/old.md")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			readFile(resolve(vault, "notes/keep.md"), "utf8"),
		).resolves.toBe(keep);
		expect(journeyText(resumed.updates.slice(start))).toBe(summary);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		const after = await resumed.state(sessionId);
		for (const key of [
			"engine",
			"topic",
			"continuations",
			"standaloneRole",
			"phase",
			"input",
		] as const) {
			expect(after.inner![key], key).toEqual(waiting[key]);
		}
		for (const { context: observed } of cleanup) {
			expect(journeyUserText(observed)).toContain(request);
			expect(journeyUserText(observed)).toContain(question);
			expect(observed.tools?.map(({ name }) => name)).toEqual(
				expect.arrayContaining(["vault_read", "vault_rm"]),
			);
			expect(observed.systemPrompt).toContain(vault);
			expect(observed.systemPrompt).toMatch(
				/routing preference, not a requirement/i,
			);
			expect(observed.systemPrompt).toMatch(
				/Handle routine vault maintenance directly/i,
			);
		}
		expect(scripts).toEqual({ router: [], reviewer: [] });
	});
});
