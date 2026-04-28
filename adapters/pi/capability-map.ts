// Maps harness-agnostic Capability values (core/schema.ts) to the
// concrete pi tool names the compiled agent's frontmatter must list.

import type { Capability } from "../../core/schema.ts";

export const piToolMap: Record<Capability, string[]> = {
	read: ["read", "grep", "find", "ls"],
	write: ["write"],
	edit: ["edit"],
	bash: ["bash"],
	web: [], // web is satisfied by the web_search tool listed in tools:
	delegate: ["subagent"],
};
