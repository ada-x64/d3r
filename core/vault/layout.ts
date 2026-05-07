// In-code authority for the per-repo vault directory shape.
//
// The list also appears as `vault.dirs` / `vault.template_kinds` in
// `core/workflow.yaml` for human-readable documentation; the in-code
// constants here are the runtime source of truth and the yaml is
// informational. The `layout.test.ts` drift trip-wire pins the two
// together.

/** Six top-level directories materialised at every vault root. */
export const TOP_LEVEL_DIRS = [
	"blueprints",
	"notes",
	"process",
	"issues",
	"reference",
	".misc",
] as const;

/** Kanban columns under `<vault>/issues/`. The `.umbrellas/` sibling is not a column. */
export const KANBAN_COLUMNS = [
	"0-backlog",
	"1-todo",
	"2-in-progress",
	"3-in-review",
] as const;

/**
 * Per-kind document templates seeded into `<vault>/.misc/templates/`.
 * `README` and `AGENTS` are governance files (vault root) and `d3r`
 * is reference material (sourced from `core/reference/`); none of the
 * three is a kind, so they do not appear here.
 */
export const TEMPLATE_KINDS = [
	"audit",
	"blueprint",
	"design",
	"implementation-log",
	"issue",
	"note",
	"plan",
	"remember",
	"research",
	"review",
	"schema",
	"summary",
	"umbrella-issue",
] as const;

/** Markdown files seeded at the vault root. */
export const GOVERNANCE_FILES = ["README.md", "AGENTS.md", "d3r.md"] as const;

/**
 * Dotfile entries at vault root that are admitted as-is rather than
 * flagged as `extra` by lint / repair. Hardcoded; the future
 * `.vault-ignore` parser is design Future Work.
 */
export const DOTFILE_ALLOWLIST: ReadonlySet<string> = new Set([".git"]);

export type TopLevelDir = (typeof TOP_LEVEL_DIRS)[number];
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export type GovernanceFile = (typeof GOVERNANCE_FILES)[number];
