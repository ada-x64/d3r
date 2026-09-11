import {
	expectStop,
	type JourneyScripts,
	journeyCall as call,
	journeyResult,
	journeyResultText,
	JOURNEY_BUDGET,
	type JourneyDecision,
	journeyReport,
	journeyDone as done,
	journeyText,
	journeyToolText,
	journeyTools,
	reply,
	callWith,
	roleRequests,
} from "./helpers.ts";

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedRuntime } from "../../../pi/embedded.ts";

import { deferred } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open } = nativeJourneySuite();
	const permissionKinds = ["allow_once", "reject_once", "allow_always"];
	// oxlint-disable-next-line max-statements -- Independent held grants prove both retained-context completion and a real hard-cap stop.
	it("extends a role at its last request through ACP without extending its sibling or passing the hard cap", async () => {
		const extension = (reason: string) =>
			call("d3r_request_extension", { reason });
		const read = call("read_file", { path: "brief.txt" });
		const summary =
			"Research confirms the queue must retain acknowledged jobs.";
		const scripts: JourneyScripts = {
			researcher: [
				read,
				read,
				extension("Save research evidence and synthesize the report"),
				callWith("write_file", (context) => ({
					path: "research.md",
					content: journeyResultText(context, "read_file"),
				})),
				...done(summary),
				reply("Unbudgeted researcher request"),
			],
			aggregator: [
				read,
				read,
				extension("Inspect remaining local constraints"),
				read,
				read,
				extension("Must not exceed the hard cap"),
				reply("Unbudgeted aggregator request"),
			],
		};
		const j = await open(scripts, {
			createRuntime: (options) =>
				createEmbeddedRuntime({
					...options,
					...(options.budgetLabel === "workflow summary" ? {} : JOURNEY_BUDGET),
				}),
		});
		await writeFile(
			resolve(j.cwd, "brief.txt"),
			"The queue must retain acknowledged jobs.",
		);
		const grants = {
			researcher: deferred<JourneyDecision>(),
			aggregator: deferred<JourneyDecision>(),
		};
		j.approval.decide = async ({ toolCall }) => {
			if (toolCall.title?.startsWith("Extend request budget (researcher)")) {
				return grants.researcher.promise;
			}
			if (toolCall.title?.startsWith("Extend request budget (aggregator)")) {
				return grants.aggregator.promise;
			}
			return true;
		};
		const f = await j.connect();
		const { sessionId } = await f.session();
		const request =
			"/design Research brief.txt; request any extra model allowance with d3r_request_extension, then save and report within the approved budget.";
		const pending = f.prompt(sessionId, request);
		const extensions = () =>
			j.permissions.filter(({ toolCall }) =>
				toolCall.title?.startsWith("Extend request budget"),
			);
		const contexts = (role: string) =>
			roleRequests(j.requests, role).map(({ context }) => context);
		try {
			await vi.waitFor(() =>
				expect(extensions()).toHaveLength(Object.keys(grants).length),
			);
			for (const role of ["researcher", "aggregator"] as const) {
				expect(contexts(role)).toHaveLength(JOURNEY_BUDGET.maxTurns);
				const permission = extensions().find(({ toolCall }) =>
					toolCall.title?.includes(`(${role})`),
				)!;
				expect(permission.toolCall).toMatchObject({
					title: `Extend request budget (${role}): 3 -> 6 (hard cap 6)`,
					rawInput: {
						reason:
							role === "researcher"
								? "Save research evidence and synthesize the report"
								: "Inspect remaining local constraints",
						additionalRequests: 3,
						currentLimit: 3,
						requestedLimit: 6,
						maxTotalTurns: 6,
					},
				});
				expect(permission.options.map(({ kind }) => kind)).toEqual(
					permissionKinds,
				);
			}
			await f.peer.agent.request("session/list", {});
			expect(contexts("researcher")).toHaveLength(JOURNEY_BUDGET.maxTurns);
			await expect(
				readFile(resolve(j.cwd, "research.md")),
			).rejects.toMatchObject({ code: "ENOENT" });
			grants.researcher.resolve("allow_scope");
			await vi.waitFor(() =>
				expect(
					journeyTools(f.updates).findLast(
						(update) => update.title === "researcher",
					)?.status,
				).toBe("completed"),
			);
			expect(contexts("researcher")).toHaveLength(JOURNEY_BUDGET.maxTotalTurns);
			expect(contexts("aggregator")).toHaveLength(JOURNEY_BUDGET.maxTurns);
			grants.aggregator.resolve(true);
			await expectStop(pending);
		} finally {
			grants.researcher.resolve(false);
			grants.aggregator.resolve(false);
			await f.cancel(sessionId);
			await pending;
		}
		const researcher = contexts("researcher");
		const firstExtended = researcher[JOURNEY_BUDGET.maxTurns];
		expect(
			firstExtended.messages.slice(
				0,
				researcher[JOURNEY_BUDGET.maxTurns - 1].messages.length,
			),
		).toEqual(researcher[JOURNEY_BUDGET.maxTurns - 1].messages);
		expect(journeyResultText(firstExtended, "d3r_request_extension")).toMatch(
			/approved.*invocation only/i,
		);
		expect(journeyResult(firstExtended, "d3r_request_extension")).toMatchObject(
			{ isError: false },
		);
		await expect(
			readFile(resolve(j.cwd, "research.md"), "utf8"),
		).resolves.toContain("The queue must retain acknowledged jobs.");
		expect(
			journeyTools(f.updates).findLast(
				(update) => update.title === "researcher",
			),
		).toMatchObject({
			status: "completed",
			rawOutput: { status: "completed", summary },
		});
		expect(
			journeyTools(f.updates).findLast(
				(update) => update.title === "aggregator",
			),
		).toMatchObject({
			status: "failed",
			rawOutput: { error: expect.stringContaining("request_limit") },
		});
		expect(extensions()).toHaveLength(Object.keys(grants).length);
		for (const role of ["researcher", "aggregator"]) {
			expect(contexts(role)).toHaveLength(JOURNEY_BUDGET.maxTotalTurns);
			expect(scripts[role]).toHaveLength(1);
			contexts(role).forEach((context, index) => {
				const limit =
					index < JOURNEY_BUDGET.maxTurns
						? JOURNEY_BUDGET.maxTurns
						: JOURNEY_BUDGET.maxTotalTurns;
				expect(context.systemPrompt).toContain(
					`Response ${index + 1} of ${limit}`,
				);
				expect(context.systemPrompt).toContain(
					`Remaining model requests: ${limit - index}, including this response`,
				);
				expect(context.systemPrompt).toContain("Hard cap: 6");
				expect(
					context.systemPrompt?.match(/\[D3R request budget -/g),
				).toHaveLength(1);
				expect(
					context.messages.filter((message) => message.role === "user"),
				).toHaveLength(1);
				expect(JSON.stringify(context.messages)).toContain(request);
				expect(JSON.stringify(context.messages)).not.toContain(
					"[D3R request budget",
				);
			});
		}
		expect(
			researcher[0].tools?.find(({ name }) => name === "d3r_request_extension")
				?.parameters,
		).toMatchObject({
			type: "object",
			required: ["reason"],
			properties: {
				reason: { type: "string", minLength: 1 },
				additionalRequests: {
					type: "integer",
					exclusiveMinimum: 0,
					maximum: 50,
				},
			},
		});
		expect(JSON.stringify(await f.saved(sessionId))).not.toContain(
			"[D3R request budget",
		);
		expect(
			journeyTools(f.updates)
				.filter((update) => update.title === "d3r_request_extension")
				.map(journeyToolText)
				.join("\n"),
		).toContain("hard-cap headroom");
	});

	// oxlint-disable-next-line max-statements -- Denial and permission-dialog cancellation leave both recon roles enough initial budget to save partial findings.
	it("finalizes partial reports after denied and cancelled extensions without repeated permission prompts", async () => {
		const roles = ["researcher", "aggregator"] as const;
		const scripts: JourneyScripts = Object.fromEntries(
			roles.map((role) => [
				role,
				[
					call("d3r_request_extension", {
						reason: `Gather more evidence for ${role}`,
						additionalRequests: 3,
					}),
					[
						...call("d3r_request_extension", {
							reason: "Retry must not prompt",
							additionalRequests: 1,
						}),
						...call("write_file", {
							path: `${role}-partial.md`,
							content: `Partial ${role} findings: additional research was not authorized.\n`,
						}),
						...journeyReport(
							`Partial ${role} findings; further evidence remains unverified.`,
						),
					],
					reply(
						`Saved partial ${role} findings within the original allowance.`,
					),
					reply("Unapproved extra request"),
				],
			]),
		);
		const j = await open(scripts, {
			createRuntime: (options) =>
				createEmbeddedRuntime({
					...options,
					...(options.budgetLabel === "workflow summary" ? {} : JOURNEY_BUDGET),
				}),
		});
		j.approval.decide = async ({ toolCall }) => {
			if (toolCall.title?.startsWith("Extend request budget (researcher)")) {
				return false;
			}
			if (toolCall.title?.startsWith("Extend request budget (aggregator)")) {
				return "cancelled";
			}
			return true;
		};
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(
			f.prompt(
				sessionId,
				"/design Gather evidence; use d3r_request_extension if needed, but save partial findings and report limitations if not approved.",
			),
		);
		const extensions = j.permissions.filter(({ toolCall }) =>
			toolCall.title?.startsWith("Extend request budget"),
		);
		expect(extensions).toHaveLength(roles.length);
		await Promise.all(
			roles.map(async (role) => {
				const contexts = roleRequests(j.requests, role).map(
					({ context }) => context,
				);
				expect(contexts).toHaveLength(JOURNEY_BUDGET.maxTurns);
				expect(scripts[role]).toHaveLength(1);
				expect(
					extensions.filter(({ toolCall }) =>
						toolCall.title?.includes(`(${role})`),
					),
				).toHaveLength(1);
				expect(
					journeyResult(contexts[1], "d3r_request_extension"),
				).toMatchObject({ isError: true });
				expect(
					journeyResultText(contexts[1], "d3r_request_extension"),
				).toContain("Budget unchanged");
				expect(
					journeyResultText(contexts.at(-1)!, "d3r_request_extension"),
				).toContain("already denied");
				contexts.forEach((context, index) => {
					expect(context.systemPrompt).toContain(`Response ${index + 1} of 3`);
					expect(context.systemPrompt).toContain(
						`Remaining model requests: ${JOURNEY_BUDGET.maxTurns - index}`,
					);
					if (index > 0) {
						expect(context.systemPrompt).toContain("No extension is available");
					}
					expect(JSON.stringify(context.messages)).not.toContain(
						"[D3R request budget",
					);
				});
				await expect(
					readFile(resolve(j.cwd, `${role}-partial.md`), "utf8"),
				).resolves.toBe(
					`Partial ${role} findings: additional research was not authorized.\n`,
				);
				const card = journeyTools(f.updates).findLast(
					(update) => update.title === role,
				)!;
				expect(card).toMatchObject({
					status: "completed",
					rawOutput: {
						status: "completed",
						summary: `Partial ${role} findings; further evidence remains unverified.`,
					},
				});
				expect(journeyToolText(card)).toContain(
					`Saved partial ${role} findings within the original allowance.`,
				);
			}),
		);
		expect(
			j.permissions.filter(({ toolCall }) => toolCall.title === "write_file"),
		).toHaveLength(roles.length);
		for (const { options } of j.permissions) {
			expect(options.map(({ kind }) => kind)).toEqual(permissionKinds);
		}
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		expect(JSON.stringify(await f.saved(sessionId))).not.toContain(
			"Request extension approved",
		);
	});
});
