import {
	expectStop,
	type JourneyContext,
	type JourneyScripts,
	journeyStream,
	journeyToolGate,
	journeyCall as call,
	journeyResult,
	journeyResultText,
	journeyUserText,
	journeyTopic,
	journeyPhaseReply,
	JOURNEY_INIT_TIMEOUT,
	journeyPage,
	journeyDone as done,
	journeyText,
	journeyCheckpoint,
	journeyTools,
	reply,
	callWith,
	lastRequest,
	roleRequests,
} from "./helpers.ts";

import { SEED_ROOT } from "@d3r/core/vault/seed-root";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open, cleanup } = nativeJourneySuite();
	it(
		"initializes a missing vault only after consent, then shares one generated /design topic across parallel writes and reload",
		// oxlint-disable-next-line max-statements -- Consent, parallel publication and fresh-session continuation form one acceptance journey.
		async () => {
			const scripts: JourneyScripts = {};
			const gates = {
				aggregator: journeyToolGate("vault_write"),
				researcher: journeyToolGate("vault_write"),
			};
			const j = await open(scripts, {
				routerShortcuts: false,
				streamResponse: (role, content, settings) =>
					role === "aggregator" || role === "researcher"
						? gates[role].stream(content, settings?.signal)
						: journeyStream(content),
			});
			const cli = fileURLToPath(
				new URL("../../../../cli/dist/cli.js", import.meta.url),
			);
			await expect(
				readFile(cli),
				"Run pnpm -r build before the CLI initialization journey",
			).resolves.toBeDefined();
			// The real CLI creates its seed commit, but must never use the operator's Git configuration or home.
			cleanup.push(async () => {
				vi.unstubAllEnvs();
			});
			for (const [name, value] of Object.entries({
				HOME: resolve(j.root, "home"),
				USERPROFILE: resolve(j.root, "home"),
				GIT_CONFIG_GLOBAL: resolve(j.root, "home/.gitconfig"),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_COUNT: "0",
				GIT_AUTHOR_NAME: "D3R journey",
				GIT_AUTHOR_EMAIL: "journey@d3r.invalid",
				GIT_COMMITTER_NAME: "D3R journey",
				GIT_COMMITTER_EMAIL: "journey@d3r.invalid",
				GIT_EDITOR: "true",
			})) {
				vi.stubEnv(name, value);
			}
			const f = await j.connect();
			const { sessionId } = await f.session();
			const { resources } = await f.state(sessionId);
			const vault = resources.vaultRoot;
			expect(vault).toBe(resolve(j.cwd, ".agents/vault"));
			const goal = "Design an offline job queue";
			const correction =
				"Correction: call this durable dispatch, not a job queue; retain pending jobs across restarts. Draft the design now.";
			const init = (context: JourneyContext) => {
				const guidance = journeyUserText(context)
					.split("\n")
					.find((line) => line.startsWith("With user direction,"))!;
				const literal = JSON.parse(guidance.slice(guidance.indexOf("{"))) as {
					command: string;
					args: string[];
					cwd: string;
				};
				return call("run_command", literal, "init");
			};
			const writeDocument =
				(kind: string, details: string) => (context: JourneyContext) => {
					const topic = journeyTopic(context);
					const heading = journeyPage(context, "template")
						.text.match(/^# .+$/m)![0]
						.replace(/<[^>]+>/g, topic);
					return call("vault_write", {
						mode: "doc",
						path: `process/designs/${topic}/${kind}.md`,
						kind,
						frontmatter: { created: "2026-09-10", status: "draft" },
						body: `${heading}\n\n${details}\n`,
					});
				};
			scripts.router = [
				reply(
					"May I run d3r vault init for the pinned vault? This seeds templates and directories and creates a separate Git repository with an initial commit; it does not push.",
				),
				init,
				reply(
					"Command approval was denied. No vault was initialized and no document work started.",
				),
				init,
				call("vault_ls", { path: ".misc/templates" }, "seeded-templates"),
				call("d3r_start_phase", {
					phase: "design",
					brief: {
						goal,
						context: "Jobs must survive restarts without a network service.",
						acceptanceCriteria: [
							"Write remember, research and design documents in the shared topic directory.",
						],
					},
				}),
				journeyPhaseReply("d3r_start_phase", "Recon complete"),
				call("d3r_continue_phase", { instructions: correction }),
				journeyPhaseReply("d3r_continue_phase", "Design complete"),
			];
			const recon = [
				{
					role: "aggregator",
					kind: "remember",
					evidence: "Jobs must survive restarts.",
				},
				{
					role: "researcher",
					kind: "research",
					evidence:
						"The supplied offline requirement rules out a network-only queue; external prior art was not consulted.",
				},
			];
			for (const { role, kind, evidence } of recon) {
				scripts[role] = [
					call(
						"vault_read",
						{ path: `.misc/templates/${kind}.md` },
						"template",
					),
					writeDocument(kind, evidence),
					...done(evidence),
				];
			}
			scripts.designer = [
				callWith(
					"vault_read",
					(context) => ({
						path: `process/designs/${journeyTopic(context)}/remember.md`,
					}),
					"remember",
				),
				callWith(
					"vault_read",
					(context) => ({
						path: `process/designs/${journeyTopic(context)}/research.md`,
					}),
					"research",
				),
				call("vault_read", { path: ".misc/templates/design.md" }, "template"),
				(context) =>
					writeDocument(
						"design",
						`## Decision\n\n${correction}\n\n## Evidence\n\n${journeyPage(context, "remember").text}\n${journeyPage(context, "research").text}`,
					)(context),
				...done("Designed durable dispatch from both shared recon documents."),
			];
			const files = await readdir(j.cwd, { recursive: true });
			await expectStop(f.prompt(sessionId, `/design ${goal}`));
			expect(j.requests.map(({ role }) => role)).toEqual(["router"]);
			const first = j.requests[0].context;
			expect(journeyUserText(first)).toContain("Native vault status: missing.");
			expect(journeyUserText(first)).toContain(
				`Pinned vault root: ${JSON.stringify(vault)}`,
			);
			const invocation = {
				command: process.execPath,
				args: [cli, "vault", "init", "--vault-root", vault],
				cwd: j.cwd,
			};
			expect(isAbsolute(invocation.command)).toBe(true);
			expect(isAbsolute(cli)).toBe(true);
			expect(journeyUserText(first)).toContain(JSON.stringify(invocation));
			expect(journeyUserText(first)).toContain(
				"Do not auto-initialize, run mkdir, or use vault_write",
			);
			expect(journeyUserText(first)).toContain(
				"If the user declines or requests no vault artifacts, continue inline",
			);
			expect(first.systemPrompt).toContain(
				"Never ask the user to invent a topic name",
			);
			expect(journeyText(f.updates)).toMatch(
				/May I run d3r vault init[\s\S]*seeds templates[\s\S]*initial commit/,
			);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			expect(
				journeyTools(f.updates).filter(
					({ title }) => !title?.startsWith("Trust workspace"),
				),
			).toEqual([]);
			expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
			const idle = await f.state(sessionId);
			expect(idle.inner).toMatchObject({ engine: null });

			j.approval.decide = async () => false;
			await expectStop(
				f.prompt(
					sessionId,
					"Yes, initialize the pinned vault including its seed commit, then start /design.",
				),
			);
			const denied = j.requests.at(-1)!.context;
			expect(journeyResult(denied, "init")).toMatchObject({ isError: true });
			expect(journeyResultText(denied, "init")).toMatch(/denied|not granted/i);
			expect(j.requests.every(({ role }) => role === "router")).toBe(true);
			expect(j.permissions.at(-1)!.toolCall.rawInput).toMatchObject(invocation);
			expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
			await expect(readdir(vault)).rejects.toMatchObject({ code: "ENOENT" });

			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true ||
				(toolCall.rawInput as { command?: string } | undefined)?.command ===
					process.execPath;
			const pending = f.prompt(
				sessionId,
				"Retry initialization; I will approve the command, then save recon in the trusted vault.",
			);
			try {
				const writes = await Promise.race([
					Promise.all(
						Object.values(gates).map(({ reached }) => reached.promise),
					),
					pending.then(() => {
						throw new Error("Recon ended before both provider write gates");
					}),
				]);
				const router = lastRequest(j.requests, "router").context;
				const commands = router.messages.flatMap((message) =>
					message.role === "assistant"
						? message.content.flatMap((part) =>
								part.type === "toolCall" && part.name === "run_command"
									? [part.arguments]
									: [],
							)
						: [],
				);
				expect(commands).toEqual([invocation, invocation]);
				expect(
					j.permissions
						.filter(
							({ toolCall }) =>
								toolCall.kind === "execute" &&
								!toolCall.title?.startsWith("Trust workspace"),
						)
						.map(({ toolCall }) => toolCall.rawInput),
				).toEqual([
					expect.objectContaining(invocation),
					expect.objectContaining(invocation),
				]);
				expect(journeyResult(router, "init")).toMatchObject({ isError: false });
				expect(journeyResultText(router, "init")).toContain("Exit code: 0");
				expect(journeyResult(router, "seeded-templates")).toMatchObject({
					isError: false,
				});
				expect(journeyResultText(router, "seeded-templates")).toContain(
					"remember.md",
				);
				const topic = journeyTopic(
					j.requests.find(({ role }) => role === "aggregator")!.context,
				);
				expect(topic).toMatch(/^design-an-offline-job-queue-[a-z0-9]+$/);
				expect(
					writes
						.flatMap((content) =>
							content.flatMap((part) =>
								part.type === "toolCall" ? [part.arguments.path] : [],
							),
						)
						.toSorted(),
				).toEqual([
					`process/designs/${topic}/remember.md`,
					`process/designs/${topic}/research.md`,
				]);
				// Provider IO holds both roles before publication, not obsolete per-vault approvals.
				await expect(
					readdir(resolve(vault, "process/designs", topic)),
				).rejects.toMatchObject({ code: "ENOENT" });
				const { stdout } = await promisify(execFile)(
					"git",
					["--no-pager", "-C", vault, "log", "--format=%s"],
					{ timeout: 5000 },
				);
				expect(stdout.trim()).toBe("chore: initial vault seed");
			} finally {
				Object.values(gates).forEach(({ release }) => release.resolve());
			}
			await expectStop(pending);
			expect(
				j.permissions.some(({ toolCall }) =>
					toolCall.title?.startsWith("vault_"),
				),
			).toBe(false);
			const checkpoint = await f.checkpoint(sessionId);
			const waiting = journeyCheckpoint(checkpoint).inner!;
			const topic = waiting.topic!;
			expect(waiting.engine).toMatchObject({
				status: "waiting",
				pause: { kind: "human" },
			});
			expect(journeyText(f.updates)).toContain(
				"Discuss design questions before drafting",
			);
			await Promise.all(
				recon.map(async ({ role, kind }) => {
					const contexts = roleRequests(j.requests, role).map(
						({ context }) => context,
					);
					expect(journeyTopic(contexts[0])).toBe(topic);
					expect(journeyPage(contexts.at(-1)!, "template").text).toBe(
						await readFile(
							resolve(SEED_ROOT, `.misc/templates/${kind}.md`),
							"utf8",
						),
					);
					expect(journeyResult(contexts.at(-1)!, "vault_write")).toMatchObject({
						isError: false,
					});
					expect(JSON.stringify(contexts)).not.toContain(
						"Native vault status:",
					);
				}),
			);
			expect(
				JSON.stringify([waiting.input, waiting.routingInput]),
			).not.toContain("Native vault status:");
			expect(await readdir(resolve(vault, "process/designs", topic))).toEqual([
				"remember.md",
				"research.md",
			]);
			const effects = {
				requests: j.requests.length,
				permissions: j.permissions.length,
			};
			await f.closeSession(sessionId);
			await f.close();
			const resumed = await j.connect();
			await resumed.load(sessionId);
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(j.requests).toHaveLength(effects.requests);
			expect(j.permissions).toHaveLength(effects.permissions);
			await expectStop(resumed.prompt(sessionId, correction));
			const continuation = j.requests.slice(effects.requests);
			expect(new Set(continuation.map(({ role }) => role))).toEqual(
				new Set(["router", "designer"]),
			);
			const router = continuation[0].context;
			expect(journeyUserText(router)).toContain(
				"Native vault status: available.",
			);
			expect(journeyUserText(router)).toContain("Current task topic:");
			expect(journeyTopic(router)).toBe(topic);
			const designer = lastRequest(continuation, "designer").context;
			expect(journeyTopic(designer)).toBe(topic);
			expect(journeyUserText(designer)).toContain(correction);
			await Promise.all(
				recon.map(async ({ kind }) => {
					expect(journeyPage(designer, kind)).toMatchObject({
						path: `process/designs/${topic}/${kind}.md`,
						text: await readFile(
							resolve(vault, `process/designs/${topic}/${kind}.md`),
							"utf8",
						),
					});
				}),
			);
			expect(journeyPage(designer, "template").text).toBe(
				await readFile(resolve(SEED_ROOT, ".misc/templates/design.md"), "utf8"),
			);
			expect(journeyResult(designer, "vault_write")).toMatchObject({
				isError: false,
			});
			expect(
				await readFile(
					resolve(vault, `process/designs/${topic}/design.md`),
					"utf8",
				),
			).toContain(correction);
			const designs = await readdir(resolve(vault, "process/designs"), {
				withFileTypes: true,
			});
			expect(
				designs.filter((entry) => entry.isDirectory()).map(({ name }) => name),
			).toEqual([topic]);
			expect(await readdir(resolve(vault, "process/designs", topic))).toEqual([
				"design.md",
				"remember.md",
				"research.md",
			]);
			const completed = await resumed.state(sessionId);
			expect(completed.inner).toMatchObject({
				topic,
				engine: { status: "completed" },
			});
			expect(
				journeyResultText(continuation.at(-1)!.context, "d3r_continue_phase"),
			).toContain(
				"Most recent topic; reuse only for follow-on work on the same subject:",
			);
			expect(
				j.permissions
					.slice(effects.permissions)
					.map(({ toolCall }) => toolCall.title),
			).toEqual([expect.stringMatching(/^Trust workspace/)]);
			expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
				true,
			);
			await resumed.closeSession(sessionId);
		},
		JOURNEY_INIT_TIMEOUT,
	);

	// oxlint-disable-next-line max-statements -- Scripted provider decisions test retained refusal and real effects, not live model judgment.
	it("retains a conversational vault decline across reload and runs only an inline audit while the vault is missing", async () => {
		const decline =
			"No. Do not initialize a vault or create any documents. Keep subsequent work inline.";
		const finding =
			"AGENTS.md requires preserving the offline user's requirements; no changes are needed.";
		const scripts: JourneyScripts = {
			router: [
				reply(
					"May I run d3r vault init? It seeds templates and creates a separate Git repository with an initial commit.",
				),
				reply(
					"Understood. I will keep work inline without initializing the vault or creating documents.",
				),
				call("d3r_run_role", {
					role: "auditor",
					brief: {
						goal: "Audit workspace instructions",
						context: `Read AGENTS.md only. ${decline}`,
						acceptanceCriteria: [
							"Return findings inline without any writes or commands.",
						],
					},
				}),
				journeyPhaseReply("d3r_run_role", "Inline audit"),
			],
			auditor: [call("read_file", { path: "AGENTS.md" }), ...done(finding)],
		};
		const j = await open(scripts, { routerShortcuts: false });
		const f = await j.connect();
		const { sessionId } = await f.session();
		const files = await readdir(j.cwd, { recursive: true });
		await expectStop(
			f.prompt(sessionId, "/design Prepare an offline dispatch design"),
		);
		expect(journeyUserText(j.requests[0].context)).toContain(
			"Native vault status: missing.",
		);
		expect(journeyText(f.updates)).toContain("May I run d3r vault init?");
		await expectStop(f.prompt(sessionId, decline));
		expect(j.requests.map(({ role }) => role)).toEqual(["router", "router"]);
		const checkpoint = await f.checkpoint(sessionId);
		const pin = journeyCheckpoint(checkpoint);
		expect(pin.inner).toMatchObject({ engine: null });
		expect(JSON.stringify(pin.inner!.history)).toContain(decline);
		await expect(readdir(pin.resources.vaultRoot)).rejects.toMatchObject({
			code: "ENOENT",
		});
		const effects = {
			requests: j.requests.length,
			permissions: j.permissions.length,
		};
		await f.closeSession(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(j.requests).toHaveLength(effects.requests);
		expect(j.permissions).toHaveLength(effects.permissions);
		const start = resumed.updates.length;
		await expectStop(
			resumed.prompt(
				sessionId,
				"Now audit AGENTS.md and explain the findings.",
			),
		);
		const continuation = j.requests.slice(effects.requests);
		const router = continuation[0].context;
		expect(journeyUserText(router)).toContain("Native vault status: missing.");
		expect(journeyUserText(router)).toContain(
			`Pinned vault root: ${JSON.stringify(pin.resources.vaultRoot)}`,
		);
		expect(JSON.stringify(router.messages)).toContain(decline);
		expect(journeyUserText(router)).toContain("do not repeatedly ask");
		expect(new Set(continuation.map(({ role }) => role))).toEqual(
			new Set(["router", "auditor"]),
		);
		const auditor = lastRequest(continuation, "auditor").context;
		expect(journeyResult(auditor, "read_file")).toMatchObject({
			isError: false,
		});
		expect(journeyResultText(auditor, "read_file")).toContain(
			"Preserve the offline user's requirements.",
		);
		expect(journeyText(resumed.updates.slice(start))).toContain(finding);
		expect(journeyText(resumed.updates.slice(start))).not.toContain(
			"May I run d3r vault init?",
		);
		const completed = await resumed.state(sessionId);
		expect(completed.inner).toMatchObject({
			standaloneRole: "auditor",
			engine: { status: "completed" },
		});
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(
			journeyTools(resumed.updates.slice(start))
				.filter((update) => update.sessionUpdate === "tool_call")
				.map(({ title }) => title)
				.toSorted(),
		).toEqual(["auditor", "d3r_report", "d3r_run_role", "read_file"]);
		expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
		await expect(readdir(pin.resources.vaultRoot)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
		await resumed.closeSession(sessionId);
	});
});
