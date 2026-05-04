// D3R mode extension (Plan B').
//
// Two harness modes only: `normal` (vanilla pi) and `d3r` (orchestrator
// contract injected as a system-prompt suffix). Phase state lives in
// the conversation transcript as `## MODE: <phase>` markers; this
// extension keeps no persistent phase state and does no per-phase tool
// gating - the orchestrator is trusted to delegate writes to subagents
// per its contract.
//
// Surface:
//   - /d3r [phase]   toggle into/out of d3r mode. Optional phase
//                    argument seeds the first `## MODE: <phase>`
//                    marker so the orchestrator can skip the
//                    "which phase?" prompt.
//   - /normal        leave d3r mode (idempotent if already normal).
//   - --d3r          start pi already in d3r mode.
//
// Behavior:
//   - `before_agent_start`: when mode = d3r, append the orchestrator
//     contract (compiled from core/agents/orchestrator.md plus
//     core/workflow.yaml) to the system prompt.
//   - `turn_end`: scan the assistant message for the most recent
//     `## MODE: <phase>` marker and mirror it into the status icon.
//     Scan for `## BLOCKED` and surface a notify (orchestrator handles
//     the phase change itself by emitting `## MODE: routing`).
//   - `session_start`: read the `--d3r` flag on fresh start; backfill
//     the status icon from the most recent transcript marker on resume.

import { type AssistantMessage, type TextContent } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { ORCHESTRATOR_CONTRACT } from "./orchestrator-contract.generated.ts";
import {
	formatModeMarker,
	isPhaseName,
	scanForBlocked,
	scanForModeMarker,
	type ModeName,
	type PhaseName,
} from "./utils.ts";

interface ExtensionState {
	mode: ModeName;
	lastPhase: PhaseName | undefined;
}

// Type guard for assistant messages.
const isAssistantMessage = (m: unknown): m is AssistantMessage => {
	const msg = m as { role?: string; content?: unknown };
	return msg.role === "assistant" && Array.isArray(msg.content);
};

const getAssistantText = (message: AssistantMessage): string =>
	message.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");

const phaseFromArgs = (args: string): PhaseName | undefined => {
	const trimmed = args.trim().toLowerCase();
	if (trimmed === "") {
		return undefined;
	}
	return isPhaseName(trimmed) ? trimmed : undefined;
};

const piExtension = (pi: ExtensionAPI): void => {
	const state: ExtensionState = {
		mode: "normal",
		lastPhase: undefined,
	};

	pi.registerFlag("d3r", {
		description: "Start pi in D3R mode",
		type: "boolean",
		default: false,
	});

	const updateStatus = (ctx: ExtensionContext): void => {
		if (state.mode === "normal") {
			ctx.ui.setStatus("d3r-mode", undefined);
			return;
		}
		const label = state.lastPhase ? `d3r:${state.lastPhase}` : "d3r";
		ctx.ui.setStatus("d3r-mode", ctx.ui.theme.fg("accent", label));
	};

	const enter = (next: ModeName, ctx: ExtensionContext): void => {
		if (state.mode === next) {
			return;
		}
		state.mode = next;
		if (next === "normal") {
			state.lastPhase = undefined;
		}
		updateStatus(ctx);
		ctx.ui.notify(`D3R: entered ${next} mode`, "info");
	};

	// Inject a `## MODE: <phase>` marker into the transcript via a
	// custom display message so the orchestrator's next-turn scan
	// finds it. Used by `/d3r <phase>` to seed the phase without
	// forcing an immediate LLM turn.
	const seedPhaseMarker = (phase: PhaseName): void => {
		pi.sendMessage(
			{
				customType: "d3r-mode-marker",
				content: formatModeMarker(phase),
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
		state.lastPhase = phase;
	};

	pi.registerCommand("d3r", {
		description: "Toggle D3R mode (optional: /d3r <phase>)",
		handler: async (args, ctx) => {
			const phase = phaseFromArgs(args);
			const wasD3r = state.mode === "d3r";
			const noPhaseArg = args.trim() === "";
			// Bare `/d3r` toggles. `/d3r <phase>` enters d3r (if not
			// already) and seeds the phase marker. An invalid phase
			// arg is surfaced and ignored.
			if (noPhaseArg) {
				enter(wasD3r ? "normal" : "d3r", ctx);
				return;
			}
			if (!phase) {
				ctx.ui.notify(
					`D3R: unknown phase "${args.trim()}" (expected: design, delegate, develop, routing)`,
					"warning",
				);
				return;
			}
			if (!wasD3r) {
				enter("d3r", ctx);
			}
			seedPhaseMarker(phase);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("normal", {
		description: "Leave D3R mode",
		handler: async (_args, ctx) => {
			enter("normal", ctx);
		},
	});

	// System-prompt injection: orchestrator contract appended when in
	// d3r mode. `normal` leaves the upstream prompt untouched.
	pi.on("before_agent_start", async (event) => {
		if (state.mode === "normal") {
			return;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n[D3R ORCHESTRATOR CONTRACT]\n\n${ORCHESTRATOR_CONTRACT}`,
		};
	});

	// turn_end: mirror the most recent `## MODE` marker into the
	// status icon and surface BLOCKED notifications. No state
	// mutation beyond the icon - the transcript is authoritative.
	pi.on("turn_end", async (event, ctx) => {
		if (state.mode !== "d3r" || !isAssistantMessage(event.message)) {
			return;
		}
		const text = getAssistantText(event.message);
		const marker = scanForModeMarker(text);
		if (marker.matched && marker.phase && marker.phase !== state.lastPhase) {
			state.lastPhase = marker.phase;
			updateStatus(ctx);
		}
		const blocked = scanForBlocked(text);
		if (blocked.blocked) {
			ctx.ui.notify(
				`D3R: ${blocked.count} BLOCKED marker(s) in last reply; orchestrator should route`,
				"warning",
			);
		}
	});

	// Backfill the status icon on resume by scanning the existing
	// session messages for the most recent `## MODE` marker. Apply
	// the --d3r flag only on a fresh start.
	pi.on("session_start", async (event, ctx) => {
		const { reason } = event as { reason?: string };
		// Treat anything other than "resume" as a fresh start.
		const isFreshStart = reason !== "resume";
		if (isFreshStart && pi.getFlag("d3r") === true) {
			state.mode = "d3r";
			seedPhaseMarker("routing");
		}
		// Best-effort backfill: walk session messages and find the
		// most recent assistant text containing a marker.
		const messages = ctx.sessionManager.getMessages?.() as
			| readonly unknown[]
			| undefined;
		if (messages) {
			const latestPhase = [...messages]
				.toReversed()
				.filter(isAssistantMessage)
				.map((m) => scanForModeMarker(getAssistantText(m)))
				.find((s) => s.matched && s.phase)?.phase;
			if (latestPhase) {
				state.lastPhase = latestPhase;
			}
		}
		updateStatus(ctx);
	});
};

export default piExtension;
