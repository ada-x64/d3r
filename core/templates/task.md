---
created: <ISO Date>
---

# <Descriptive title>

> The kickoff artifact of the Design phase. Authored by the Orchestrator from a
> user brief (issue, ticket, conversation). This doc is the seed; downstream
> Aggregator, Researcher, Designer, Schemer, and eventually Summarizer all read
> it. Pin the user's intent here so fan-out doesn't drift.

---

## Context

What this work is responding to. Quote or cite the source brief (GH issue, JIRA
ticket, conversation thread, prior design). Keep links inline. The reader should
understand _why this exists_ before reading what it asks for.

---

## Goal

What "done" looks like at the design level - not the code level. Numbered if
multi-part. State outcomes, not implementations - implementation choices belong
in `design.md`.

1. <outcome>
2. <outcome>

---

## Non-goals

Explicit out-of-scope items. These constrain Designer and Schemer downstream by
closing off territory the brief might otherwise be read to imply. Each entry
should be one line.

- <thing this task is _not_ doing>
- <thing this task is _not_ doing>

---

## Constraints

Fixed inputs the Designer must respect: file formats, model or budget limits,
existing tools that must be used, hard deadlines, compatibility requirements.
These are not preferences - they're non-negotiables that bound the design space.

- <constraint>
- <constraint>

---

## Open questions

What the user wants the Discuss step to resolve. This is the Discuss-phase
agenda. Each item: one line, optionally tagged `(D-n)` so `design.md` can ratify
it by reference later.

1. <question> (D-1)
2. <question> (D-2)

---

## Acceptance criteria

_Optional._ Checkable conditions that `design.md` and downstream artifacts must
satisfy for this task to be considered complete. Distinct from schema-level
per-commit verify - those live in `schema.md`. Use this section when the brief
came with explicit success criteria (PM-supplied, contract-bound, etc.).

- [ ] <criterion>
- [ ] <criterion>

---

<!--
Frontmatter notes:
- `created` is the ISO date Describe began.
- Path encodes the design name (`designs/<name>/task.md`); no
  separate `task` or `design` field needed.

Snippet policy:
- No reproduced code blocks. Cite via `path:lines (ref)`. task.

Decisions captured during Describe belong in `design.md` under
`## Decisions`, not here. Keep this doc focused on intent and
constraints; decisions are downstream.

Shape reference: notes/template-shapes/task.md section 4.
-->
