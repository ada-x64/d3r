// Mode extension shared types and helpers.
//
// Per design.md §2.5 + Open Question #2: each per-mode config exports
// a local `ModeConfig`. The cycle order is fixed:
//   normal -> design -> delegate -> develop -> normal
//
// "normal" has no ModeConfig: it represents pi's default tool set and
// no system-prompt augmentation.

export type ModeName = "normal" | "design" | "delegate" | "develop";

export interface ModeConfig {
    readonly name: Exclude<ModeName, "normal">;
    readonly tools: readonly string[];
    readonly systemPrompt: string;
    readonly statusIcon: string;
    readonly slashCommand: string;
}

export const MODE_ORDER: readonly ModeName[] = [
    "normal",
    "design",
    "delegate",
    "develop",
] as const;

export const cycleForward = (current: ModeName): ModeName => {
    const idx = MODE_ORDER.indexOf(current);
    // oxlint-disable-next-line no-magic-numbers
    const next = idx === -1 ? 0 : (idx + 1) % MODE_ORDER.length;
    return MODE_ORDER[next];
};

// Tool set used when no mode is active. Mirrors plan-mode's
// NORMAL_MODE_TOOLS posture: the default authoring kit plus subagent
// for Orchestrator delegation.
export const NORMAL_TOOLS: readonly string[] = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "subagent",
] as const;
