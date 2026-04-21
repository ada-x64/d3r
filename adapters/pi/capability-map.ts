// Maps harness-agnostic Capability values (core/schema.ts) to the
// concrete pi tool names the compiled agent's frontmatter must list.

import type { Capability } from "../../core/schema.ts";

export const piToolMap: Record<Capability, string[]> = {
	read: ["read", "grep", "find", "ls"],
	write: ["write"],
	edit: ["edit"],
	bash: ["bash"],
	web: ["bash"], // pi has no first-class web tool yet
	delegate: ["subagent"],
};
