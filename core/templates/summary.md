---
created: <ISO Date>
repo: <owner/repo> # omit if unavailable
branch: <branch-name> # omit if unavailable
pr: <url> # omit if unavailable
status: merged # merged | rejected
---

# Summary: <task-slug>

> Post-merge retrospective. This is the one document that survives
> the task-dir GC; future agents and humans will recall this work
> through this file alone, possibly via vector search. Be
> self-contained: assume `design.md`, `schema.md`, and the review
> trail are gone by the time someone reads this.

---

## Outcome

One to three sentences. What shipped, was it accepted, what does
the codebase now do that it didn't before. Reader's headline.

---

## Scope

Bullet metadata for the Archivist and for vector-DB hits. Keep
machine-scannable.

- **Branch:** `<branch-name>`
- **Base:** `<base-sha>`
- **Commits:** N
- **Files touched:** K
- **Diff:** `+N -M`

---

## Commits

One bullet per commit group from `schema.md`, in order. Maps 1:1 to
the schema's `### Commit N` spine for traceability. Flag any commit
that deviated from its schema entry.

- `<sha>` <subject> - schema commit 1, as planned.
- `<sha>` <subject> - schema commit 2, **deviated** (see below).
- `<sha>` <subject> - schema commit 3, as planned.

---

## Deviations from design / schema

The load-bearing section. Per-deviation: what the plan said, what
was built, why. Cite design sections (`design.md#decisions`) and
schema commits (`schema.md` commit 2). This is the long-term value
- "what the design got right and wrong, where surprises came up."

Use prose, not bullets. Each deviation deserves a paragraph; the
*why* is the recall-worthy content.

### <Deviation 1 short label>

**Plan:** <design / schema said X>.
**Built:** <actually shipped Y>.
**Why:** <surprise, constraint discovered, better path found>.

### <Deviation 2 short label>

...

If there were no deviations, write a single sentence saying so and
move on. Don't pad.

---

## Lessons

Short bullets. Patterns worth promoting to `notes/`, anti-patterns
to avoid, conventions confirmed or invalidated. Essential for
teaching the agent long-term.

- <lesson> - one to two sentences of context.
- <lesson>
- <lesson>

---

## Unresolved / follow-ups

Open issues, deferred work, suggested next tasks. Things explicitly
out of scope for this task that the next reader should know about.

1. <follow-up> - context.
2. <follow-up>

---

## References

*Optional.* PR URL, related notes, external citations cited in the
deviations or lessons above. Inline citations elsewhere use
`path:lines (ref)` for in-repo, `<commit-sha>` for historical refs,
`[[notes/topic]]` for vault siblings, full URL for web.

- PR: <url>
- Related: `[[notes/topic]]` - <one-line characterization>

---

<!--
Snippet policy:
- Cite via `path:lines (ref)` or `<commit-sha>` - do not reproduce
  code. By the time someone reads this, the code lives in git;
  snippets here go stale on the next refactor while refs remain
  unambiguous.
- Exception: a one-line illustrative diff fragment in Deviations
  is permitted when describing an unexpected design choice.

Shape reference: notes/template-shapes/summary.md §4.
-->
