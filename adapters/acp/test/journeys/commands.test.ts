import {
	expectStop,
	type JourneyScripts,
	JOURNEY_MODEL,
	JOURNEY_SUMMARY,
	journeyToolGate,
	journeyCall as call,
	journeyResult,
	journeyResultText,
	type JourneyDecision,
	journeyDone as done,
	journeyText,
	journeyToolText,
	journeyTools,
	reply,
	lastRequest,
	roleRequests,
} from "./helpers.ts";

import { type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeModelKey } from "../../../../cli/src/native-models.ts";
import { deferred } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	const permissionKinds = ["allow_once", "reject_once", "allow_always"];
	// oxlint-disable-next-line max-statements -- One thread covers denial, once, queued scope reuse, later work and fresh-session boundaries.
	it("grants all native commands only on always, including queued and later calls, and forgets grants on reload or a new session", async () => {
		const command = (id: string) =>
			call(
				"run_command",
				{
					command: process.execPath,
					args: [
						"-e",
						"require('node:fs').writeFileSync(process.argv[1], process.argv[2]);",
						`${id}.txt`,
						id,
					],
				},
				id,
			);
		const queued = journeyToolGate("queued-command");
		const scripts: JourneyScripts = {
			aggregator: [
				command("denied-command"),
				command("once-command"),
				command("scope-command"),
				command("later-command"),
				...done("Checked all authorized local probes."),
			],
			researcher: [
				command("queued-command"),
				...done("Ran the queued local probe."),
			],
			designer: done("Verified the local design after recon."),
			router: [
				command("next-turn-command"),
				reply("The final local probe completed."),
			],
		};
		const j = await open(scripts, {
			streamResponse: (_role, content, settings) =>
				queued.stream(content, settings?.signal),
		});
		const asked = deferred<RequestPermissionRequest>();
		const grant = deferred<JourneyDecision>();
		j.approval.decide = async (permission) => {
			if (permission.toolCall.title?.startsWith("Trust workspace")) {
				return true;
			}
			const input = permission.toolCall.rawInput as { args: string[] };
			if (input.args.at(-1) === "once-command") {
				return true;
			}
			if (input.args.at(-1) === "scope-command") {
				asked.resolve(permission);
				return grant.promise;
			}
			return false;
		};
		const f = await j.connect();
		const { sessionId } = await f.session();
		const pending = f.prompt(
			sessionId,
			"/design Probe the local queue with native commands, then discuss the design.",
		);
		try {
			const [permission] = await Promise.race([
				Promise.all([asked.promise, queued.reached.promise]),
				pending.then(() => {
					throw new Error("Recon ended before the command scope decision");
				}),
			]);
			expect(permission.options.map(({ kind }) => kind)).toEqual(
				permissionKinds,
			);
			expect(permission.options.at(-1)?.name).toBe(
				"Allow all command executions (not sandboxed) for this thread",
			);
			await expect(
				readFile(resolve(j.cwd, "denied-command.txt")),
			).rejects.toMatchObject({ code: "ENOENT" });
			await expect(
				readFile(resolve(j.cwd, "once-command.txt"), "utf8"),
			).resolves.toBe("once-command");
			queued.release.resolve();
			await vi.waitFor(() =>
				expect(
					journeyTools(f.updates).some(
						(row) =>
							row.sessionUpdate === "tool_call" &&
							(row.rawInput as { args?: string[] } | undefined)?.args?.at(
								-1,
							) === "queued-command",
					),
				).toBe(true),
			);
			await f.peer.agent.request("session/list", {});
			const commandPermissions = j.permissions.filter(
				({ toolCall }) => !toolCall.title?.startsWith("Trust workspace"),
			);
			expect(
				commandPermissions.map(({ toolCall }) =>
					(toolCall.rawInput as { args: string[] }).args.at(-1),
				),
			).toEqual(["denied-command", "once-command", "scope-command"]);
			await Promise.all(
				["scope-command", "queued-command", "later-command"].map(async (id) => {
					await expect(
						readFile(resolve(j.cwd, `${id}.txt`)),
					).rejects.toMatchObject({ code: "ENOENT" });
				}),
			);
			grant.resolve("allow_scope");
			await expectStop(pending);
		} finally {
			await f.cancel(sessionId);
			queued.release.resolve();
			grant.resolve(false);
			await pending;
		}
		await expectStop(f.prompt(sessionId, "Finish the design in chat."));
		await expectStop(
			f.prompt(
				sessionId,
				"Run one final local probe directly, without starting another phase.",
			),
		);
		const commands = [
			"once-command",
			"scope-command",
			"queued-command",
			"later-command",
			"next-turn-command",
		];
		await Promise.all(
			commands.map(async (id) => {
				await expect(
					readFile(resolve(j.cwd, `${id}.txt`), "utf8"),
				).resolves.toBe(id);
				const result = j.requests
					.map(({ context }) => journeyResult(context, id))
					.find(Boolean);
				expect(result, id).toMatchObject({ isError: false });
			}),
		);
		expect(j.permissions).toHaveLength(
			["trust", "denied", "once", "scope"].length,
		);
		expect(journeyText(f.updates)).toContain(JOURNEY_SUMMARY);
		const saved = await f.saved(sessionId);
		const beforeLoad = {
			requests: j.requests.length,
			permissions: j.permissions.length,
		};
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		expect(j.requests).toHaveLength(beforeLoad.requests);
		expect(j.permissions).toHaveLength(beforeLoad.permissions);
		const probeFresh = async (id: string, label: string) => {
			const before = j.permissions.length;
			scripts.aggregator = [
				command(label),
				...done("Denied probe left no effect."),
			];
			scripts.researcher = done("No other probe needed.");
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
			await expectStop(
				resumed.prompt(
					id,
					`/design Check ${label}; do not reuse past approvals.`,
				),
			);
			expect(
				j.permissions.slice(before).map(({ toolCall }) => toolCall.title),
			).toEqual([
				expect.stringMatching(/^Trust workspace/),
				expect.stringContaining("-e"),
			]);
			expect(j.permissions.at(-1)?.options.map(({ kind }) => kind)).toEqual(
				permissionKinds,
			);
			await expect(
				readFile(resolve(j.cwd, `${label}.txt`)),
			).rejects.toMatchObject({ code: "ENOENT" });
			const { context } = lastRequest(j.requests, "aggregator");
			expect(journeyResult(context, label)).toMatchObject({ isError: true });
			expect(journeyResultText(context, label)).toMatch(/permission.*denied/i);
		};
		await probeFresh(sessionId, "reloaded-command");
		const fresh = await resumed.session();
		await probeFresh(fresh.sessionId, "new-session-command");
		for (const state of [
			saved,
			await resumed.saved(sessionId),
			await resumed.saved(fresh.sessionId),
		]) {
			expect(JSON.stringify(state)).not.toMatch(
				/allow_scope|d3r:native:commands/,
			);
		}
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	it.each(["allowed", "denied", "cancelled"] as const)(
		"shows concise command approval before a real process is %s",
		// oxlint-disable-next-line max-statements -- Keep the pending permission, process effect and workflow outcome together.
		async (decision) => {
			const markerName = "marker file.txt";
			const literal = "literal value with spaces & no shell";
			const input = Object.freeze({
				command: process.execPath,
				args: Object.freeze([
					"-e",
					"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() })); console.log(process.argv[2]);",
					markerName,
					literal,
					"",
					"single'quote",
					'double"quote',
					String.raw`a\b`,
					"first\nsecond",
					"$(touch should-not-exist)",
					"last-safe-word",
				]),
				cwd: "command cwd",
				timeoutMs: 10_000,
			});
			const scripts: JourneyScripts = {
				aggregator: [
					call("run_command", input),
					...done(
						decision === "allowed"
							? "The local probe completed."
							: "The local probe was not authorized.",
						{},
						"Recon finished without further commands.",
					),
				],
				researcher: done(
					"No external research was needed.",
					{},
					"Research complete.",
				),
				designer: done("Use the local queue.", {}, "Design complete in chat."),
			};
			const j = await open(scripts);
			const cwd = resolve(j.cwd, input.cwd);
			const marker = resolve(cwd, markerName);
			await mkdir(cwd);
			const asked = deferred<RequestPermissionRequest>();
			const answer = deferred<boolean>();
			j.approval.decide = async (permission) => {
				if (permission.toolCall.title?.startsWith("Trust workspace")) {
					return true;
				}
				asked.resolve(permission);
				return answer.promise;
			};
			const f = await j.connect();
			const { sessionId } = await f.newSession(j.cwd);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(JOURNEY_MODEL),
			});
			const pending = f.prompt(
				sessionId,
				"/design Probe the local queue; a chat report is sufficient.",
			);
			try {
				const permission = await Promise.race([
					asked.promise,
					pending.then(() => {
						throw new Error("Turn ended without requesting command permission");
					}),
				]);
				const preview = journeyToolText(permission.toolCall);
				const block =
					/^(`{3,})[^\n]*\n(?<line>[^\n]+)\n(?<cwdLine>[^\n]+)\n\1$/.exec(
						preview,
					);
				expect(
					block,
					"Only the full command and compact cwd should be displayed",
				).not.toBeNull();
				const { line, cwdLine } = block!.groups!;
				const executable = /^[A-Za-z0-9_./:-]+$/.test(input.command)
					? input.command
					: `'${input.command.replaceAll("'", String.raw`'\''`)}'`;
				expect(line.startsWith(`${executable} -e `)).toBe(true);
				expect(line).toContain("process.argv.slice(1)");
				expect(
					line.endsWith(
						String.raw`'marker file.txt' 'literal value with spaces & no shell' '' 'single'\''quote' 'double"quote' 'a\b' $'first\nsecond' '$(touch should-not-exist)' last-safe-word`,
					),
				).toBe(true);
				expect(cwdLine).toBe(
					`# cwd: '${cwd.replaceAll("'", String.raw`'\''`)}'`,
				);
				expect(preview).not.toMatch(
					/run_command:|UNSANDBOXED|wrappers|Executable:|Literal argv:|timeout/i,
				);
				expect(permission.toolCall.rawInput).toEqual({ ...input, cwd });

				const { title } = permission.toolCall;
				expect(title!.startsWith(`${executable} -e `)).toBe(true);
				const titleLimit = 100;
				expect(title!.length).toBeLessThanOrEqual(titleLimit);
				expect(line.startsWith(title!.replace(/\.\.\.$/, ""))).toBe(true);
				const initial = journeyTools(f.updates).find(
					({ toolCallId }) => toolCallId === permission.toolCall.toolCallId,
				)!;
				expect(initial.title).toBe(title);
				expect(journeyToolText(initial).split("\n").slice(1, -1)).toEqual([
					line,
					"# requested cwd: 'command cwd'",
				]);
				expect(initial.rawInput).toEqual(input);
				await expect(readFile(marker)).rejects.toMatchObject({
					code: "ENOENT",
				});
				// A protocol round trip leaves the permission pending; only this role must wait.
				await f.peer.agent.request("session/list", {});
				expect(roleRequests(j.requests, "aggregator")).toHaveLength(1);
				await expect(readFile(marker)).rejects.toMatchObject({
					code: "ENOENT",
				});
				if (decision === "cancelled") {
					await f.peer.agent.notify("session/cancel", { sessionId });
				} else {
					answer.resolve(decision === "allowed");
				}
				await expectStop(
					pending,
					decision === "cancelled" ? "cancelled" : "end_turn",
				);
				if (decision === "cancelled") {
					// Even a late approval cannot revive the cancelled process.
					answer.resolve(true);
					await f.peer.agent.request("session/list", {});
					expect(roleRequests(j.requests, "aggregator")).toHaveLength(1);
				} else {
					const result = roleRequests(
						j.requests,
						"aggregator",
					)[1].context.messages.at(-1);
					expect(result).toMatchObject({
						toolName: "run_command",
						isError: decision !== "allowed",
					});
					const completed = journeyTools(f.updates).findLast(
						({ toolCallId }) => toolCallId === permission.toolCall.toolCallId,
					)!;
					expect(completed.title).toBe(title);
					expect(journeyToolText(completed)).toContain(preview);
					expect(completed.status).toBe(
						decision === "allowed" ? "completed" : "failed",
					);
					if (decision === "allowed") {
						// The raw tool payload, never parsed preview text, is the execution oracle.
						const observed = JSON.parse(await readFile(marker, "utf8"));
						const nodeEvalArgCount = 2;
						expect(observed).toEqual({
							argv: input.args.slice(nodeEvalArgCount),
							cwd,
						});
						expect(completed.rawInput).toEqual(input);
						expect(JSON.stringify(result)).toContain(literal);
						expect(journeyToolText(completed)).toContain(`${literal}\n`);
						expect(journeyToolText(completed)).toContain("Exit code: 0");
					} else {
						expect(JSON.stringify(result)).toMatch(/permission.*denied/i);
					}
					expect(journeyText(f.updates)).toContain(
						"Discuss design questions before drafting",
					);
					await expectStop(
						f.prompt(
							sessionId,
							"Finish with a chat report; do not run more commands.",
						),
					);
					expect(journeyText(f.updates)).toContain(JOURNEY_SUMMARY);
					expect(
						Object.values(scripts).every((steps) => steps.length === 0),
					).toBe(true);
				}
			} finally {
				answer.resolve(false);
				await f.peer.agent.notify("session/cancel", { sessionId });
				await pending;
			}
			if (decision !== "allowed") {
				await expect(readFile(marker)).rejects.toMatchObject({
					code: "ENOENT",
				});
			}
			await expect(
				readFile(resolve(cwd, "should-not-exist")),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				j.permissions.filter(
					({ toolCall }) =>
						(toolCall.rawInput as { command?: unknown } | undefined)
							?.command === input.command,
				),
			).toHaveLength(1);
			await f.peer.agent.request("session/close", { sessionId });
		},
	);
});
