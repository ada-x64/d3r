import {
	expectStop,
	type JourneyScripts,
	JOURNEY_MODEL,
	JOURNEY_INIT_TIMEOUT,
	journeyStream,
	journeyFailureStream,
	JOURNEY_PRIVATE_DIAGNOSTIC,
	JOURNEY_DIAGNOSTIC_LEAK,
	journeyCall as call,
	journeyResult,
	journeyResultText,
	journeyPhaseReply as phaseReply,
	journeyDone as done,
	callWith,
	journeyText,
	journeyUserText,
	journeyToolText,
	journeyCheckpoint,
	journeyTools,
	reply,
	roleRequests,
	lastRequest,
} from "./helpers.ts";

import { type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type NativeModel } from "../../../../cli/src/native-models.ts";
import { deferred } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	it.each([
		{
			provider: "openai",
			category: "invalid_request",
			httpStatus: 400,
			code: "invalid_function_parameters",
			detail: "invalid_tool_schema",
			error: {
				code: "invalid_function_parameters",
				message: `Invalid schema for function 'write_file': ${JOURNEY_PRIVATE_DIAGNOSTIC}`,
			},
			advice:
				"The provider rejected a tool schema. Check tool definitions against the configured model's supported schema format.",
		},
		{
			provider: "anthropic",
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			error: {
				type: "authentication_error",
				message: JOURNEY_PRIVATE_DIAGNOSTIC,
			},
			advice:
				"Provider authentication failed. Check the configured provider credentials or sign in again.",
		},
	] as const)(
		"reports a $provider planner rejection before tools and replays only its safe cause",
		// oxlint-disable-next-line max-statements -- Rejection, durable replay and safe routing handoff form one acceptance journey.
		async (rejection) => {
			const selected: NativeModel = {
				...JOURNEY_MODEL,
				provider: rejection.provider,
				id: "configured-planner",
			};
			const failure = {
				stage: "model_request",
				category: rejection.category,
				httpStatus: rejection.httpStatus,
				code: rejection.code,
				...("detail" in rejection ? { detail: rejection.detail } : {}),
				provider: rejection.provider,
				model: "configured-planner",
				toolsStarted: false,
			};
			const safeError = `Role planner: Model request failed (provider \`${rejection.provider}\`; model \`configured-planner\`; HTTP ${rejection.httpStatus}; code \`${rejection.code}\`). ${rejection.advice} No tool execution started in this invocation.`;
			const answer =
				"Review the provider configuration before delegating again.";
			const scripts: JourneyScripts = {
				planner: [[]],
				router: [reply(answer)],
			};
			const j = await open(scripts, {
				models: [JOURNEY_MODEL, selected],
				streamResponse: (role, content) =>
					role === "planner"
						? journeyFailureStream(
								`${rejection.httpStatus} ${JSON.stringify({ error: rejection.error })}`,
							)
						: journeyStream(content),
			});
			const f = await j.connect();
			const { sessionId } = await f.session(selected);
			const files = await readdir(j.cwd, { recursive: true });
			const request = "/delegate Plan the durable queue";
			await expectStop(f.prompt(sessionId, request));
			const text = journeyText(f.updates);
			expect(text).toContain(safeError);
			expect(text).toContain("Status: blocked");
			expect(text).toContain("Return control to the user");
			expect(text).not.toMatch(
				/effects may have occurred|may have had effects/,
			);
			expect(j.requests.map(({ role }) => role)).toEqual([
				"router",
				"planner",
				"router",
			]);
			const planner = j.requests.find(({ role }) => role === "planner")!;
			expect(planner.model).toEqual(selected);
			expect(JSON.stringify(planner.context.messages)).toContain(request);
			expect(planner.context.tools).toContainEqual(
				expect.objectContaining({ name: "d3r_report" }),
			);
			expect(
				journeyTools(f.updates)
					.filter((row) => row.sessionUpdate === "tool_call")
					.map(({ title }) => title),
			).toEqual(["d3r_start_phase", "planner"]);
			const failed = journeyTools(f.updates).findLast(
				(row) => row.title === "planner",
			);
			expect(failed).toMatchObject({
				status: "failed",
				rawOutput: { error: safeError, failure },
			});
			expect(failed!.rawOutput).toEqual({ error: safeError, failure });
			expect(
				f.updates.flatMap(({ update }) =>
					update.sessionUpdate === "usage_update" ? [update.used] : [],
				),
			).toEqual([0, 0, 0]);
			expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
				expect.stringMatching(/^Trust workspace/),
			]);
			const checkpoint = await f.checkpoint(sessionId);
			expect(journeyCheckpoint(checkpoint).inner!.engine).toMatchObject({
				status: "blocked",
				pause: { kind: "failure", message: safeError },
				records: expect.arrayContaining([
					expect.objectContaining({ role: "planner", error: safeError }),
				]),
			});
			const saved = await f.saved(sessionId);
			expect(saved!.records).toContainEqual({
				kind: "update",
				update: expect.objectContaining({
					title: "planner",
					status: "failed",
					rawOutput: { error: safeError, failure },
				}),
			});
			expect(
				JSON.stringify([f.updates, j.permissions, saved, checkpoint]),
			).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
			await expect(readdir(j.cwd, { recursive: true })).resolves.toEqual(files);
			await f.close();
			const resumed = await j.connect();
			await expect(
				resumed.load(sessionId),
				"A failed role must remain loadable with its safe error and parsed failure data",
			).resolves.toBeDefined();
			await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
			expect(journeyText(resumed.updates)).toBe(text);
			expect(
				journeyTools(resumed.updates).findLast((row) => row.title === "planner")
					?.rawOutput,
			).toEqual({ error: safeError, failure });
			expect(j.requests.map(({ role }) => role)).toEqual([
				"router",
				"planner",
				"router",
			]);
			expect(j.permissions).toHaveLength(1);
			await expectStop(resumed.prompt(sessionId, "abandon"));
			const routingStart = resumed.updates.length;
			const routingRequests = j.requests.length;
			await expectStop(resumed.prompt(sessionId, "What should I check?"));
			expect(journeyText(resumed.updates.slice(routingStart))).toBe(answer);
			expect(journeyTools(resumed.updates.slice(routingStart))).toEqual([]);
			expect(j.requests.slice(routingRequests).map(({ role }) => role)).toEqual(
				["router"],
			);
			expect(roleRequests(j.requests, "planner")).toHaveLength(1);
			expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
				safeError,
			);
			expect(
				JSON.stringify([
					resumed.updates,
					await resumed.saved(sessionId),
					j.requests,
				]),
			).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
			await expect(readdir(j.cwd, { recursive: true })).resolves.toEqual(files);
			expect(await readFile(resolve(j.cwd, "AGENTS.md"), "utf8")).toBe(
				"Preserve the offline user's requirements.",
			);
		},
	);

	// oxlint-disable-next-line max-statements -- Prove approved effects, failure evidence, fresh replay and explicit non-repeating recovery together.
	it("retains an approved write after provider failure without replaying it on load or recovery", async () => {
		const artifact =
			"# Queue tasks\n\nKeep completed writes across provider failures.\n";
		const failure = {
			stage: "model_request",
			category: "quota",
			httpStatus: 429,
			code: "insufficient_quota",
			provider: "fixture",
			model: "offline",
			toolsStarted: true,
		};
		const safeError =
			"Role schemer: Model request failed (provider `fixture`; model `offline`; HTTP 429; code `insufficient_quota`). The provider reported an account quota or billing limit. Check usage allowance and billing with the provider. Tools started in this invocation and may have had effects. Review prior tool results before repeating work.";
		const summary =
			"Inspected tasks.md and its current diff; the operator edit is preserved.";
		const request = "/delegate Save the durable queue tasks";
		const correction =
			"Continue the same schemer now that billing is fixed. Inspect tasks.md and its current diff; preserve my edit.";
		const scripts: JourneyScripts = {
			planner: done(
				"Plan the durable queue without repeating completed writes.",
			),
			schemer: [
				call("write_file", { path: "tasks.md", content: artifact }),
				[],
				call("read_file", { path: "tasks.md" }, "current-file"),
				...done(summary),
			],
			router: [
				call("d3r_start_phase", {
					phase: "delegate",
					brief: {
						goal: request,
						context: "Keep the queue local.",
						acceptanceCriteria: ["Preserve completed writes."],
					},
				}),
				phaseReply("d3r_start_phase", "Delegation blocked"),
				// The schemer is read/write-only; the router supplies the requested command evidence.
				call(
					"run_command",
					{
						command: "git",
						args: [
							"--no-pager",
							"--no-optional-locks",
							"diff",
							"--no-ext-diff",
							"--no-color",
							"--",
							"tasks.md",
						],
					},
					"current-diff",
				),
				callWith("d3r_continue_phase", (context) => ({
					instructions: `${correction}\nCurrent diff:\n${journeyResultText(context, "current-diff")}`,
				})),
				phaseReply("d3r_continue_phase", "Delegation recovered"),
				reply(summary),
			],
		};
		const j = await open(scripts, {
			routerShortcuts: false,
			streamResponse: (role, content) =>
				role === "schemer" && content.length === 0
					? journeyFailureStream(
							`429 ${JSON.stringify({
								error: {
									code: "insufficient_quota",
									message: JOURNEY_PRIVATE_DIAGNOSTIC,
								},
							})}`,
						)
					: journeyStream(content),
		});
		const asked = deferred<RequestPermissionRequest>();
		const approval = deferred<boolean>();
		j.approval.decide = async (permission) => {
			if (permission.toolCall.title?.startsWith("Trust workspace")) {
				return true;
			}
			asked.resolve(permission);
			return approval.promise;
		};
		const f = await j.connect();
		const { sessionId } = await f.session();
		const pending = f.prompt(sessionId, request);
		try {
			const permission = await Promise.race([
				asked.promise,
				pending.then(() => {
					throw new Error("Turn ended without requesting write permission");
				}),
			]);
			expect(permission.toolCall.title).toBe("write_file");
			expect(journeyToolText(permission.toolCall)).toContain("tasks.md");
			await expect(readFile(resolve(j.cwd, "tasks.md"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			approval.resolve(true);
			await expectStop(pending);
		} finally {
			approval.resolve(false);
			await pending;
		}
		expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(artifact);
		expect(journeyText(f.updates)).toContain(safeError);
		expect(journeyText(f.updates)).not.toContain("No tool execution started");
		expect(j.requests.map(({ role }) => role)).toEqual([
			"router",
			"planner",
			"planner",
			"schemer",
			"schemer",
			"router",
		]);
		const writeResult = journeyResult(
			lastRequest(j.requests, "schemer").context,
			"write_file",
		);
		expect(writeResult).toMatchObject({
			toolName: "write_file",
			isError: false,
		});
		const written = journeyTools(f.updates).findLast(
			(row) => row.title === "write_file",
		);
		expect(written).toMatchObject({
			status: "completed",
			content: expect.arrayContaining([
				{
					type: "diff",
					path: resolve(j.cwd, "tasks.md"),
					oldText: null,
					newText: artifact,
				},
			]),
		});
		expect(
			journeyTools(f.updates).findLast((row) => row.title === "schemer")
				?.rawOutput,
		).toEqual({
			error: safeError,
			failure,
		});
		const checkpoint = await f.checkpoint(sessionId);
		const blocked = journeyCheckpoint(checkpoint).inner!;
		expect(blocked.engine).toMatchObject({
			status: "blocked",
			pause: { kind: "failure", message: safeError },
		});
		const planner = blocked.engine!.records.find(
			({ role }) => role === "planner",
		)!;
		const schemer = blocked.engine!.records.find(
			({ role }) => role === "schemer",
		)!;
		expect(planner.status).toBe("completed");
		const saved = await f.saved(sessionId);
		expect(saved!.records).toContainEqual({ kind: "update", update: written });
		expect(
			JSON.stringify([f.updates, saved, j.requests, j.permissions]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		const beforeReload = {
			requests: j.requests.length,
			permissions: j.permissions.length,
		};
		// Index the real approved write so the recovering role can inspect the operator's diff, without a fixture commit.
		const git = (...args: string[]) =>
			promisify(execFile)(
				"git",
				["--no-pager", "--no-optional-locks", ...args],
				{ cwd: j.cwd, timeout: JOURNEY_INIT_TIMEOUT },
			);
		await git("init", "--quiet");
		await git("add", "--", "tasks.md");
		// A replayed identical write would erase this external edit even if the final file still existed.
		const external = `${artifact}\nOperator reviewed this file; preserve this edit.\n`;
		await writeFile(resolve(j.cwd, "tasks.md"), external);
		await f.close();
		const resumed = await j.connect();
		await expect(
			resumed.load(sessionId),
			"Loading a failed workflow must preserve both completed tool evidence and the safe cause",
		).resolves.toBeDefined();
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		expect(
			journeyTools(resumed.updates).findLast(
				(row) => row.title === "write_file",
			),
		).toEqual(written);
		expect(
			journeyTools(resumed.updates).findLast((row) => row.title === "schemer")
				?.rawOutput,
		).toEqual({ error: safeError, failure });
		expect(j.requests).toHaveLength(beforeReload.requests);
		expect(j.permissions).toHaveLength(beforeReload.permissions);
		const recoveryStart = resumed.updates.length;
		await expectStop(resumed.prompt(sessionId, correction));
		const recovery = j.requests.slice(beforeReload.requests);
		expect(new Set(recovery.map(({ role }) => role))).toEqual(
			new Set(["router", "schemer"]),
		);
		const routed = lastRequest(recovery, "router").context;
		for (const id of ["current-diff", "d3r_continue_phase"]) {
			expect(journeyResult(routed, id), id).toMatchObject({ isError: false });
		}
		const restarted = roleRequests(recovery, "schemer")[0].context;
		for (const fact of [
			request,
			safeError,
			correction,
			planner.outcome!.summary,
		]) {
			expect(JSON.stringify(restarted.messages)).toContain(fact);
		}
		expect(journeyResult(restarted, "write_file")).toEqual(writeResult);
		const finished = lastRequest(recovery, "schemer").context;
		for (const id of ["current-file", "d3r_report"]) {
			expect(journeyResult(finished, id), id).toMatchObject({ isError: false });
		}
		expect(journeyResultText(finished, "current-file")).toContain(
			"Keep completed writes across provider failures.",
		);
		expect(journeyResultText(finished, "current-file")).toContain(
			"Operator reviewed this file; preserve this edit.",
		);
		const diff = journeyResultText(routed, "current-diff");
		expect(diff).toContain("+Operator reviewed this file; preserve this edit.");
		expect(journeyUserText(restarted)).toContain(diff);
		const recovered = await resumed.state(sessionId);
		expect(recovered.inner).toMatchObject({
			topic: blocked.topic,
			engine: {
				command: "delegate",
				mode: blocked.engine!.mode,
				workflow: blocked.engine!.workflow,
				status: "completed",
			},
		});
		expect(recovered.inner!.engine!.records).toContainEqual(planner);
		expect(
			recovered.inner!.engine!.records.find(({ id }) => id === schemer.id),
		).toMatchObject({
			role: "schemer",
			status: "completed",
			outcome: { summary },
		});
		expect(recovered.inner!.continuations ?? []).toEqual([]);
		expect(journeyText(resumed.updates.slice(recoveryStart))).toContain(
			summary,
		);
		const actions = journeyTools(resumed.updates.slice(recoveryStart))
			.filter(({ sessionUpdate }) => sessionUpdate === "tool_call")
			.map(({ title }) => title);
		expect(actions).toContain("d3r_continue_phase");
		for (const action of [
			"d3r_abandon_phase",
			"d3r_start_phase",
			"d3r_run_role",
			"write_file",
		]) {
			expect(actions).not.toContain(action);
		}
		const beforeDiscussion = j.requests.length;
		await expectStop(resumed.prompt(sessionId, "What recovered?"));
		expect(j.requests.slice(beforeDiscussion).map(({ role }) => role)).toEqual([
			"router",
		]);
		expect(JSON.stringify(j.requests.at(-1)!.context.messages)).toContain(
			safeError,
		);
		expect(
			j.permissions.filter(({ toolCall }) => toolCall.title === "write_file"),
		).toHaveLength(1);
		expect(await readFile(resolve(j.cwd, "tasks.md"), "utf8")).toBe(external);
		expect(
			JSON.stringify([
				resumed.updates,
				await resumed.saved(sessionId),
				j.requests,
				j.permissions,
			]),
		).not.toMatch(JOURNEY_DIAGNOSTIC_LEAK);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
