import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Keep topic names portable while leaving room for readable goal text. */
const MAX_TOPIC_LENGTH = 80;

/** The UUID prefix distinguishes fresh accepted tasks without a model request. */
const TOPIC_SUFFIX_LENGTH = 8;

/** Persisted and supplied topics must already be safe slugs, including at the strict end of input. */
export const WorkflowTopicName = z
	.string()
	.min(1)
	.max(MAX_TOPIC_LENGTH)
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"Use a lowercase ASCII kebab slug without whitespace or path separators",
	)
	// Provider regex engines may not support lookarounds; keep strict end-of-input validation local.
	.refine(
		(topic) => !/\s/.test(topic),
		"Topic names must not contain whitespace",
	)
	.refine(
		(topic) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(topic),
		"Topic names must not be reserved Windows device names",
	);

/** Call once when the runtime accepts a fresh task; persist and reuse the result across roles. */
export const createWorkflowTopicName = (goal: string): string => {
	const prefix =
		goal
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, MAX_TOPIC_LENGTH - TOPIC_SUFFIX_LENGTH - 1)
			.replace(/-+$/, "") || "topic";
	return WorkflowTopicName.parse(
		`${prefix}-${randomUUID().slice(0, TOPIC_SUFFIX_LENGTH)}`,
	);
};

/** Render one shared artifact map without generating a new topic or changing runtime or vault state. */
export const renderWorkflowTopic = (topic: string): string => {
	const name = WorkflowTopicName.parse(topic);
	const designDirectory = `process/designs/${name}`;
	const taskDirectory = `process/tasks/${name}`;
	return [
		"## Shared topic",
		`Topic name: ${name}`,
		"",
		"Vault-relative defaults:",
		`- designDirectory: ${designDirectory}`,
		`- taskDirectory: ${taskDirectory}`,
		"",
		"Shared /design targets and sibling inputs:",
		`- aggregator: ${designDirectory}/remember.md`,
		`- researcher: ${designDirectory}/research.md`,
		`- designer: ${designDirectory}/design.md`,
		`- plan: ${designDirectory}/plan.md (alongside the design artifacts)`,
		"",
		"All roles must use the supplied topic and default paths unless explicit user paths take precedence. Do not choose an independent research notes filename or folder.",
		"Explicit user paths take precedence without moving existing artifacts.",
		"taskDirectory is the default only when no more specific task slice is provided. Follow the plan's explicit child-task names; do not invent conflicting independent task slugs.",
		"These paths do not assert that artifacts exist and do not authorize writes, vault initialization, or commits. Check for required inputs and obtain any required permissions separately.",
	].join("\n");
};
