import {
	expectStop,
	type JourneyScripts,
	JOURNEY_MODEL,
	JOURNEY_SUMMARY,
	journeyCall as call,
	journeyResult,
	journeyPage,
	journeyText,
	journeyToolText,
	journeyTools,
	journeyDone as done,
	callWith,
	roleRequests,
	lastRequest,
} from "./helpers.ts";

import { SEED_ROOT } from "@d3r/core/vault/seed-root";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeModelKey } from "../../../../cli/src/native-models.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	// oxlint-disable-next-line max-statements -- Discovery, editor ownership and renewed trust belong to one persisted research journey.
	it("researches an ancestor vault from a nested worktree and reloads it without widening trust or opening search hits", async () => {
		const scripts: JourneyScripts = {};
		const editorText = "Unsaved editor brief: keep the queue local.\n";
		const j = await open(scripts, {
			workspace: "repo/worktrees/topic",
			readTextFile: async ({ path }) => {
				if (path !== resolve(j.cwd, "brief.txt")) {
					throw new Error(`Editor cannot open this file: ${path}`);
				}
				return { content: editorText };
			},
		});
		const vault = resolve(j.root, "repo/.agents/vault");
		const note = resolve(vault, "notes/queue.md");
		const prior = resolve(vault, "notes/prior.md");
		const local = resolve(j.cwd, "brief.txt");
		const source = resolve(j.cwd, "queue.ts");
		const outside = resolve(j.root, "repo/unrelated.txt");
		const diskNote =
			"# Prior design\nqueue survives restarts\nqueue needs no service\n";
		const diskBrief = "# Saved brief\nqueue disk requirement\n";
		await mkdir(resolve(vault, "notes"), { recursive: true });
		await Promise.all([
			writeFile(note, diskNote),
			writeFile(prior, "queue uses an append-only log\n"),
			writeFile(local, diskBrief),
			writeFile(source, "// queue implementation\n// queue recovery\n"),
			writeFile(outside, "Unrelated parent data must never reach the model."),
		]);
		const recon = (summary: string) => [
			call("search", { path: vault, query: "queue" }),
			call("search", { path: ".", query: "queue" }),
			call("read_file", { path: note }),
			call("read_file", { path: "brief.txt" }),
			call("read_file", { path: "../../unrelated.txt" }),
			...done(summary),
		];
		scripts.aggregator = recon("The vault says the queue survives restarts.");
		scripts.researcher = recon("The saved queue uses an append-only log.");
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const request =
			"/design Research the local queue; report in chat, no files needed.";
		j.approval.decide = async () => false;
		await expectStop(f.prompt(sessionId, request));
		expect(journeyText(f.updates)).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toEqual([]);
		expect(j.reads).toEqual([]);
		j.approval.decide = async () => true;
		await expectStop(f.prompt(sessionId, request));
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "aggregator", "researcher"]),
		);
		const vaultHits = [
			`${note}:2: queue survives restarts`,
			`${note}:3: queue needs no service`,
			`${prior}:1: queue uses an append-only log`,
		];
		const workspaceHits = [
			`${local}:2: queue disk requirement`,
			`${source}:1: // queue implementation`,
			`${source}:2: // queue recovery`,
		];
		for (const role of ["aggregator", "researcher"]) {
			const [
				initial,
				vaultSearch,
				workspaceSearch,
				noteRead,
				localRead,
				outsideRead,
			] = roleRequests(j.requests, role).map(({ context }) => context);
			expect(initial.systemPrompt).toContain(vault);
			for (const [context, hits] of [
				[vaultSearch, vaultHits],
				[workspaceSearch, workspaceHits],
			] as const) {
				expect(context.messages.at(-1)).toMatchObject({
					toolName: "search",
					isError: false,
				});
				for (const hit of hits) {
					expect(context.messages.at(-1)).toMatchObject({
						content: expect.arrayContaining([
							{ type: "text", text: expect.stringContaining(hit) },
						]),
					});
				}
				expect(JSON.stringify(context.messages.at(-1))).not.toContain(
					"Unsaved editor brief",
				);
			}
			expect(noteRead.messages.at(-1)).toMatchObject({
				toolName: "read_file",
				isError: false,
			});
			expect(JSON.stringify(noteRead.messages.at(-1))).toContain(
				"queue survives restarts",
			);
			expect(localRead.messages.at(-1)).toMatchObject({
				toolName: "read_file",
				isError: false,
			});
			expect(JSON.stringify(localRead.messages.at(-1))).toContain(
				editorText.trim(),
			);
			expect(JSON.stringify(localRead.messages.at(-1))).not.toContain(
				"queue disk requirement",
			);
			expect(outsideRead.messages.at(-1)).toMatchObject({
				toolName: "read_file",
				isError: true,
			});
		}
		expect(JSON.stringify(j.requests)).not.toContain(
			"Unrelated parent data must never reach the model.",
		);
		expect(j.reads.map(({ path }) => path)).toEqual([local, local]);
		const searches = journeyTools(f.updates).filter(
			({ kind }) => kind === "search",
		);
		expect(searches.length).toBeGreaterThan(0);
		for (const search of searches) {
			expect(search.locations ?? []).toEqual([]);
		}
		const completedSearches = searches.filter(
			({ status }) => status === "completed",
		);
		for (const hits of [vaultHits, workspaceHits]) {
			const matching = completedSearches.filter((tool) =>
				hits.every((hit) => journeyToolText(tool).includes(hit)),
			);
			expect(matching.map(({ toolCallId }) => toolCallId)).toHaveLength(
				["aggregator", "researcher"].length,
			);
		}
		expect(journeyTools(f.updates)).toContainEqual(
			expect.objectContaining({
				status: "completed",
				locations: expect.arrayContaining([{ path: local, line: 1 }]),
				content: expect.arrayContaining([
					expect.objectContaining({
						type: "content",
						content: {
							type: "text",
							text: expect.stringContaining(editorText.trim()),
						},
					}),
				]),
			}),
		);
		await expect(readFile(local, "utf8")).resolves.toBe(diskBrief);
		await expect(readFile(note, "utf8")).resolves.toBe(diskNote);
		const beforeReload = j.requests.length;
		const readsBefore = j.reads.length;
		const permissionsBefore = j.permissions.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const renewedNote = "queue reload uses the same vault on disk";
		await writeFile(note, `${diskNote}${renewedNote}\n`);
		scripts.designer = [
			call("read_file", { path: note }),
			...done(
				renewedNote,
				{},
				"Keep the local append-only queue; no design file was requested.",
			),
		];
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(journeyText(resumed.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.permissions).toHaveLength(permissionsBefore);
		j.approval.decide = async () => false;
		const answer =
			"Keep the queue local. Re-read the vault note and finish with a report only.";
		const deniedStart = resumed.updates.length;
		await expectStop(resumed.prompt(sessionId, answer));
		expect(journeyText(resumed.updates.slice(deniedStart))).toMatch(
			/workspace.*permission.*not granted/i,
		);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.reads).toHaveLength(readsBefore);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		j.approval.decide = async () => true;
		await expectStop(resumed.prompt(sessionId, answer));
		const continuation = j.requests.slice(beforeReload);
		expect(new Set(continuation.map(({ role }) => role))).toEqual(
			new Set(["router", "designer"]),
		);
		expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
		const designer = roleRequests(continuation, "designer");
		expect(designer[0].context.systemPrompt).toContain(vault);
		expect(JSON.stringify(designer[0].context.messages)).toContain(
			"The vault says the queue survives restarts.",
		);
		expect(JSON.stringify(designer[0].context.messages)).toContain(
			"The saved queue uses an append-only log.",
		);
		expect(designer[1].context.messages.at(-1)).toMatchObject({
			toolName: "read_file",
			isError: false,
		});
		expect(JSON.stringify(designer[1].context.messages.at(-1))).toContain(
			renewedNote,
		);
		expect(j.reads).toHaveLength(readsBefore);
		expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		for (const { toolCall } of j.permissions) {
			expect(toolCall.title).toMatch(/^Trust workspace/);
			const preview = journeyToolText(toolCall);
			for (const text of [
				JSON.stringify(j.cwd),
				JSON.stringify(vault),
				"not its parent directory",
				"disk IO, not editor buffers",
				"Native vault operations need no additional approval",
				"commands remain separately authorized",
				"Trust is not saved",
			]) {
				expect(preview).toContain(text);
			}
		}
		expect(j.permissions.slice(permissionsBefore)).toHaveLength(
			["denied", "allowed"].length,
		);
		await expect(readFile(local, "utf8")).resolves.toBe(diskBrief);
		await expect(readFile(outside, "utf8")).resolves.toBe(
			"Unrelated parent data must never reach the model.",
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});

	// oxlint-disable-next-line max-statements -- Vault reads, permissions and reloading form one document journey.
	it("writes remember.md from the real parent vault template and reads it after a fresh /design session load", async () => {
		const scripts: JourneyScripts = {};
		const j = await open(scripts, {
			workspace: "repo/worktrees/topic",
			readTextFile: async ({ path }) => {
				if (path !== resolve(j.cwd, "brief.txt")) {
					throw new Error(`Zed refuses out-of-root reads: ${path}`);
				}
				return { content: "Unsaved brief: preserve offline jobs." };
			},
		});
		const vault = resolve(j.root, "repo/.agents/vault");
		await cp(SEED_ROOT, vault, { recursive: true });
		const templatePath = ".misc/templates/remember.md";
		const pageSize = 256;
		const template = await readFile(resolve(vault, templatePath), "utf8");
		const priorPath = ".misc/archive/prior-queue.md";
		const prior = "Prior queue fact: jobs survive restarts.\n";
		const outside = resolve(j.root, "repo/.agents/outside.txt");
		const sentinel = "PRIVATE outside-vault sentinel must never reach a model";
		await mkdir(resolve(vault, ".git"));
		await Promise.all([
			writeFile(resolve(vault, priorPath), prior),
			writeFile(outside, sentinel),
			writeFile(resolve(vault, ".git/private.txt"), sentinel),
			writeFile(
				resolve(j.cwd, "brief.txt"),
				"Saved brief, not the editor buffer.",
			),
		]);
		const artifact = "process/designs/offline-queue/recon/remember.md";
		const body =
			"# Remember: offline-queue\n\n## 1. Prior behavior\n\n**Source:** [[.misc/archive/prior-queue]]\n\nJobs survive restarts.\n";
		const document = `---\ncreated: 2026-09-09\nstatus: draft\nkind: remember\n---\n${body}`;
		scripts.aggregator = [
			call(
				"vault_read",
				{ path: templatePath, limit: pageSize },
				"template-first",
			),
			callWith(
				"vault_read",
				(context) => ({
					path: templatePath,
					offset: journeyPage(context, "template-first").nextOffset,
				}),
				"template-rest",
			),
			call("vault_ls", { path: ".misc" }),
			call("vault_find", {
				glob: ".misc/archive/**",
				query: "Prior queue fact",
			}),
			call("vault_read", { path: priorPath }, "prior"),
			call("read_file", { path: "brief.txt" }),
			call("vault_write", {
				mode: "doc",
				path: artifact,
				kind: "remember",
				frontmatter: { created: "2026-09-09", status: "draft" },
				body,
			}),
			...done(
				`Saved factual recon in ${artifact}.`,
				{},
				"Remember artifact saved in the vault.",
			),
		];
		scripts.researcher = [
			call("vault_read", { path: templatePath }, "research-template"),
			callWith(
				"vault_edit",
				(context) => ({
					path: templatePath,
					find: "Remember",
					replace: "Tampered",
					snapshot: journeyPage(context, "research-template").snapshot,
				}),
				"forbidden-edit",
			),
			[
				...call("vault_read", { path: outside }, "absolute-read"),
				...call("vault_read", { path: "../outside.txt" }, "traversal-read"),
				...call("vault_read", { path: ".git/private.txt" }, "private-read"),
				...call(
					"vault_read",
					{ path: "outside.txt", root: resolve(vault, "..") },
					"root-read",
				),
			],
			...done(
				"Research used the real remember template without modifying it.",
				{},
				"Research complete.",
			),
		];
		scripts.designer = [
			call("vault_read", { path: artifact }, "remember-reloaded"),
			call("vault_lint", { paths: [artifact] }),
			...done(
				"Used the saved remember artifact to design the offline queue.",
				{},
				"Design complete using the persisted recon.",
			),
		];
		j.approval.decide = async ({ toolCall }) =>
			toolCall.title?.startsWith("Trust workspace") === true;
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		await expectStop(
			f.prompt(
				sessionId,
				"/design Read .misc/templates/remember.md with vault_read and save factual recon as process/designs/offline-queue/recon/remember.md in the vault.",
			),
		);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
		await expect(readFile(resolve(vault, artifact), "utf8")).resolves.toBe(
			document,
		);
		expect(journeyTools(f.updates)).toContainEqual(
			expect.objectContaining({
				status: "completed",
				content: expect.arrayContaining([
					{
						type: "diff",
						path: resolve(vault, artifact),
						oldText: null,
						newText: document,
					},
				]),
			}),
		);
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		const aggregator = lastRequest(j.requests, "aggregator").context;
		const researcher = lastRequest(j.requests, "researcher").context;
		const first = journeyPage(aggregator, "template-first");
		const rest = journeyPage(aggregator, "template-rest");
		expect(first).toMatchObject({
			path: templatePath,
			text: template.slice(0, pageSize),
			truncated: true,
			nextOffset: pageSize,
			snapshot: expect.any(String),
		});
		expect(rest).toMatchObject({
			path: templatePath,
			truncated: false,
			snapshot: first.snapshot,
		});
		expect(first.text + rest.text).toBe(template);
		expect(journeyPage(researcher, "research-template").text).toBe(template);
		expect(journeyPage(aggregator, "prior").text).toBe(prior);
		for (const [id, text] of [
			["vault_ls", "templates"],
			["vault_find", priorPath],
		]) {
			expect(journeyResult(aggregator, id)).toMatchObject({ isError: false });
			expect(JSON.stringify(journeyResult(aggregator, id))).toContain(text);
		}
		expect(JSON.stringify(journeyResult(aggregator, "read_file"))).toContain(
			"Unsaved brief",
		);
		for (const id of [
			"forbidden-edit",
			"absolute-read",
			"traversal-read",
			"private-read",
			"root-read",
		]) {
			expect(journeyResult(researcher, id), id).toMatchObject({
				isError: true,
			});
		}
		expect(researcher.tools?.map(({ name }) => name)).not.toContain(
			"vault_edit",
		);
		expect(aggregator.tools?.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"vault_read",
				"vault_ls",
				"vault_find",
				"vault_write",
				"vault_mv",
				"vault_rm",
				"vault_lint",
			]),
		);
		expect(
			aggregator.tools?.find(({ name }) => name === "vault_write")?.parameters,
		).toMatchObject({
			type: "object",
			required: expect.arrayContaining(["mode", "path"]),
			properties: {
				mode: { enum: expect.arrayContaining(["raw", "doc"]) },
				path: { type: "string" },
				contents: { type: "string" },
				kind: { type: "string" },
				body: { type: "string" },
				frontmatter: { type: "object" },
				snapshot: { type: "string" },
			},
		});
		const beforeReload = j.requests.length;
		const permissionsBefore = j.permissions.length;
		const checkpoint = await f.checkpoint(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.peer.agent.request("session/load", {
			sessionId,
			cwd: j.cwd,
			mcpServers: [],
		});
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(beforeReload);
		expect(j.permissions).toHaveLength(permissionsBefore);
		j.approval.decide = async () => true;
		await expectStop(
			resumed.prompt(
				sessionId,
				"Use the saved remember.md; finish the design in chat.",
			),
		);
		const designer = lastRequest(j.requests, "designer").context;
		expect(journeyPage(designer, "remember-reloaded")).toMatchObject({
			path: artifact,
			text: document,
			truncated: false,
		});
		const lint = journeyResult(designer, "vault_lint");
		expect(lint).toMatchObject({ isError: false });
		if (lint?.role !== "toolResult") {
			throw new Error("Missing vault lint result");
		}
		const lintText = lint.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("");
		expect(JSON.parse(lintText)).toMatchObject({
			findings: [{ path: artifact, kind: "remember", ok: true }],
			summary: { total: 1, ok: 1, failed: 0 },
			truncated: false,
			skipped: 0,
		});
		expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
		expect(
			j.permissions
				.slice(permissionsBefore)
				.map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		for (const { context } of j.requests.filter(
			({ role }) => role !== "summary",
		)) {
			expect(context.systemPrompt).toContain(vault);
			expect(context.systemPrompt).toMatch(/vault-relative paths/);
			expect(context.tools?.map(({ name }) => name)).not.toContain(
				"vault_init",
			);
			const calls = context.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((part) => part.type === "toolCall")
					: [],
			);
			expect(calls.map(({ name }) => name)).not.toContain("run_command");
		}
		expect(
			JSON.stringify([j.requests, f.updates, resumed.updates]),
		).not.toContain(sentinel);
		expect(j.reads.map(({ path }) => path)).toEqual([
			resolve(j.cwd, "brief.txt"),
		]);
		await expect(readFile(resolve(vault, templatePath), "utf8")).resolves.toBe(
			template,
		);
		await expect(readFile(outside, "utf8")).resolves.toBe(sentinel);
		await expect(
			readFile(resolve(vault, ".git/private.txt"), "utf8"),
		).resolves.toBe(sentinel);
		await expect(readFile(resolve(j.cwd, artifact))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			readdir(resolve(j.cwd, ".agents/vault")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.peer.agent.request("session/close", { sessionId });
	});
});
