// D3R mode extension.
//
// Per design.md §2.5 and D22/D23: a single pi extension that owns
// three D3R phase modes (design, delegate, develop) plus a "normal"
// resting state.
//
// Surface:
//   - Ctrl+Shift+Tab   cycles forward through the modes (D23).
//   - /design /delegate /develop   toggle in/out of the named mode.
//   - --design --delegate --develop   start pi already in that mode.
//
// Behavior:
//   - Each mode swaps the active tool set (`pi.setActiveTools`).
//   - Each mode injects a system-prompt suffix via
//     `before_agent_start` (D23).
//   - State persisted via `pi.appendEntry("mode", ...)` so it
//     survives `pi -c` (design.md Glossary).
//   - Develop only: `turn_end` scans the assistant message for
//     `## BLOCKED`. On hit, persist + notify + exit to normal.
//     Bail with a fatal notify at retries >= 3 (D19).

import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import designMode from "./modes/design.ts";
import delegateMode from "./modes/delegate.ts";
import developMode, { scanForBlocked } from "./modes/develop.ts";
import type { ModeConfig, ModeName } from "./utils.ts";
// oxlint-disable-next-line no-duplicate-imports
import { NORMAL_TOOLS } from "./utils.ts";

// oxlint-disable-next-line no-magic-numbers
const MAX_RETRIES = 3;

const MODES: Readonly<Record<Exclude<ModeName, "normal">, ModeConfig>> = {
    design: designMode,
    delegate: delegateMode,
    develop: developMode,
};

interface ModeState {
    currentMode: ModeName;
    developRetries: number;
}

interface ModeEntryData {
    currentMode?: ModeName;
    developRetries?: number;
}

// Type guard for assistant messages (mirrors plan-mode's helper).
const isAssistantMessage = (m: unknown): m is AssistantMessage => {
    const msg = m as { role?: string; content?: unknown };
    return msg.role === "assistant" && Array.isArray(msg.content);
};

const getAssistantText = (message: AssistantMessage): string =>
    message.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n");

const piExtension = (pi: ExtensionAPI): void => {
    const state: ModeState = {
        currentMode: "normal",
        developRetries: 0,
    };

    // CLI flags (D23).
    pi.registerFlag("design", {
        description: "Start in D3R design mode",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("delegate", {
        description: "Start in D3R delegate mode",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("develop", {
        description: "Start in D3R develop mode",
        type: "boolean",
        default: false,
    });

    const persist = (): void => {
        pi.appendEntry("mode", {
            currentMode: state.currentMode,
            developRetries: state.developRetries,
        });
    };

    const updateStatus = (ctx: ExtensionContext): void => {
        if (state.currentMode === "normal") {
            ctx.ui.setStatus("d3r-mode", undefined);
            return;
        }
        const cfg = MODES[state.currentMode];
        ctx.ui.setStatus("d3r-mode", ctx.ui.theme.fg("accent", cfg.statusIcon));
    };

    const applyTools = (): void => {
        if (state.currentMode === "normal") {
            pi.setActiveTools([...NORMAL_TOOLS]);
            return;
        }
        pi.setActiveTools([...MODES[state.currentMode].tools]);
    };

    // `resetRetries` controls whether the develop loop counter is
    // zeroed on this transition. Manual exits (slash command,
    // fresh-start CLI flag) reset; the BLOCKED-driven auto-exit
    // preserves the counter so the `retries >= 3` bail is reachable
    // across turns/sessions for the same task.
    const enter = (
        next: ModeName,
        ctx: ExtensionContext,
        opts: { resetRetries: boolean } = { resetRetries: true },
    ): void => {
        state.currentMode = next;
        if (next !== "develop" && opts.resetRetries) {
            state.developRetries = 0;
        }
        applyTools();
        updateStatus(ctx);
        persist();
        const label = next === "normal" ? "normal mode" : `${next} mode`;
        ctx.ui.notify(`D3R: entered ${label}`, "info");
    };

    const toggleNamed = (
        name: Exclude<ModeName, "normal">,
        ctx: ExtensionContext,
    ): void => {
        const next: ModeName = state.currentMode === name ? "normal" : name;
        enter(next, ctx);
    };

    // Slash commands.
    for (const cfg of Object.values(MODES)) {
        pi.registerCommand(cfg.slashCommand, {
            description: `Toggle D3R ${cfg.name} mode`,
            handler: async (_args, ctx) => {
                toggleNamed(cfg.name, ctx);
            },
        });
    }

    // System-prompt injection.

    pi.on("before_agent_start", async (event) => {
        if (state.currentMode === "normal") {
            return;
        }
        const cfg = MODES[state.currentMode];
        return {
            systemPrompt: `${event.systemPrompt}\n\n${cfg.systemPrompt}`,
        };
    });

    // BLOCKED detection in develop mode (D19).
    pi.on("turn_end", async (event, ctx) => {
        if (state.currentMode !== "develop") {
            return;
        }
        if (!isAssistantMessage(event.message)) {
            return;
        }
        const text = getAssistantText(event.message);
        const scan = scanForBlocked(text);
        if (!scan.blocked) {
            return;
        }
        state.developRetries += scan.retries;
        if (state.developRetries >= MAX_RETRIES) {
            ctx.ui.notify(
                `D3R develop: BLOCKED retries reached ${state.developRetries} (>= ${MAX_RETRIES}); bailing to normal mode`,
                "error",
            );
        } else {
            ctx.ui.notify(
                `D3R develop: BLOCKED detected (retries=${state.developRetries}); exiting to normal mode`,
                "warning",
            );
        }
        // TODO: We need some sort of audit or emergency mode
        // to tackle this.
        // Preserve the counter on auto-exit so a subsequent develop
        // session inherits it (D19 cross-turn semantics). The final
        // persist() inside enter() writes the carried counter as the
        // latest `mode` entry.
        enter("normal", ctx, { resetRetries: false });
    });

    // Hydrate on session_start (design.md Glossary).
    pi.on("session_start", async (_event, ctx) => {
        const entries = ctx.sessionManager.getEntries();
        const last = [...entries]
            .toReversed()
            .find(
                (e: { type: string; customType?: string }) =>
                    e.type === "custom" && e.customType === "mode",
            ) as { data?: ModeEntryData } | undefined;
        if (last?.data) {
            if (last.data.currentMode) {
                state.currentMode = last.data.currentMode;
            }
            if (typeof last.data.developRetries === "number") {
                state.developRetries = last.data.developRetries;
            }
        }
        // CLI flags override persisted state only on a fresh start
        // (Obs B). On `reload` and `resume`, prefer the rehydrated
        // state so a stale `--design` in shell history does not
        // clobber an in-flight develop session.
        const { reason } = _event as { reason?: string };
        const isFreshStart =
            reason === "startup" || reason === "new" || reason === "fork";
        if (isFreshStart) {
            if (pi.getFlag("--design") === true) {
                state.currentMode = "design";
                state.developRetries = 0;
            } else if (pi.getFlag("--delegate") === true) {
                state.currentMode = "delegate";
                state.developRetries = 0;
            } else if (pi.getFlag("--develop") === true) {
                state.currentMode = "develop";
            }
        }
        applyTools();
        updateStatus(ctx);
    });
};

export default piExtension;
