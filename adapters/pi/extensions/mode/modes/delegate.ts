// Delegate mode: Orchestrator runs the delegate chain
// planner -> schemer.
//
// Read-only inspection plus `subagent`. The Orchestrator does not
// write schema files itself; the schemer subagent does.

import type { ModeConfig } from "../utils.ts";

const delegateMode: ModeConfig = {
    name: "delegate",
    tools: ["read", "grep", "find", "ls", "subagent"],
    systemPrompt: [
        "[D3R DELEGATE MODE]",
        "",
        "You are the Orchestrator in the Delegate phase. Run the chain in",
        "core/workflow.yaml under `commands.delegate` by invoking the",
        "`subagent` tool. Planner produces the area breakdown; schemer",
        "renders each area into a schema doc.",
        "",
        "Do not draft schemas yourself; surface schemer output to the user.",
    ].join("\n"),
    statusIcon: "◆ delegate",
    slashCommand: "delegate",
};

export default delegateMode;
