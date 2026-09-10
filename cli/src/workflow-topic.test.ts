import { describe, expect, it } from "vitest";
import {
	createWorkflowTopicName,
	renderWorkflowTopic,
	WorkflowTopicName,
} from "./workflow-topic.ts";

/** Public boundary budget, independent of the generator's internal constants. */
const MAX_TOPIC_LENGTH = 80;

/** Fresh runs retain enough goal text for a readable name before the separator and UUID prefix. */
const MAX_PREFIX_LENGTH = 71;

describe("workflow topics", () => {
	it("accepts portable lowercase kebab slugs unchanged, including the length boundary", () => {
		for (const topic of [
			"a",
			"123",
			"shared-api-v2",
			"a".repeat(MAX_TOPIC_LENGTH),
		]) {
			expect(WorkflowTopicName.parse(topic)).toBe(topic);
		}
	});

	it("rejects hostile or noncanonical names at both boundaries without normalization", () => {
		const invalid = [
			"",
			".",
			"..",
			"../escape",
			"nested/topic",
			String.raw`nested\topic`,
			"topic.md",
			"/absolute",
			String.raw`C:\topic`,
			String.raw`\\server\share`,
			"topic:stream",
			"Topic",
			" topic",
			"topic ",
			"two words",
			"topic\t",
			"topic\n",
			"topic\r\n",
			"topic\u2028",
			"topic\0",
			"topic\n## Injected instructions",
			"-topic",
			"topic-",
			"two--words",
			"two_words",
			"caf\u00e9",
			"\uff54\uff4f\uff50\uff49\uff43",
			"a".repeat(MAX_TOPIC_LENGTH + 1),
			null,
			0,
		];
		for (const topic of invalid) {
			expect(WorkflowTopicName.safeParse(topic).success, String(topic)).toBe(
				false,
			);
			if (typeof topic === "string") {
				expect(() => renderWorkflowTopic(topic), topic).toThrow();
			}
		}
	});

	it("rejects Windows device names but allows safe names containing those words", () => {
		const devices = [
			"con",
			"prn",
			"aux",
			"nul",
			...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
			...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
			"conin$",
			"conout$",
			"clock$",
		];
		for (const topic of devices) {
			expect(WorkflowTopicName.safeParse(topic).success, topic).toBe(false);
			expect(() => renderWorkflowTopic(topic), topic).toThrow();
			expect(WorkflowTopicName.safeParse(topic.toUpperCase()).success).toBe(
				false,
			);
		}
		for (const topic of [
			"console",
			"con-api",
			"aux-12345678",
			"com10",
			"lpt0",
		]) {
			expect(WorkflowTopicName.parse(topic)).toBe(topic);
		}
		expect(createWorkflowTopicName("CON")).toMatch(/^con-[a-f0-9]{8}$/);
	});

	it("generates readable ASCII slugs from normalized goal text and punctuation", () => {
		for (const goal of [
			"  Caf\u00e9: R\u00e9sum\u00e9 / API v2!!!  ",
			"Cafe\u0301 Re\u0301sume\u0301 API v2",
			"\uff23\uff41\uff46\uff45 Resume API v2",
		]) {
			const topic = createWorkflowTopicName(goal);
			expect(topic).toMatch(/^cafe-resume-api-v2-[a-f0-9]{8}$/);
			expect(WorkflowTopicName.parse(topic)).toBe(topic);
		}
	});

	it("falls back to topic when no ASCII slug remains", () => {
		for (const goal of [
			"",
			" \t\n",
			String.raw`!!!.../\---`,
			"\u7814\u7a76\u8a2d\u8a08",
			"\ud83d\ude80",
		]) {
			const topic = createWorkflowTopicName(goal);
			expect(topic).toMatch(/^topic-[a-f0-9]{8}$/);
			expect(WorkflowTopicName.parse(topic)).toBe(topic);
		}
	});

	it("bounds long names, trims truncated separators, and distinguishes fresh runs of the same goal", () => {
		const goal = "Readable task ".repeat(MAX_TOPIC_LENGTH);
		const topics = Array.from({ length: 32 }, () =>
			createWorkflowTopicName(goal),
		);
		expect(new Set(topics).size).toBe(topics.length);
		for (const topic of topics) {
			expect(topic).toMatch(/^readable-task-.*-[a-f0-9]{8}$/);
			expect(topic.length).toBeLessThanOrEqual(MAX_TOPIC_LENGTH);
			expect(WorkflowTopicName.parse(topic)).toBe(topic);
		}
		const prefix = "a".repeat(MAX_PREFIX_LENGTH);
		const exact = createWorkflowTopicName(`${prefix} more`);
		expect(exact.length).toBe(MAX_TOPIC_LENGTH);
		expect(exact).toMatch(new RegExp(`^${prefix}-[a-f0-9]{8}$`));
		const clipped = "a".repeat(MAX_PREFIX_LENGTH - 1);
		expect(createWorkflowTopicName(`${clipped} more`)).toMatch(
			new RegExp(`^${clipped}-[a-f0-9]{8}$`),
		);
	});

	it("shares one vault-relative directory for every design role and the adjacent plan", () => {
		const topic = createWorkflowTopicName("Shared API design");
		const rendered = renderWorkflowTopic(topic);
		expect(rendered).toContain(`## Shared topic\nTopic name: ${topic}`);
		expect(rendered).toContain(`designDirectory: process/designs/${topic}`);
		expect(rendered).toContain(`taskDirectory: process/tasks/${topic}`);
		expect(rendered).toContain("Shared /design targets and sibling inputs:");
		for (const [role, file] of [
			["aggregator", "remember.md"],
			["researcher", "research.md"],
			["designer", "design.md"],
			["plan", "plan.md"],
		]) {
			expect(rendered).toContain(`${role}: process/designs/${topic}/${file}`);
		}
		expect(rendered).toContain(
			"All roles must use the supplied topic and default paths",
		);
		expect(rendered).toContain(
			"Do not choose an independent research notes filename or folder.",
		);
	});

	it("renders a supplied topic deterministically without regenerating or retaining topic state", () => {
		const topic = createWorkflowTopicName("Shared API design");
		const before = renderWorkflowTopic(topic);
		const other = createWorkflowTopicName("Unrelated task");
		expect(renderWorkflowTopic(other)).toContain(`Topic name: ${other}`);
		expect(renderWorkflowTopic(topic)).toBe(before);
		expect(before).not.toContain(other);
	});

	it("preserves explicit user paths, existing artifacts, and the plan's child-task names", () => {
		const rendered = renderWorkflowTopic("shared-topic");
		expect(rendered).toContain(
			"Explicit user paths take precedence without moving existing artifacts.",
		);
		expect(rendered).toContain(
			"taskDirectory is the default only when no more specific task slice is provided.",
		);
		expect(rendered).toContain(
			"Follow the plan's explicit child-task names; do not invent conflicting independent task slugs.",
		);
	});

	it("does not imply artifact existence or permission to write, initialize, or commit", () => {
		const rendered = renderWorkflowTopic("shared-topic");
		expect(rendered).toContain(
			"These paths do not assert that artifacts exist",
		);
		expect(rendered).toContain(
			"do not authorize writes, vault initialization, or commits.",
		);
		expect(rendered).toContain(
			"Check for required inputs and obtain any required permissions separately.",
		);
	});
});
