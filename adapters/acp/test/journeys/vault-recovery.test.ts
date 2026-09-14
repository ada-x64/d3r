import {
	expectStop,
	type JourneyScripts,
	JOURNEY_MODEL,
	JOURNEY_SUMMARY,
	journeyToolGate,
	journeyCall as call,
	journeyResult,
	journeyResultText,
	journeyPage,
	journeyText,
	journeyTools,
	journeyDone as done,
	callWith,
	lastRequest,
} from "./helpers.ts";

import { SEED_ROOT } from "@d3r/core/vault/seed-root";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeModelKey } from "../../../../cli/src/native-models.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	it.each(["failed", "cancelled"] as const)(
		"recovers a %s automatic vault mutation on /develop reload and protects an external edit with real read snapshots",
		// oxlint-disable-next-line max-statements -- Failed execution, cancellation and snapshot-safe recovery share the real workflow.
		async (failure) => {
			const scripts: JourneyScripts = {};
			const publication = journeyToolGate("publish-log");
			const edit = journeyToolGate("stale-edit");
			const j = await open(scripts, {
				workspace: "repo/worktrees/topic",
				streamResponse: (_role, content, settings) =>
					content.some(
						(part) => part.type === "toolCall" && part.id === "stale-edit",
					)
						? edit.stream(content, settings?.signal)
						: publication.stream(content, settings?.signal),
				readTextFile: async ({ path }) => {
					throw new Error(
						`Zed cannot open vault files outside the worktree: ${path}`,
					);
				},
			});
			const vault = resolve(j.root, "repo/.agents/vault");
			await cp(SEED_ROOT, vault, { recursive: true });
			const note = "notes/queue.md";
			const original = "# Queue\nState: pending\n";
			const external = `${original}User added this line after the model read.\n`;
			const edited = external.replace("pending", "ready");
			const artifact = "process/tasks/offline-queue/implementation-log.md";
			const parent = resolve(vault, "process/tasks/offline-queue");
			const contents = "# Implementation log\nQueue is ready.\n";
			const sentinel = "PRIVATE mutation sentinel must remain untouched";
			const outside = resolve(vault, "../outside.txt");
			await mkdir(resolve(vault, ".git"));
			await Promise.all([
				writeFile(resolve(vault, note), original),
				writeFile(
					resolve(vault, "notes/occupied.md"),
					"Existing destination\n",
				),
				writeFile(outside, sentinel),
				writeFile(resolve(vault, ".git/private.txt"), sentinel),
			]);
			const write = call(
				"vault_write",
				{ mode: "raw", path: artifact, contents },
				"publish-log",
			);
			scripts.implementor = [
				call("vault_read", { path: note }, "before-denial"),
				write,
				...done(
					"Vault publication failed; preserve the saved note.",
					{
						status: "blocked",
					},
					"No vault mutation was made.",
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
			const request =
				"/develop Update the saved queue note and write an implementation log in the parent vault.";
			await expectStop(f.prompt(sessionId, request));
			expect(journeyText(f.updates)).toContain("Choose develop mode");
			const pending = f.prompt(sessionId, "auto");
			try {
				await Promise.race([
					publication.reached.promise,
					pending.then(() => {
						throw new Error(
							"Develop ended before the publication provider gate",
						);
					}),
				]);
				expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
					expect.stringMatching(/^Trust workspace/),
				]);
				await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(readFile(resolve(vault, artifact))).rejects.toMatchObject({
					code: "ENOENT",
				});
				if (failure === "cancelled") {
					await f.peer.agent.notify("session/cancel", { sessionId });
				} else {
					await writeFile(parent, "A file blocks the artifact directory.\n");
					publication.release.resolve();
				}
				await expectStop(
					pending,
					failure === "cancelled" ? "cancelled" : "end_turn",
				);
				if (failure === "failed") {
					await expect(readFile(parent, "utf8")).resolves.toBe(
						"A file blocks the artifact directory.\n",
					);
					await rm(parent);
				}
				// A late provider response cannot revive cancelled publication or create its parents.
				publication.release.resolve();
				await f.peer.agent.request("session/list", {});
				await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
					original,
				);
			} finally {
				await f.peer.agent.notify("session/cancel", { sessionId });
				publication.release.resolve();
				await pending;
			}
			const initial = lastRequest(j.requests, "implementor").context;
			expect(journeyPage(initial, "before-denial").text).toBe(original);
			if (failure === "failed") {
				expect(journeyResult(initial, "publish-log")).toMatchObject({
					isError: true,
				});
				expect(journeyResultText(initial, "publish-log")).toBe(
					"Tool execution failed. Check current state before retrying changes. This error is not itself a permission denial.",
				);
			}
			expect(
				journeyTools(f.updates).filter(
					({ status, kind }) => status === "completed" && kind === "edit",
				),
			).toEqual([]);
			const beforeReload = j.requests.length;
			const permissionsBefore = j.permissions.length;
			await f.close();
			const resumed = await j.connect();
			await resumed.peer.agent.request("session/load", {
				sessionId,
				cwd: j.cwd,
				mcpServers: [],
			});
			expect(j.requests).toHaveLength(beforeReload);
			expect(j.permissions).toHaveLength(permissionsBefore);
			await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
			const loaded = await resumed.state(sessionId);
			const retained = loaded.inner!.engine;
			await expectStop(
				resumed.prompt(sessionId, failure === "failed" ? "continue" : "status"),
			);
			expect(j.requests.slice(beforeReload).map(({ role }) => role)).toEqual([
				"router",
				"router",
			]);
			const unchanged = await resumed.state(sessionId);
			expect(unchanged.inner!.engine).toEqual(retained);
			expect(
				journeyResult(
					j.requests.at(-1)!.context,
					failure === "failed" ? "d3r_continue_phase" : "d3r_phase_status",
				),
			).toMatchObject({ isError: failure === "failed" });
			scripts.implementor = [
				call("vault_read", { path: note }, "stale-read"),
				callWith(
					"vault_edit",
					(context) => ({
						path: note,
						find: "pending",
						replace: "ready",
						snapshot: journeyPage(context, "stale-read").snapshot,
					}),
					"stale-edit",
				),
				call("vault_read", { path: note }, "fresh-read"),
				callWith(
					"vault_edit",
					(context) => ({
						path: note,
						find: "pending",
						replace: "ready",
						snapshot: journeyPage(context, "fresh-read").snapshot,
					}),
					"fresh-edit",
				),
				call("vault_read", { path: note }, "edited-read"),
				(context) => {
					const { snapshot } = journeyPage(context, "edited-read");
					return [
						...call(
							"vault_write",
							{
								mode: "raw",
								path: note,
								contents: "Clobbered without a snapshot",
							},
							"missing-snapshot",
						),
						...call(
							"vault_mv",
							{ from: note, to: "notes/occupied.md", snapshot },
							"occupied-move",
						),
						...call(
							"vault_mv",
							{
								from: note,
								to: "notes/occupied.md",
								snapshot,
								overwrite: true,
							},
							"overwrite-move",
						),
						...call(
							"vault_mv",
							{ from: "notes", to: "moved-notes", snapshot },
							"directory-move",
						),
						...call(
							"vault_rm",
							{ path: "notes", snapshot },
							"directory-remove",
						),
						...call(
							"vault_rm",
							{ path: "notes", snapshot, recursive: true },
							"recursive-remove",
						),
						...call(
							"vault_write",
							{
								mode: "raw",
								path: resolve(vault, "../absolute-escape/new.md"),
								contents: "Escaped",
							},
							"absolute-write",
						),
						...call(
							"vault_write",
							{
								mode: "raw",
								path: "../traversal-escape/new.md",
								contents: "Escaped",
							},
							"traversal-write",
						),
						...call(
							"vault_write",
							{
								mode: "raw",
								path: ".git/private-escape/new.md",
								contents: "Escaped",
							},
							"private-write",
						),
						...call(
							"vault_write",
							{
								mode: "raw",
								path: "root-escape/new.md",
								root: resolve(vault, ".."),
								contents: "Escaped",
							},
							"root-write",
						),
					];
				},
				write,
				...done(
					"Updated the queue note without losing the user's external edit.",
					{},
					"Implementation complete.",
				),
			];
			scripts.reviewer = [
				call("vault_read", { path: note }, "review-note"),
				call("vault_read", { path: artifact }, "review-log"),
				...done(
					"Verified both saved vault artifacts.",
					{
						review: "approved",
					},
					"Review approved.",
				),
			];
			scripts.auditor = [
				call("vault_read", { path: note }, "audit-note"),
				...done(
					"The external edit is preserved on disk.",
					{},
					"Audit complete.",
				),
			];
			if (failure === "failed") {
				await expectStop(resumed.prompt(sessionId, "abandon"));
				await expectStop(resumed.prompt(sessionId, request));
			}
			const recoveryRequests = j.requests.length;
			const recovery = resumed.prompt(
				sessionId,
				failure === "failed" ? "auto" : "continue",
			);
			try {
				await Promise.race([
					edit.reached.promise,
					recovery.then(() => {
						throw new Error(
							"Recovery ended before the stale edit provider gate",
						);
					}),
				]);
				await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
					original,
				);
				await writeFile(resolve(vault, note), external);
				edit.release.resolve();
				await expectStop(recovery);
			} finally {
				await resumed.peer.agent.notify("session/cancel", { sessionId });
				edit.release.resolve();
				await recovery;
			}
			const resumedImplementor = j.requests
				.slice(recoveryRequests)
				.find(({ role }) => role === "implementor")!.context;
			if (failure === "cancelled") {
				expect(journeyPage(resumedImplementor, "before-denial").text).toBe(
					original,
				);
				expect(
					journeyResult(resumedImplementor, "publish-log"),
				).toBeUndefined();
			}
			expect(j.requests.some(({ role }) => role === "summary")).toBe(false);
			const implementor = lastRequest(j.requests, "implementor").context;
			const reviewer = lastRequest(j.requests, "reviewer").context;
			const auditor = lastRequest(j.requests, "auditor").context;
			expect(journeyPage(implementor, "stale-read").text).toBe(original);
			expect(journeyResult(implementor, "stale-edit")).toMatchObject({
				isError: true,
			});
			expect(JSON.stringify(journeyResult(implementor, "stale-edit"))).toMatch(
				/snapshot|changed|stale/i,
			);
			expect(journeyPage(implementor, "fresh-read").text).toBe(external);
			expect(journeyPage(implementor, "fresh-read").snapshot).not.toBe(
				journeyPage(implementor, "stale-read").snapshot,
			);
			expect(journeyResult(implementor, "fresh-edit")).toMatchObject({
				isError: false,
			});
			expect(journeyPage(implementor, "edited-read").text).toBe(edited);
			for (const id of [
				"missing-snapshot",
				"occupied-move",
				"overwrite-move",
				"directory-move",
				"directory-remove",
				"recursive-remove",
				"absolute-write",
				"traversal-write",
				"private-write",
				"root-write",
			]) {
				expect(journeyResult(implementor, id), id).toMatchObject({
					isError: true,
				});
			}
			expect(journeyPage(reviewer, "review-note").text).toBe(edited);
			expect(journeyPage(reviewer, "review-log").text).toBe(contents);
			expect(journeyPage(auditor, "audit-note").text).toBe(edited);
			for (const context of [initial, implementor]) {
				expect(context.systemPrompt).toContain(vault);
				expect(context.systemPrompt).toMatch(/vault-relative paths/);
				expect(context.tools?.map(({ name }) => name)).toEqual(
					expect.arrayContaining([
						"vault_read",
						"vault_ls",
						"vault_find",
						"vault_write",
						"vault_edit",
						"vault_mv",
						"vault_rm",
						"vault_lint",
					]),
				);
				expect(context.tools?.map(({ name }) => name)).not.toContain(
					"vault_init",
				);
				for (const name of ["vault_edit", "vault_mv", "vault_rm"]) {
					expect(
						context.tools?.find((tool) => tool.name === name)?.parameters,
					).toMatchObject({ required: expect.arrayContaining(["snapshot"]) });
				}
			}
			for (const tool of initial.tools?.filter(({ name }) =>
				name.startsWith("vault_"),
			) ?? []) {
				expect(
					implementor.tools?.find(({ name }) => name === tool.name)?.parameters,
				).toEqual(tool.parameters);
			}
			expect(
				j.permissions
					.slice(permissionsBefore)
					.map(({ toolCall }) => toolCall.title),
			).toEqual([expect.stringMatching(/^Trust workspace/)]);
			expect(
				j.permissions.some(({ toolCall }) =>
					toolCall.title?.startsWith("vault_"),
				),
			).toBe(false);
			const effects = journeyTools(resumed.updates)
				.filter(({ status }) => status === "completed")
				.flatMap(
					({ content }) =>
						content?.filter((part) => part.type === "diff") ?? [],
				);
			expect(effects).toEqual(
				expect.arrayContaining([
					{
						type: "diff",
						path: resolve(vault, note),
						oldText: external,
						newText: edited,
					},
					{
						type: "diff",
						path: resolve(vault, artifact),
						oldText: null,
						newText: contents,
					},
				]),
			);
			expect(effects).toHaveLength([note, artifact].length);
			await expect(readFile(resolve(vault, note), "utf8")).resolves.toBe(
				edited,
			);
			await expect(readFile(resolve(vault, artifact), "utf8")).resolves.toBe(
				contents,
			);
			await expect(
				readFile(resolve(vault, "notes/occupied.md"), "utf8"),
			).resolves.toBe("Existing destination\n");
			await expect(readFile(outside, "utf8")).resolves.toBe(sentinel);
			await expect(
				readFile(resolve(vault, ".git/private.txt"), "utf8"),
			).resolves.toBe(sentinel);
			await expect(
				readdir(resolve(vault, "moved-notes")),
			).rejects.toMatchObject({ code: "ENOENT" });
			await Promise.all(
				[
					"../absolute-escape",
					"../traversal-escape",
					".git/private-escape",
					"../root-escape",
					"root-escape",
				].map(async (path) => {
					await expect(readdir(resolve(vault, path))).rejects.toMatchObject({
						code: "ENOENT",
					});
				}),
			);
			await expect(readFile(resolve(j.cwd, artifact))).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(j.reads).toEqual([]);
			expect(
				JSON.stringify([j.requests, f.updates, resumed.updates]),
			).not.toContain(sentinel);
			expect(journeyText(resumed.updates)).toContain(JOURNEY_SUMMARY);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
			await resumed.peer.agent.request("session/close", { sessionId });
		},
	);
});
