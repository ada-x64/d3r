import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeJourneySuite } from "./harness.ts";
import {
	callWith,
	expectStop,
	journeyCall as call,
	journeyDone as done,
	journeyPhaseReply as phaseReply,
	journeyResult as result,
	journeyResultText as resultText,
	journeyText,
	lastRequest,
	reply,
	roleRequests,
	writeFiles,
	type JourneyScripts,
} from "./helpers.ts";

/** Ancestor instructions reach every native role without widening workspace access. */
describe("native ACP instruction journey", () => {
	const { open } = nativeJourneySuite();

	// oxlint-disable-next-line max-statements -- Inheritance, implementation, confinement and reload form one resource-pin journey.
	it("inherits the charter, reads linked standards before implementation, and retains the pin after reload", async () => {
		const charterText = await readFile(
			new URL("../../../../AGENTS.md", import.meta.url),
			"utf8",
		);
		const charter = charterText.trim();
		const workspace = "repo/worktrees/topic";
		const goal =
			"Create marker.txt using the inherited instructions, then review and audit it.";
		const scripts: JourneyScripts = {
			router: [
				call("d3r_start_phase", {
					phase: "develop",
					mode: "auto",
					brief: { goal, context: "Work offline.", acceptanceCriteria: [goal] },
				}),
				phaseReply("d3r_start_phase", "Inherited instructions applied"),
				reply("Still using the original inherited instructions."),
			],
			implementor: [
				call("read_file", { path: "CONTRIBUTING.md" }, "conventions-read"),
				call(
					"read_file",
					{ path: "docs/data-oriented-design.md" },
					"standards-read",
				),
				call("read_file", { path: "docs/testing.md" }, "testing-read"),
				callWith("write_file", (context) => {
					const prefix =
						/Marker prefix: ([a-z-]+)/.exec(
							resultText(context, "standards-read"),
						)?.[1] ?? "missing-standard-";
					const marker =
						[
							...(context.systemPrompt ?? "").matchAll(/^Marker: ([a-z-]+)$/gm),
						].at(-1)?.[1] ?? "missing-instructions";
					return { path: "marker.txt", content: prefix + marker };
				}),
				call("read_file", { path: "../../unrelated.txt" }, "parent-read"),
				...done("Created the instructed marker.", { allDone: true }),
			],
			reviewer: done("Reviewed instructions.", { review: "approved" }),
			auditor: done("Audited inherited instructions."),
		};
		const j = await open(scripts, { workspace, routerShortcuts: false });
		const layers = [
			[
				"AGENTS.md",
				`${charter}\n\nWrite the last Marker value with the prefix required by the linked standards to marker.txt.\nMarker: root`,
			],
			["repo/AGENT.md", "Marker: repo-singular"],
			["repo/AGENTS.md", "Marker: repo-plural"],
			["repo/worktrees/AGENTS.md", "Marker: closer"],
			[`${workspace}/AGENTS.md`, "Marker: topic"],
		];
		const legacy = [
			["home/.agents/agents.md", "Legacy home guidance."],
			[`${workspace}/.agents/agents.md`, "Legacy cwd guidance."],
		];
		const excluded = "PARENT_ONLY_DO_NOT_LOAD";
		await writeFiles(j.root, {
			...Object.fromEntries([...layers, ...legacy]),
			[`${workspace}/CONTRIBUTING.md`]:
				"Read docs/data-oriented-design.md and docs/testing.md before changing the marker.",
			[`${workspace}/docs/data-oriented-design.md`]:
				"Marker prefix: checked-\nKeep the output as plain text.",
			[`${workspace}/docs/testing.md`]:
				"Verify the marker contains the standards prefix followed by the most specific Marker value.",
			"repo/.git/config": "[core]\n\tbare = false\n",
			"repo/.agents/vault/notes/fixture.md": "Ancestor vault boundary.",
			"repo/unrelated.txt": excluded,
			"repo/.agents/agents.md": excluded,
			"repo/.agents/agents/implementor.md": `---\nname: implementor\ntier: moderate\ndescription: Parent override\ncapabilities: [read, write]\n---\n${excluded}`,
			"repo/.agents/skills/parent/SKILL.md": `---\nname: parent-only\ndescription: ${excluded}\n---\n${excluded}`,
		});
		const f = await j.connect();
		const { sessionId } = await f.session();
		expect(j.requests).toEqual([]);
		await expectStop(f.prompt(sessionId, goal));
		const state = await f.state(sessionId);
		const pin = state.resources.instructions;
		expect(typeof pin).toBe("string");
		expect(pin).not.toBe("");
		expect(state.inner?.engine).toMatchObject({
			command: "develop",
			mode: "auto",
			status: "completed",
		});
		for (const role of ["router", "implementor", "reviewer", "auditor"]) {
			const prompt =
				roleRequests(j.requests, role)[0].context.systemPrompt ?? "";
			expect(prompt).toContain(charter);
			expect(prompt).toMatch(/linked engineering\/testing standards/);
			expect(prompt).not.toMatch(
				/do not deep-read|too large to skim|~500 lines/,
			);
			let previous = -1;
			for (const token of layers.flatMap(([path, text]) => [
				resolve(j.root, path),
				text,
			])) {
				const index = prompt.indexOf(token);
				expect(index, `${role}: ${token}`).toBeGreaterThan(previous);
				previous = index;
			}
		}
		for (const [path, text] of legacy) {
			expect(pin).toContain(resolve(j.root, path));
			expect(pin).toContain(text);
		}
		const implemented = lastRequest(j.requests, "implementor").context;
		expect(result(implemented, "write_file")).toMatchObject({ isError: false });
		expect(result(implemented, "parent-read")).toMatchObject({ isError: true });
		await expect(readFile(resolve(j.cwd, "marker.txt"), "utf8")).resolves.toBe(
			"checked-topic",
		);
		expect(journeyText(f.updates)).toContain("Inherited instructions applied");
		expect(
			JSON.stringify([state.resources, j.requests, f.updates]),
		).not.toContain(excluded);
		const reads = j.requests.flatMap(({ context }) =>
			context.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === "read_file"
					? [message.toolCallId]
					: [],
			),
		);
		expect(new Set(reads)).toEqual(
			new Set([
				"conventions-read",
				"standards-read",
				"testing-read",
				"parent-read",
			]),
		);
		for (const id of ["conventions-read", "standards-read", "testing-read"]) {
			expect(result(implemented, id)).toMatchObject({ isError: false });
		}

		const changed = "Marker: changed-parent";
		await writeFiles(j.root, { "repo/AGENT.md": changed });
		await f.closeSession(sessionId);
		await f.close();
		const beforeReload = j.requests.length;
		const resumed = await j.connect();
		await resumed.load(sessionId);
		expect(j.requests).toHaveLength(beforeReload);
		await expectStop(
			resumed.prompt(sessionId, "Which instructions still apply?"),
		);
		const restored = await resumed.state(sessionId);
		expect(restored.resources.instructions).toBe(pin);
		for (const { context } of j.requests) {
			expect(context.systemPrompt).toContain(pin);
			expect(context.systemPrompt).not.toContain(changed);
		}
		expect(j.permissions.map(({ toolCall }) => toolCall.title)).toEqual([
			expect.stringMatching(/^Trust workspace/),
			expect.stringMatching(/^Trust workspace/),
		]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
