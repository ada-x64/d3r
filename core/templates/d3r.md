# D3R reference

> Contract keywords (MUST, SHOULD, MAY, MUST NOT) follow RFC 2119.

## Authority

The vault's on-disk shape is governed by `blueprints/vault-shape/blueprint.md`.
This file describes the workflow that produces and consumes documents within
that shape; where the two appear to disagree, the blueprint wins and this file
is the bug.

## Phases

D3R is three phases plus housekeeping. Each phase produces named documents and
consumes the prior phase's output.

| Phase     | Command      | Produces                                               | Consumes                                            |
| --------- | ------------ | ------------------------------------------------------ | --------------------------------------------------- |
| Design    | `/design`    | `design.md`                                            | operator brief                                      |
| Delegate  | `/delegate`  | `plan.md`, `schema.md`                                 | `design.md`                                         |
| Develop   | `/develop`   | code, `review.md`, `implementation-log.md`, `audit.md` | `schema.md`                                         |
| Summarize | `/summarize` | `summary.md`, archive                                  | `design.md`, `schema.md`, `audit.md`, reviews, diff |

The Design phase additionally produces `remember.md` (vault recon) and
`research.md` (external recon) as inputs to the designer.

## Vault layout

The vault is the single source of truth for D3R documents. Paths below are
vault-relative.

```text
README.md                                  # human entry-point
AGENTS.md                                  # agent steering (cascading)
d3r.md                                     # this file
blueprints/<area>/                         # substrate (per-area entry point)
notes/<topic>/                             # accumulated knowledge
process/designs/<topic>/                   # design+delegate bundle:
                                           #   remember.md, research.md,
                                           #   design.md, plan.md
process/tasks/<task>/                      # develop bundle:
                                           #   schema.md, reviews/<n>.md,
                                           #   implementation-log.md,
                                           #   audit.md, summary.md
issues/0-backlog/                          # kanban: backlog column
issues/1-todo/                             # kanban: todo column
issues/2-in-progress/                      # kanban: in-progress column
issues/3-in-review/                        # kanban: in-review column
issues/.umbrellas/                         # umbrella issues (no WIP count)
reference/<kind>/                          # external-consumed templates
                                           # (issue-templates, pr-templates, ...)
.misc/archive/<bucket>/<slug>/             # frozen / completed
.misc/templates/<kind>.md                  # internal doc templates
```

`plan.md` lives under `process/designs/<topic>/` because planning happens on a
finished design; the per-task `process/tasks/<task>/` directory is created when
planning splits the design into tasks. `implementation-log.md` is appended to in
the Develop loop when the implementor runs in auto mode; in semi mode the human
is in the loop and no log is required. Standalone audits are tasks too — they
live as `process/tasks/<audit-slug>/audit.md`, not in any separate audits
bucket.

Agents MUST write to the path their phase owns and MUST NOT write outside it.
The archivist is the only agent that moves files between top-level vault
directories.

## Picking a phase

Used by the orchestrator to route free-form requests.

```text
PR open and needs changes?
  simple   -> /develop
  complex  -> /design
no PR:
  design.md missing  -> /design
  schema.md missing  -> /delegate
  schema.md present  -> /develop
finished task        -> /summarize
```

## Document contracts

Every output document MUST follow the matching template under
`.misc/templates/<kind>.md`. Templates define required frontmatter and section
structure; deviations break downstream agents.

## Phase boundaries

- Design ends with a human checkpoint before drafting; the designer MUST NOT
  edit code.
- Delegate ends with human review of the schema(s); the schemer MUST NOT touch
  the repository.
- Develop loops implementor plus reviewer up to a bounded count, then runs the
  auditor once over the resulting commit range; the implementor signals a
  non-recoverable block by emitting a top-level `## BLOCKED` section, which
  exits the loop early.
- Summarize archives the task; the archivist MUST NOT rewrite the documents
  being archived.

## Agent isolation

Agents whose work depends on routing decisions (orchestrator, aggregator,
archivist, designer, planner, schemer, summarizer) SHOULD read this reference at
session start. Agents whose work is strictly local to a single input
(implementor, reviewer, auditor, researcher) SHOULD NOT - reading this file
would invite scope drift into territory their inputs do not cover.
