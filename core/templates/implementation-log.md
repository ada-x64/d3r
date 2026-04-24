---
task: <task-slug, matches parent dir>
created: <ISO Date>
updated: <ISO Date>
mode: auto
---

# Implementation log: <task-slug>

> Append-only record of implementor decisions that diverge from
> `schema.md`. Written by the implementor when running in auto
> mode (no human in the loop). Read by the reviewer, the auditor,
> and the summarizer.

---

## How to use this file

- One entry per deviation. Newest entries at the bottom.
- An entry is required when the implementor:
  - changes the commit grouping promised by the schema,
  - changes a public surface the schema named (function
    signature, file path, configuration key),
  - skips a step the schema required, or
  - adds a step the schema did not anticipate.
- A trivial choice the schema left open (variable names, local
  helpers, comment wording) is NOT a deviation and does NOT need
  an entry.
- Schema text is frozen contract. Never edit `schema.md` from
  this file; record what you did instead and why.

---

## Entries

### <ISO Date> - <short title>

**Schema reference:** `schema.md` `### Commit <N>` (or section
heading the deviation departs from).

**What the schema said:** One or two sentences quoting or
paraphrasing the contract.

**What was implemented:** One or two sentences describing the
actual change. Cite via `path:lines (ref)` where useful.

**Why:** The constraint, discovery, or trade-off that forced the
divergence. Be specific; "cleaner" is not a reason.

**Follow-up (optional):** Anything the next reader (reviewer,
auditor, summarizer, or future implementor) needs to know. Open
questions belong here, not in the schema.

---

<!--
Shape reference: notes/template-shapes/implementation-log.md.
Append entries; do not rewrite history. If an earlier entry was
wrong, add a new entry that supersedes it and cite the prior
entry by date.
-->
