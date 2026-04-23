---
created: <ISO Date>
---

# Design: <task-slug>

> One-paragraph orientation. What this design is about and what
> question it answers. Sibling docs (`task.md`, `remember.md`,
> `research.md`) carry the briefing, the prior context, and the
> investigation; this doc is the resolved direction.

---

## Context

What `task.md` asked for, in your own words. Pointers to sibling
`remember.md` / `research.md` for prior context and investigation
narrative - do not duplicate them here. If the design supersedes or
amends an earlier design, link it.

---

## Thesis

The resolved direction in 2-4 sentences. A reader should be able to
grok the shape of the design from this section alone, without
reading further.

---

## Decisions

The load-bearing section. Numbered (`D1`, `D2`, ...) so downstream
schemas can cite them by ID.

For terse decisions, a table:

| #  | Topic         | Decision                           | Rationale          |
| -- | ------------- | ---------------------------------- | ------------------ |
| D1 | <topic>       | <one-line decision>                | <one-line why>     |
| D2 | <topic>       | <one-line decision>                | <one-line why>     |

For complex decisions, a sub-section per decision:

### D3. <Decision title>

**Decision:** What was decided.

**Rationale:** Why this over the alternatives. Cite sources via
`path:lines (ref)` (repo, with short git SHA), vault-relative path
(vault), or full URL (web).

**Alternatives considered:**
- <Alternative A> - rejected because <reason>.
- <Alternative B> - rejected because <reason>.

---

## Architecture

*Optional.* Diagrams, directory trees, or component sketches that
clarify the structural shape of the design, preferably in Mermaid. Keep
it tight - if a diagram needs paragraphs of caption, it's the wrong
diagram.

---

## Per-area design

*Optional.* When the design will fan out into multiple schemas,
pre-name the areas (`### Area 1: <name>`, `### Area 2: ...`) so the
Planner can use them as scoping anchors. Each area gets a short
description of what it covers and what it doesn't.

---

## Acceptance criteria

Numbered checklist of what "design satisfied" means. Distinct from
per-schema verify steps; this is the design-level contract.

1. ✅ <criterion>
2. ✅ <criterion>

---

## Open questions

*Optional.* Items deliberately deferred to Delegate or later. Each
should be a real question, not a placeholder. Resolved questions
are removed (not crossed out - git remembers).

1. <question>
2. <question>

---

## Future work

*Optional.* Explicitly out-of-scope follow-ons that would otherwise
creep into this design. Keeps the current scope honest.

1. <item> - <one-line description of why it's out of scope here>.

---

## Bibliography

*Optional.* Footnote-style source list for citations made above.
Reproduce a source here only if it's referenced inline by `[^N]`;
otherwise inline `path:lines (ref)` is preferred. The Researcher and
Aggregator outputs in sibling docs are the bulk reference; this
section is for sources directly invoked in Decisions.

[^1]: `path/to/file.ts:42-58 (a3f9c21)` - what was learned.
[^2]: https://example.com - what was learned.
[^3]: `[[notes/topic]]` - what was learned (vault link).

---

<!--
Frontmatter notes:
- `created` is the ISO date the design was drafted.
- Path encodes the design name (`designs/<name>/design.md`); no
  separate `task` or `design` field needed.

Shape reference: notes/template-shapes/design.md §4.
-->
