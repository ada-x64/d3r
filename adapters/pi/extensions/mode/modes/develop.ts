// Develop mode: Orchestrator runs the develop loop
// loop(max=3): implementor -> parallel(reviewer).
//
// Tools: read + bash inspection + `subagent` (chain runner).
// The Orchestrator delegates the actual implementation to the
// implementor subagent and verification to reviewer subagents.
//
// Per D19: the implementor signals an unrecoverable failure by
// emitting a top-level `## BLOCKED` section. `scanForBlocked` is the
// regex-based detector consumed by mode/index.ts in `turn_end`.

import type { ModeConfig } from "../utils.ts";

const developMode: ModeConfig = {
	name: "develop",
	tools: ["read", "grep", "find", "ls", "bash", "subagent"],
	systemPrompt: [
		"[D3R DEVELOP MODE]",
		"",
		"You are the Orchestrator in the Develop phase. Run the loop in",
		"core/workflow.yaml under `commands.develop` by invoking the",
		"`subagent` tool. Each iteration: implementor (single) followed",
		"by reviewer (parallel, count = reviews_default).",
		"",
		"If the implementor's output begins with a top-level `## BLOCKED`",
		"section, exit the loop early and surface the reason to the user.",
		"Honor the loop's `max` (default 3).",
	].join("\n"),
	statusIcon: "▲ develop",
	slashCommand: "develop",
};

// Multiline-anchored match for a top-level "## BLOCKED" heading.
const BLOCKED_RE = /^## BLOCKED\b/m;

export interface BlockedScan {
	readonly blocked: boolean;
	readonly retries: number;
}

// Count occurrences of "## BLOCKED" headings in a text blob.
// Returns `{ blocked, retries }` where `retries` is the number of
// matches in this single text (typically 0 or 1; >1 only if an agent
// emits multiple BLOCKED sections in one turn). The persistent retry
// counter lives in mode/index.ts state.
export const scanForBlocked = (text: string): BlockedScan => {
	if (!BLOCKED_RE.test(text)) {
		return { blocked: false, retries: 0 };
	}
	const all = text.match(/^## BLOCKED\b/gm);
	return { blocked: true, retries: all ? all.length : 1 };
};

export default developMode;
