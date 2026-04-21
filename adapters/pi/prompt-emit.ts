// Emits one pi slash-command prompt per workflow command.
// Each prompt is markdown that instructs the Orchestrator to invoke
// the `subagent` tool with the chain spelled out in core/workflow.yaml.
//
// pi idioms honored:
//   - `{previous}` placeholder for chained step output
//   - parallel max 8 (subagent extension cap)
//   - `## BLOCKED` retry escape hatch called out in develop's prompt

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChainStep, Workflow } from "../../core/schema.ts";

// oxlint-disable-next-line no-magic-numbers
const PARALLEL_MAX = 8;
// oxlint-disable-next-line no-magic-numbers
const DEFAULT_LOOP_MAX = 3;
// oxlint-disable-next-line no-magic-numbers
const DEFAULT_REVIEWS = 1;

const renderStep = (step: ChainStep, depth = 0): string => {
    const indent = "  ".repeat(depth);
    switch (step.kind) {
        case "agent": {
            return `${indent}- Invoke \`subagent\` with \`{ agent: "${step.name}", task: "<task derived from {previous}>" }\`.`;
        }
        case "parallel": {
            const agents = step.agents.slice(0, PARALLEL_MAX);
            const list = agents.map((a) => `"${a}"`).join(", ");
            return `${indent}- Invoke \`subagent\` in parallel mode with \`{ tasks: [ ${list}.map(a => ({ agent: a, task: "<derived from {previous}>" })) ] }\` (max ${PARALLEL_MAX} concurrent).`;
        }
        case "human": {
            return `${indent}- **Human checkpoint:** ${step.prompt}. Pause and surface the question to the user before continuing.`;
        }
        case "loop": {
            const header = `${indent}- Loop up to ${step.max} times:`;
            const body = step.body
                .map((s) => renderStep(s, depth + 1))
                .join("\n");
            return `${header}\n${body}`;
        }
    }
};

const findLoopMax = (chain: readonly ChainStep[]): number => {
    for (const s of chain) {
        if (s.kind === "loop") {
            return s.max;
        }
    }
    return DEFAULT_LOOP_MAX;
};

const renderCommand = (
    name: string,
    cmd: Workflow["commands"][string],
): string => {
    const lines: string[] = [];
    lines.push(`# /${name}`);
    lines.push("");
    lines.push(cmd.description);
    lines.push("");
    lines.push("## Chain");
    lines.push("");
    lines.push("You are the Orchestrator (a thin router). Execute the");
    lines.push("following chain by invoking the `subagent` tool. Pass each");
    lines.push("step's output to the next via the `{previous}` placeholder.");
    lines.push("");
    for (const step of cmd.chain) {
        lines.push(renderStep(step));
    }
    lines.push("");
    if (name === "develop") {
        const loopMax = findLoopMax(cmd.chain);
        const reviews = cmd.reviews_default ?? DEFAULT_REVIEWS;
        lines.push("## Retry semantics");
        lines.push("");
        lines.push(
            "If the implementor's output contains a top-level `## BLOCKED`",
        );
        lines.push(
            "section, surface the reason to the user and exit the loop early.",
        );
        lines.push(
            `Otherwise honor the loop's \`max\` (default ${loopMax}) and the \`reviews_default\` (${reviews}) review count.`,
        );
        lines.push("");
    }
    return lines.join("\n");
};

export const emitPrompts = async (
    workflow: Workflow,
    outDir: string,
): Promise<string[]> => {
    await mkdir(outDir, { recursive: true });
    const entries = Object.entries(workflow.commands);
    const written = await Promise.all(
        entries.map(async ([name, cmd]) => {
            const file = path.join(outDir, `${name}.md`);
            await writeFile(file, `${renderCommand(name, cmd)}\n`, "utf8");
            return file;
        }),
    );
    return written;
};
