# D3R reference

> Contract keywords (MUST, SHOULD, MAY, MUST NOT) follow RFC 2119.

## Phases

D3R is three phases plus housekeeping. Each phase produces named
documents and consumes the prior phase's output.

| Phase     | Command      | Produces                                            | Consumes                                                                  |
| --------- | ------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Design    | `/design`    | `design.md`                                         | `task.md`                                                                 |
| Delegate  | `/delegate`  | `plan.md`, `schema.md`                              | `task.md`, `design.md`                                                    |
| Develop   | `/develop`   | code, `review.md`, `implementation-log.md`, `audit.md` | `schema.md`                                                            |
| Audit     | `/audit`     | `audit.md`                                          | repository state                                                          |
| Summarize | `/summarize` | `summary.md`, archive                               | `task.md`, `design.md`, `schema.md`, `audit.md`, reviews, diff            |

The Design phase additionally produces `remember.md` (vault recon)
and `research.md` (external recon) as inputs to the designer.

## Vault layout

The vault is the single source of truth for D3R documents. Paths
below are vault-relative.

```
designs/<topic>/      task.md, remember.md, research.md, design.md, plan.md
tasks/<task>/         schema.md, reviews/<n>.md, implementation-log.md,
                      audit.md, summary.md
notes/                free-form long-lived notes
notes/audits/         standalone audits (not tied to a task)
issues/               open design questions
archive/              completed tasks (moved here by archivist)
templates/            document templates (one per kind)
reference/            this file and other shared agent references
```

`plan.md` lives under `designs/<topic>/` because planning happens
on a finished design; the per-task `tasks/<task>/` directory is
created when planning splits the design into tasks.
`implementation-log.md` is appended to in the Develop loop when
the implementor runs in auto mode; in semi mode the human is in
the loop and no log is required. `audit.md` lives under
`tasks/<task>/` for task-tied (PR-level) audits and under
`notes/audits/<label>.md` for standalone audits.

Agents MUST write to the path their phase owns and MUST NOT write
outside it. The archivist is the only agent that moves files
between top-level vault directories.

## Picking a phase

Used by the orchestrator to route free-form requests.

```
PR open and needs changes?
  simple   -> /develop
  complex  -> /design
no PR:
  design.md missing  -> /design
  schema.md missing  -> /delegate
  schema.md present  -> /develop
finished task        -> /summarize
ad-hoc assessment    -> /audit
```

## Document contracts

Every output document MUST follow the matching template under
`templates/<kind>.md`. Templates define required frontmatter and
section structure; deviations break downstream agents.

## Phase boundaries

- Design ends with a human checkpoint before drafting; the designer
  MUST NOT edit code.
- Delegate ends with human review of the schema(s); the schemer
  MUST NOT touch the repository.
- Develop loops implementor + reviewer up to a bounded count; the
  implementor signals a non-recoverable block by emitting a
  top-level `## BLOCKED` section, which exits the loop early.
- Summarize archives the task; the archivist MUST NOT rewrite the
  documents being archived.

## Agent isolation

Agents whose work depends on routing decisions (orchestrator,
aggregator, archivist, designer, planner, schemer, summarizer)
SHOULD read this reference at session start. Agents whose work is
strictly local to a single input (implementor, reviewer, auditor,
researcher) SHOULD NOT - reading this file would invite scope drift
into territory their inputs do not cover.
