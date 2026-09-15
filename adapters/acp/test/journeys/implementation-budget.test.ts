import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeJourneySuite } from "./harness.ts";
import {
	expectStop,
	JOURNEY_MODEL,
	journeyCall as call,
	journeyDone as done,
	journeyFailureStream,
	journeyPhaseReply as phaseReply,
	journeyResult as result,
	journeyResultText as resultText,
	journeyStream,
	journeyText,
	lastRequest,
	roleRequests,
	writeFiles,
	type JourneyScripts,
} from "./helpers.ts";

/** Inference limits must neither truncate implementation nor discard settled effects. */
describe("native ACP implementation resource journeys", () => {
	const { open } = nativeJourneySuite();
	const goal = "/develop auto Retain acknowledged jobs in queue.txt.";
	const content = "Retain acknowledged jobs.\n";
	const instructions = "Preserve the offline user's requirements.";
	const correction =
		"I selected a larger-context model. Continue the same implementation, preserve my note, and finish review and audit.";
	/** Only provider replies are scripted; the shipped graph owns role dispatch. */
	const develop = (implementor: JourneyScripts[string]): JourneyScripts => ({
		router: [
			call("d3r_start_phase", {
				phase: "develop",
				mode: "auto",
				brief: {
					goal,
					context: "No commits or network.",
					acceptanceCriteria: [goal],
				},
			}),
			phaseReply("d3r_start_phase", "Implementation status"),
			call("d3r_continue_phase", { instructions: correction }),
			phaseReply("d3r_continue_phase", "Implementation recovered"),
		],
		implementor,
		reviewer: [
			call("read_file", { path: "queue.txt" }),
			...done("Reviewed retained jobs.", { review: "approved" }),
		],
		auditor: [
			call("read_file", { path: "queue.txt" }),
			...done("Audited retained jobs."),
		],
	});

	it("writes after 103 reads without inference approval, then reviews and audits", async () => {
		const reads = 103;
		const j = await open(
			develop([
				...Array.from({ length: reads }, (_, index) =>
					call("read_file", { path: "brief.txt" }, `read-${index}`),
				),
				call("write_file", { path: "queue.txt", content }),
				...done("Implemented retained jobs.", { allDone: true }),
			]),
			{ routerShortcuts: false },
		);
		await writeFiles(j.cwd, { "brief.txt": content });
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(f.prompt(sessionId, goal));
		const workers = roleRequests(j.requests, "implementor");
		expect(workers.length).toBeGreaterThan(reads);
		const implemented = lastRequest(workers, "implementor").context;
		expect(resultText(implemented, `read-${reads - 1}`)).toContain(
			content.trim(),
		);
		expect(result(implemented, "write_file")).toMatchObject({ isError: false });
		expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(content);
		for (const { context } of j.requests) {
			expect(context.systemPrompt).toContain(instructions);
			expect(context.systemPrompt).not.toMatch(
				/\[D3R request budget|Remaining model requests|Hard cap:/i,
			);
			expect(context.tools?.map(({ name }) => name)).not.toContain(
				"d3r_request_extension",
			);
			expect(JSON.stringify(context.messages)).toContain(goal);
		}
		for (const role of ["implementor", "reviewer", "auditor"]) {
			const { context } = lastRequest(j.requests, role);
			expect(context.systemPrompt).toContain(`You are ${role}.`);
			expect(result(context, "d3r_report")).toMatchObject({ isError: false });
			if (role !== "implementor") {
				expect(resultText(context, "read_file")).toContain(content.trim());
			}
		}
		const state = await f.state(sessionId);
		expect(state.inner?.engine).toMatchObject({
			command: "develop",
			mode: "auto",
			status: "completed",
		});
		expect(journeyText(f.updates)).toContain("Audited retained jobs.");
		expect(JSON.stringify(f.updates)).not.toMatch(
			/request_limit|Extend request budget|Remaining model requests/i,
		);
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
		]);
	});

	// oxlint-disable-next-line max-statements -- Settled effects, durable reload, and same-role recovery form one acceptance journey.
	it("resumes a context-limited implementor on a larger model without rewriting", async () => {
		const larger = { ...JOURNEY_MODEL, id: "larger", contextWindow: 131_072 };
		const j = await open(
			develop([
				call("write_file", { path: "queue.txt", content }, "write"),
				call("read_file", { path: "queue.txt" }, "read"),
				[],
				call("read_file", { path: "queue.txt" }, "reread"),
				...done("Implemented without replay.", { allDone: true }),
			]),
			{
				routerShortcuts: false,
				models: [JOURNEY_MODEL, larger],
				streamResponse: (role, response) =>
					role === "implementor" && response.length === 0
						? journeyFailureStream(
								'400 {"error":{"code":"context_length_exceeded"}}',
							)
						: journeyStream(response),
			},
		);
		const f = await j.connect();
		const { sessionId } = await f.session();
		await expectStop(f.prompt(sessionId, goal));
		expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(content);
		const stopped = lastRequest(j.requests, "implementor").context;
		for (const id of ["write", "read"]) {
			expect(result(stopped, id)).toMatchObject({ isError: false });
		}
		expect(resultText(stopped, "read")).toContain(content.trim());
		const checkpoint = await f.checkpoint(sessionId);
		const { inner: waiting } = await f.state(sessionId);
		const [worker] = waiting!.engine!.records;
		expect(waiting!.engine).toMatchObject({
			status: "waiting",
			pause: { kind: "report" },
		});
		expect(worker).toMatchObject({
			role: "implementor",
			status: "waiting",
			outcome: { status: "needs_human" },
		});
		expect(worker).not.toHaveProperty("error");
		expect(waiting!.continuations).toEqual([
			expect.objectContaining({ recordId: worker.id }),
		]);
		expect(journeyText(f.updates)).toMatch(/context/i);
		expect(new Set(j.requests.map(({ role }) => role))).toEqual(
			new Set(["router", "implementor"]),
		);
		const beforeReload = j.requests.length;
		// A replayed identical write would erase this operator edit.
		const external = `${content}Operator note: retain this edit too.\n`;
		await writeFiles(j.cwd, { "queue.txt": external });
		await f.closeSession(sessionId);
		await f.close();
		const resumed = await j.connect();
		await resumed.load(sessionId);
		await expect(resumed.checkpoint(sessionId)).resolves.toEqual(checkpoint);
		await resumed.select(sessionId, larger);
		expect(j.requests).toHaveLength(beforeReload);
		await expectStop(resumed.prompt(sessionId, correction));
		const [recovery] = roleRequests(
			j.requests.slice(beforeReload),
			"implementor",
		);
		expect(recovery.model).toEqual(larger);
		expect(recovery.context.messages.slice(0, stopped.messages.length)).toEqual(
			stopped.messages,
		);
		expect(JSON.stringify(recovery.context.messages)).toContain(correction);
		expect(recovery.context.systemPrompt).toContain("You are implementor.");
		expect(recovery.context.systemPrompt).toContain(instructions);
		for (const [role, id] of [
			["implementor", "reread"],
			["reviewer", "read_file"],
			["auditor", "read_file"],
		]) {
			const observed = resultText(lastRequest(j.requests, role).context, id);
			expect(observed).toContain(content.trim());
			expect(observed).toContain("Operator note: retain this edit too.");
		}
		const { inner: completed } = await resumed.state(sessionId);
		expect(completed!.engine!.status).toBe("completed");
		expect(completed!.engine!.records[0]).toMatchObject({
			id: worker.id,
			role: "implementor",
			status: "completed",
		});
		expect(
			completed!
				.engine!.records.filter(
					(record) => record.kind === "agent" && record.status === "completed",
				)
				.map(({ role }) => role),
		).toEqual(["implementor", "reviewer", "auditor"]);
		expect(completed!.continuations ?? []).toEqual([]);
		expect(await readFile(resolve(j.cwd, "queue.txt"), "utf8")).toBe(external);
		expect(journeyText(resumed.updates)).toContain("Audited retained jobs.");
	});
});
