// Mode extension shared types and helpers (Plan B').
//
// Two harness modes only:
//   - normal: vanilla pi, no orchestrator contract injected.
//   - d3r:    orchestrator contract is the system-prompt suffix.
//
// Within d3r, the active *phase* is recorded as a top-level
// `## MODE: <phase>` marker line in the conversation transcript.
// The transcript is the only source of truth; this extension keeps
// no persistent phase state. The most recent marker scanned at
// `turn_end` is mirrored into the status icon for UX, nothing more.
//
// `## BLOCKED` retains its develop-only semantics as the implementor's
// fatal-failure signal. The orchestrator handles routing on hit
// (emits `## MODE: routing`); the extension only surfaces a notify.

export type ModeName = "normal" | "d3r";

export type PhaseName =
	| "design"
	| "delegate"
	| "develop"
	| "summarize"
	| "routing";

export const PHASE_NAMES: readonly PhaseName[] = [
	"design",
	"delegate",
	"develop",
	"summarize",
	"routing",
] as const;

export const isPhaseName = (value: string): value is PhaseName =>
	(PHASE_NAMES as readonly string[]).includes(value);

// Multiline-anchored match for a top-level `## MODE: <phase>` heading.
// The orchestrator contract requires lowercase, ASCII, no arrows.
const MODE_MARKER_RE = /^## MODE:\s*([a-z]+)\s*$/im;

export interface ModeMarkerScan {
	readonly matched: boolean;
	readonly phase?: PhaseName;
}

// Return the *last* marker in the text (the most recent phase).
export const scanForModeMarker = (text: string): ModeMarkerScan => {
	const all = text.match(/^## MODE:\s*[a-z]+\s*$/gim);
	if (!all || all.length === 0) {
		return { matched: false };
	}
	const last = all[all.length - 1];
	const m = MODE_MARKER_RE.exec(last);
	if (!m) {
		return { matched: false };
	}
	const phase = m[1].toLowerCase();
	if (!isPhaseName(phase)) {
		return { matched: false };
	}
	return { matched: true, phase };
};

export const formatModeMarker = (phase: PhaseName): string =>
	`## MODE: ${phase}`;

// Multiline-anchored match for a top-level "## BLOCKED" heading.
const BLOCKED_RE = /^## BLOCKED\b/m;

export interface BlockedScan {
	readonly blocked: boolean;
	readonly count: number;
}

// Count occurrences of "## BLOCKED" headings in a text blob. Returns
// `{ blocked, count }` where `count` is the number of matches in this
// single text (typically 0 or 1; >1 only if an agent emits multiple
// BLOCKED sections in one turn).
export const scanForBlocked = (text: string): BlockedScan => {
	if (!BLOCKED_RE.test(text)) {
		return { blocked: false, count: 0 };
	}
	const all = text.match(/^## BLOCKED\b/gm);
	return { blocked: true, count: all ? all.length : 1 };
};
