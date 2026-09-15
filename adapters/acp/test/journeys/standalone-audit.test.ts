import {
	expectStop,
	expectTextOnce,
	type JourneyScripts,
	JOURNEY_INSPECTION_TOOLS,
	journeyCall as call,
	journeyDone as done,
	journeyResult as result,
	journeyResultText as resultText,
	journeyPhaseReply as phaseReply,
	journeyText as agentText,
	journeyTools as toolUpdates,
	journeyCheckpoint as parseState,
	journeyReport,
	journeyStream,
	reply,
	roleRequests,
	lastRequest,
	writeFiles,
} from "./helpers.ts";

import { RequestError } from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { nativeJourneySuite } from "./harness.ts";

describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();

	it("runs a hyphenated worker with split text deltas without leaking or duplicating its response", async () => {
		const role = "fact-finder";
		const goal = "Inspect the local retention policy without changing it.";
		const policy = "Retention period: 24 hours.\n";
		const finding = "The local policy retains jobs for 24 hours.";
		const scripts: JourneyScripts = {
			router: [
				call(
					"d3r_run_role",
					{
						role,
						brief: {
							goal,
							context: "Read policy.txt; do not edit files.",
							acceptanceCriteria: ["Report the recorded retention period."],
						},
					},
					"inspect",
				),
				phaseReply("inspect", "Retention checked"),
			],
			[role]: [
				call("read_file", { path: "policy.txt" }),
				...done(finding, {}, "Worker-only inspection response"),
			],
		};
		const j = await open(scripts, {
			routerShortcuts: false,
			streamResponse: (_role, content) =>
				journeyStream(content, undefined, (text) => [...text]),
		});
		await writeFiles(j.cwd, {
			"policy.txt": policy,
			".agents/agents/fact-finder.md":
				"---\nname: fact-finder\ntier: low\ndescription: Inspect local policy\ncapabilities: [read]\n---\nInspect the recorded facts without making changes.",
		});
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(f.prompt(sessionId, goal));
		const { context } = lastRequest(j.requests, role);
		expect(JSON.stringify(context.messages)).toContain(goal);
		expect(result(context, "read_file")).toMatchObject({ isError: false });
		expect(resultText(context, "read_file")).toContain(policy.trim());
		expect(result(context, "d3r_report")).toMatchObject({ isError: false });
		const completed = await f.state(sessionId);
		expect(completed.inner).toMatchObject({
			standaloneRole: role,
			engine: {
				status: "completed",
				records: [
					expect.objectContaining({
						role,
						outcome: { status: "completed", summary: finding },
					}),
				],
			},
		});
		expectTextOnce(agentText(f.updates), finding);
		expect(agentText(f.updates)).toMatch(/^## Retention checked/);
		expect(agentText(f.updates)).not.toContain("Worker-only");
		await expect(readFile(resolve(j.cwd, "policy.txt"), "utf8")).resolves.toBe(
			policy,
		);
		expect(new Set(j.requests.map((request) => request.role))).toEqual(
			new Set(["router", role]),
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});

	// oxlint-disable-next-line max-statements -- Real worktree evidence, role isolation, and subsequent discussion form one journey.
	it("runs a standalone auditor read-only, reloads completed-role Phase picker changes and starts only the next requested phase", async () => {
		const ordinarySources = [
			"cli/src/verbs/auth.ts",
			"adapters/pi/auth.ts",
			"adapters/pi/auth-store.ts",
			"adapters/acp/secrets.ts",
			"src/auth/secrets/policy.ts",
			"auth.json",
		].map((path) => ({
			path,
			text: path.endsWith(".json")
				? `${JSON.stringify({ purpose: `enqueue source fixture ${path}` })}\n`
				: `export const purpose = "enqueue source fixture ${path}";\n`,
		}));
		const sourceDirectories = [
			...new Set(ordinarySources.map(({ path }) => dirname(path))),
		];
		const privatePath = ".agents/d3r/private/credentials.json";
		const privateCanary = "enqueue-private-credential-canary";
		const goal = "audit this worktree";
		const scope = `Inspect queue.mjs, scratch.txt and ${ordinarySources.map(({ path }) => path).join(", ")}, including uncommitted and untracked contents, not just a commit.`;
		const criterion =
			"Return inline findings with severity and file locations.";
		const constraint =
			"Read-only inspection; do not fix, write reports, stage or commit.";
		const source = "export const enqueue = (jobs, job) => jobs.push(job);\n";
		const untracked =
			"Untracked enqueue probe: callers expect an unchanged input array.\n";
		const finding =
			"**High - queue.mjs:1:** enqueue mutates the caller's array and returns a length, not a queue. The untracked scratch.txt:1 probe expects unchanged input." +
			`\n\n## Source coverage\n\n${ordinarySources.map(({ path, text }) => `- ${path}:1: inspected ${text.trim()}`).join("\n")}\n\nNo source coverage omitted. Stored private credential values excluded.`;
		const command = {
			command: process.execPath,
			args: [
				"--input-type=module",
				"-e",
				"import { readFileSync } from 'node:fs'; for (const path of ['queue.mjs', 'scratch.txt']) console.log(path + ': ' + readFileSync(path, 'utf8'));",
			],
		};
		const scripts: JourneyScripts = {
			router: [
				call(
					"d3r_run_role",
					{
						role: "auditor",
						brief: {
							goal,
							context: scope,
							acceptanceCriteria: [criterion],
							constraints: [constraint],
						},
					},
					"audit-worktree",
				),
				phaseReply("audit-worktree", "Worktree audit"),
				(context) =>
					reply(
						resultText(context, "audit-worktree").includes(finding)
							? "## Audit discussion\n\nThe enqueue finding includes the untracked probe. No fixes or develop phase were started."
							: "Missing prior audit evidence.",
					),
			],
			auditor: [
				call("read_file", { path: "AGENTS.md" }, "conventions"),
				call("read_file", { path: "queue.mjs" }, "changed-source"),
				[...sourceDirectories, "src", "src/auth", ".agents/d3r"].flatMap(
					(path) => call("list_directory", { path }, `list:${path}`),
				),
				call("search", { path: ".", query: "enqueue" }, "worktree-search"),
				ordinarySources.flatMap(({ path }) =>
					call("read_file", { path }, `read:${path}`),
				),
				call("read_file", { path: privatePath }, "private-read"),
				call("run_command", command, "inspect-disk"),
				(context) =>
					journeyReport(
						ordinarySources.every(
							({ path, text }) =>
								resultText(context, `read:${path}`).includes(text.trim()) &&
								resultText(context, "worktree-search").includes(text.trim()) &&
								resultText(context, `list:${dirname(path)}`).includes(
									basename(path),
								),
						)
							? finding
							: "Source audit coverage incomplete.",
					),
				reply("Worker-only audit response"),
			],
		};
		const j = await open(scripts, {
			routerShortcuts: false,
			readTextFile: async ({ path }) => {
				if (
					![
						"AGENTS.md",
						"queue.mjs",
						"scratch.txt",
						privatePath,
						...ordinarySources.map((file) => file.path),
					].some((file) => resolve(j.cwd, file) === path)
				) {
					throw new Error("Editor read outside audit fixtures");
				}
				return { content: await readFile(path, "utf8") };
			},
		});
		await writeFiles(j.cwd, {
			...Object.fromEntries(
				ordinarySources.map(({ path, text }) => [path, text]),
			),
			[privatePath]: JSON.stringify({ token: privateCanary }),
		});
		const git = (...args: string[]) =>
			promisify(execFile)(
				"git",
				["--no-pager", "--no-optional-locks", ...args],
				{ cwd: j.cwd, timeout: 5000 },
			);
		// An index baseline gives real dirty/untracked files without creating a fixture commit.
		await git("init", "--quiet");
		await writeFile(
			resolve(j.cwd, "queue.mjs"),
			"export const enqueue = (jobs, job) => [...jobs, job];\n",
		);
		await git("add", "--", "queue.mjs");
		await Promise.all([
			writeFile(resolve(j.cwd, "queue.mjs"), source),
			writeFile(resolve(j.cwd, "scratch.txt"), untracked),
		]);
		const { stdout: beforeStatus } = await git("status", "--porcelain=v1");
		expect(beforeStatus).toContain("AM queue.mjs");
		expect(beforeStatus).toContain("?? scratch.txt");
		const files = await readdir(j.cwd, { recursive: true });
		const index = await readFile(resolve(j.cwd, ".git/index"));
		const f = await j.connect();
		const { sessionId } = await f.session();
		const pin = await f.state(sessionId);
		expect(
			pin.resources.agents.find(({ spec }) => spec.name === "auditor")?.spec
				.capabilities,
		).toEqual(["read", "bash", "write"]);
		await expect(
			readFile(resolve(pin.resources.vaultRoot, "AGENTS.md")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expectStop(
			f.prompt(sessionId, `${goal}\n${scope}\n${criterion}\n${constraint}`),
		);
		const completed = await f.state(sessionId);
		expect(completed.resources).toEqual(pin.resources);
		expect(completed.inner).toMatchObject({
			orchestrated: true,
			standaloneRole: "auditor",
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: {
				command: "standalone",
				status: "completed",
				mode: null,
				pause: null,
			},
		});
		expect(completed.inner!.engine!.workflow).toEqual({
			commands: {
				standalone: {
					description: "Run auditor independently",
					chain: [{ kind: "agent", name: "auditor" }],
				},
			},
			vault: pin.resources.workflow.vault,
		});
		expect(completed.inner!.engine!.records).toEqual([
			expect.objectContaining({
				kind: "agent",
				role: "auditor",
				loops: [],
				status: "completed",
				outcome: { status: "completed", summary: finding },
			}),
		]);
		expect(completed.inner).not.toHaveProperty("summary");
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"auditor",
		]);
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "auditor"]),
		);
		const auditor = roleRequests(j.requests, "auditor");
		for (const fact of [
			goal,
			scope,
			criterion,
			constraint,
			"Conversation-derived standalone role brief:",
			"Execute only auditor as a standalone role",
			"including uncommitted and untracked work",
			"Keep inspection read-only",
		]) {
			expect(JSON.stringify(auditor[0].context.messages)).toContain(fact);
		}
		expect(auditor[0].context.systemPrompt).toMatch(
			/no prior phase or formal vault documents are required/i,
		);
		for (const { context } of auditor) {
			expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
				JOURNEY_INSPECTION_TOOLS,
			);
		}
		const evidence = auditor.at(-1)!.context;
		for (const { path, text } of ordinarySources) {
			expect(result(evidence, `read:${path}`)).toMatchObject({
				isError: false,
			});
			expect(resultText(evidence, `read:${path}`)).toContain(
				`1: ${text.trim()}`,
			);
			expect(resultText(evidence, "worktree-search")).toContain(
				`${resolve(j.cwd, path)}:1: ${text.trim()}`,
			);
			expect(result(evidence, `list:${dirname(path)}`)).toMatchObject({
				isError: false,
			});
			expect(
				resultText(evidence, `list:${dirname(path)}`).split("\n"),
			).toContain(basename(path));
			expect(j.reads.map((read) => read.path)).toContain(resolve(j.cwd, path));
		}
		for (const [path, entry] of [
			["src", "auth/"],
			["src/auth", "secrets/"],
		]) {
			expect(result(evidence, `list:${path}`)).toMatchObject({
				isError: false,
			});
			expect(resultText(evidence, `list:${path}`)).toContain(entry);
		}
		expect(result(evidence, "list:.agents/d3r")).toMatchObject({
			isError: false,
		});
		expect(resultText(evidence, "list:.agents/d3r")).not.toContain("private");
		expect(result(evidence, "private-read")).toMatchObject({
			isError: true,
		});

		expect(resultText(evidence, "worktree-search")).not.toContain(privatePath);
		for (const surface of [j.requests, f.updates, await f.saved(sessionId)]) {
			expect(JSON.stringify(surface)).not.toContain(privateCanary);
		}
		expect(j.reads.map(({ path }) => path)).not.toContain(
			resolve(j.cwd, privatePath),
		);
		for (const id of [
			"conventions",
			"changed-source",
			"worktree-search",
			"inspect-disk",
			"d3r_report",
		]) {
			expect(result(evidence, id)).toMatchObject({ isError: false });
		}
		expect(resultText(evidence, "conventions")).toContain(
			"Preserve the offline user's requirements.",
		);
		expect(resultText(evidence, "changed-source")).toContain(source.trim());
		expect(resultText(evidence, "worktree-search")).toContain(
			`${resolve(j.cwd, "queue.mjs")}:1: ${source.trim()}`,
		);
		expect(resultText(evidence, "worktree-search")).toContain(
			`${resolve(j.cwd, "scratch.txt")}:1: ${untracked.trim()}`,
		);
		for (const text of [source.trim(), untracked.trim()]) {
			expect(resultText(evidence, "inspect-disk")).toContain(text);
		}
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringContaining("--input-type=module"),
		]);
		expect(j.permissions.at(-1)!.toolCall.rawInput).toMatchObject(command);
		expect(
			toolUpdates(f.updates).filter(
				({ status, kind }) => status === "completed" && kind === "execute",
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rawInput: expect.objectContaining(command) }),
			]),
		);
		const final = lastRequest(j.requests, "router").context;
		expect(result(final, "audit-worktree")).toMatchObject({
			isError: false,
		});
		expect(resultText(final, "audit-worktree")).toContain(
			"## Role: auditor\nStatus: completed\nMode: standalone\nThis is an independent role task, not completion or approval of a phase.",
		);
		expect(agentText(f.updates)).toMatch(/^## Worktree audit/);
		expectTextOnce(agentText(f.updates), finding);
		expect(agentText(f.updates)).not.toMatch(
			/Worker-only|"status"|```json|## Phase:|Workflow complete/,
		);
		const beforePicker = {
			requests: j.requests.length,
			runtimes: j.runtimes.length,
			permissions: j.permissions.length,
		};
		const selected = await f.configure(sessionId, "phase", "develop");
		expect(selected.configOptions).toContainEqual(
			expect.objectContaining({ id: "phase", currentValue: "develop" }),
		);
		const selectedCheckpoint = await f.checkpoint(sessionId);
		expect(parseState(selectedCheckpoint)).toEqual({
			...completed,
			phase: "develop",
			inner: { ...completed.inner, phase: "develop" },
		});
		await f.closeSession(sessionId);
		await f.close();
		const resumed = await j.connect();
		const loaded = await resumed.load(sessionId);
		expect(loaded.configOptions).toContainEqual(
			expect.objectContaining({ id: "phase", currentValue: "develop" }),
		);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(
			selectedCheckpoint,
		);
		expect(j.requests).toHaveLength(beforePicker.requests);
		expect(j.runtimes).toHaveLength(beforePicker.runtimes);
		expect(j.permissions).toHaveLength(beforePicker.permissions);
		expect(agentText(resumed.updates)).toContain(finding);
		await expect(
			resumed.configure(sessionId, "phase", "standalone"),
		).rejects.toBeInstanceOf(RequestError);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(
			selectedCheckpoint,
		);
		const changed = await resumed.configure(sessionId, "phase", "delegate");
		expect(changed.configOptions).toContainEqual(
			expect.objectContaining({ id: "phase", currentValue: "delegate" }),
		);
		expect(await resumed.state(sessionId)).toEqual({
			...completed,
			phase: "delegate",
			inner: { ...completed.inner, phase: "delegate" },
		});
		expect(j.requests).toHaveLength(beforePicker.requests);
		expect(j.runtimes).toHaveLength(beforePicker.runtimes);
		expect(j.permissions).toHaveLength(beforePicker.permissions);
		const beforeDiscussion = j.requests.length;
		const permissions = j.permissions.length;
		await expectStop(
			resumed.prompt(
				sessionId,
				"Discuss the untracked probe finding; do not start any fixes.",
			),
		);
		expect(j.requests.slice(beforeDiscussion).map(({ role }) => role)).toEqual([
			"router",
		]);
		expect(
			j.permissions.slice(permissions).map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		expect(agentText(resumed.updates)).toContain(
			"No fixes or develop phase were started.",
		);
		expect(resultText(j.requests.at(-1)!.context, "audit-worktree")).toContain(
			finding,
		);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
			"No active workflow. Preferred phase: delegate (routing preference, not a requirement).",
		);
		expect(parseState(await resumed.checkpoint(sessionId)).inner).toMatchObject(
			{
				phase: "delegate",
				engine: null,
				workflow: pin.resources.workflow,
			},
		);
		const nextGoal =
			"Use the selected delegate phase to outline the enqueue fix inline, without implementation or files.";
		const reports = {
			planner:
				"Scope the fix to queue.mjs: preserve the caller's array and return the extended queue.",
			schemer:
				"Acceptance: the scratch.txt probe must observe unchanged input and both jobs in the returned queue.",
		};
		scripts.router.push(
			call(
				"d3r_start_phase",
				{
					phase: "delegate",
					brief: {
						goal: nextGoal,
						context: finding,
						acceptanceCriteria: [criterion],
						constraints: [constraint],
					},
				},
				"delegate-after-audit",
			),
			phaseReply("delegate-after-audit", "Inline task ready"),
		);
		scripts.planner = [
			call("read_file", { path: "queue.mjs" }),
			...done(reports.planner),
		];
		scripts.schemer = [
			call("read_file", { path: "scratch.txt" }),
			...done(reports.schemer),
		];
		const nextStart = j.requests.length;
		const nextUpdates = resumed.updates.length;
		await expectStop(resumed.prompt(sessionId, nextGoal));
		const delegated = await resumed.state(sessionId);
		expect(delegated.resources).toEqual(pin.resources);
		expect(delegated.inner).not.toHaveProperty("standaloneRole");
		expect(delegated.inner).toMatchObject({
			phase: "routing",
			workflow: pin.resources.workflow,
			engine: {
				command: "delegate",
				status: "completed",
				workflow: pin.resources.workflow,
			},
		});
		expect(
			delegated.inner!.engine!.records.map(({ role, status, outcome }) => ({
				role,
				status,
				summary: outcome?.summary,
			})),
		).toEqual(
			Object.entries(reports).map(([role, summary]) => ({
				role,
				status: "completed",
				summary,
			})),
		);
		for (const [role, text] of [
			["planner", source],
			["schemer", untracked],
		]) {
			const { context } = lastRequest(j.requests, role);
			expect(result(context, "read_file")).toMatchObject({
				isError: false,
			});
			expect(resultText(context, "read_file")).toContain(text.trim());
		}
		expect(
			new Set(j.requests.slice(nextStart).map(({ role }) => role)),
		).toEqual(new Set(["router", "planner", "schemer"]));
		expect(roleRequests(j.requests, "auditor")).toEqual(auditor);
		expect(j.runtimes.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"auditor",
			"routing",
			"planner",
			"schemer",
		]);
		expect(
			j.permissions.slice(permissions).map(({ toolCall }) => toolCall.title),
		).toEqual([expect.stringMatching(/^Trust workspace/)]);
		expect(
			result(j.requests.at(-1)!.context, "delegate-after-audit"),
		).toMatchObject({ isError: false });
		expect(agentText(resumed.updates.slice(nextUpdates))).toMatch(
			/^## Inline task ready/,
		);
		for (const report of Object.values(reports)) {
			expectTextOnce(agentText(resumed.updates.slice(nextUpdates)), report);
		}
		for (const { context } of roleRequests(j.requests, "router")) {
			expect(context.tools?.map(({ name }) => name).toSorted()).toEqual(
				[
					...JOURNEY_INSPECTION_TOOLS.filter((name) => name !== "d3r_report"),
					"edit_file",
					"vault_edit",
					"web_search",
					"web_fetch",
					"crit_review",
					"d3r_start_phase",
					"d3r_run_role",
					"d3r_continue_phase",
					"d3r_abandon_phase",
					"d3r_phase_status",
				].toSorted(),
			);
			expect(
				context.tools?.find(({ name }) => name === "d3r_run_role")?.parameters,
			).toMatchObject({
				type: "object",
				required: ["role", "brief"],
				additionalProperties: false,
				properties: {
					role: {
						type: "string",
						enum: pin.resources.agents
							.filter(({ spec }) => spec.name !== "orchestrator")
							.map(({ spec }) => spec.name),
					},
					brief: {
						type: "object",
						required: ["goal", "context", "acceptanceCriteria"],
						additionalProperties: false,
					},
					mode: { type: "string", enum: ["semi", "auto"] },
				},
			});
		}
		for (const surface of [
			j.requests,
			f.updates,
			resumed.updates,
			await resumed.saved(sessionId),
		]) {
			expect(JSON.stringify(surface)).not.toContain(privateCanary);
		}
		expect(j.reads.map(({ path }) => path)).not.toContain(
			resolve(j.cwd, privatePath),
		);
		expect(await readdir(j.cwd, { recursive: true })).toEqual(files);
		expect(await readFile(resolve(j.cwd, ".git/index"))).toEqual(index);
		const { stdout: afterStatus } = await git("status", "--porcelain=v1");
		expect(afterStatus).toBe(beforeStatus);
		expect(await readFile(resolve(j.cwd, "queue.mjs"), "utf8")).toBe(source);
		expect(await readFile(resolve(j.cwd, "scratch.txt"), "utf8")).toBe(
			untracked,
		);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
