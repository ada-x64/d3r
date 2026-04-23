---
created: <ISO Date>
---

# Remember: <task-slug>

> Objective survey of the existing landscape relevant to `<task>`.
> Factual only - no suggestions, no recommendations, no design
> direction. Companion to `research.md` (which covers external prior
> art); together these are the Design phase's RAG-pipeline outputs.

---

## 1. <Topic>

**Source:** `path/to/file.ts:42-58 (a3f9c21)`, `[[notes/related-topic]]`

Factual subsections, bullets, tables, and verbatim quotes from the
surveyed material. Quote documentation freely; cite code with
`path:lines (ref)` rather than reproducing long blocks. Aggregator
cites; Designer interprets.

### 1.1 <Sub-topic>

...

---

## 2. <Topic>

**Source:** ...

...

---

## Conventions already in place

Table summarising recurring patterns across the surveyed material.
Designer should treat these as constraints, not suggestions.

**Heuristic - include a row when all four hold:**

1. **Repetition** - the pattern appears in 3+ independent places
   (2 is coincidence; 3 is a pattern).
2. **Cross-cutting** - it spans modules/files, not local style
   within one component.
3. **Tacit, not documented** - it's practiced but not written down
   in `CONTRIBUTING.md`, `AGENTS.md`, or a README. (Aggregator
   should still *read* those docs as explicit context; documented
   rules belong in the topical sections above, cited to the doc.
   This table is for the unwritten patterns.)
4. **Designer-actionable** - relevant to the task; a convention
   the design might violate by default.

If AGENTS.md or CONTRIBUTING.md states a pattern that is not being used, surface that tensinon here.

For greenfield tasks, narrow
single-file surveys, or when all relevant conventions are already
documented and cited inline above, simply state "<no conventions to surface>"

| Convention | Where it shows up | Notes |
| ---------- | ----------------- | ----- |
| <pattern>  | `path:lines (ref)` | <observation> |

---

## Open factual questions

*Optional.* Things Aggregator could not resolve from local sources.
Signals for Researcher follow-up or human input. **Not**
recommendations or design questions - strictly "I could not find
out X."

1. <factual gap>
2. <factual gap>

---

<!--
Shape reference: notes/template-shapes/remember.md §4.
-->
