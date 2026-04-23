---
created: <ISO Date>
---

# Research: <task-slug>

> Objective survey of external prior art relevant to `<task>`. How
> have other people solved this kind of problem in this kind of
> codebase? Patterns, not suggestions. Companion to `remember.md`
> (which covers the internal landscape); together these feed
> Designer directly.

---

## Problem framing

One paragraph restating from `task.md`: the *kind* of problem and
the *kind* of codebase. Sets the lens for what counts as relevant
prior art - keeps the survey from sprawling.

---

## Prior art

The core. One subsection per distinct external source (project,
paper, blog post, library). Factual summary; cite inline. Prefer original
sources. If you think a non-academic source such as a blog post is
LLM-generated, do NOT cite it. Exceptions include deep-wiki and project
documentation.

### <Project / source name>

**Source:** https://example.com/path

Factual summary of what this source does relevant to the problem.
Tables, bullets, and short verbatim snippets are fine. Quote
documentation freely; reproduce code only when necessary to
communicate a pattern, and never more than ~15 lines - link to the
source instead.

### <Project / source name>

**Source:** ...

...

---

## Patterns observed

Cross-cutting patterns abstracted from the prior art above. Bullet
list. **No recommendations** - "X commonly does Y" is fine; "we
should do Y" is not.

- <pattern>: seen in <source A>, <source B>. <one-line
  characterization>.
- <pattern>: ...

---

## Open questions

Gaps the survey could not resolve. Things to flag for human input
before Designer commits to a direction.

1. <gap>
2. <gap>

---

## Sources

Flat bibliography mirroring the inline citations above. One line per
URL or path, with a one-line characterization. Aids human auditing
and lets the Designer skim without re-reading the body.

- https://example.com - <one-line characterization>
- `path/to/local/file.ts:42-58 (a3f9c21)` - <one-line characterization>
- `[[notes/related-topic]]` - <one-line characterization>

---

<!--
Frontmatter notes:
- `created` is the only required field. Provenance lives in the
  per-section `**Source:**` lines and the `## Sources` bibliography.

Snippet policy:
- Short illustrative snippets from external sources are allowed.
- Never reproduce more than ~15 lines verbatim - link instead.
- Never write *new* code here - that's Designer's job.
- Local code citations use `path:lines (ref)`, not pasted blocks.

Shape reference: notes/template-shapes/research.md §4.
-->
