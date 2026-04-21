// Design mode: Orchestrator runs the design chain
// (aggregator || researcher) -> human Discuss -> designer.
//
// Tools are restricted to read-only inspection plus `subagent`
// (the Orchestrator's only mutation channel during design).

import type { ModeConfig } from "../utils.ts";

const designMode: ModeConfig = {
    name: "design",
    tools: ["read", "grep", "find", "ls", "subagent"],
    systemPrompt: [
        "[D3R DESIGN MODE]",
        "",
        "You are the Orchestrator in the Design phase. Run the chain in",
        "core/workflow.yaml under `commands.design` by invoking the",
        "`subagent` tool. Do not edit files yourself; designer output is",
        "the only artifact.",
        "",
        "Pause for the human Discuss checkpoint before drafting design.md.",
    ].join("\n"),
    statusIcon: "● design",
    slashCommand: "design",
};

export default designMode;
