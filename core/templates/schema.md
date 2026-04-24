---
design: <relative path to design.md>
branch: <branch-name>
status: draft
created: <ISO Date>
---

# Schema: <task-slug>

> One-paragraph orientation. Which slice of `design.md` this schema implements,
> the spine of the commit decomposition, and any upstream context (research,
> remember) the Implementor should load. Implementor reads this without loading
> `design.md`.

---

## Problem

What gap this slice of the design addresses. Cite design sections inline
(`design.md#decisions`). State current behavior, the specific change required,
and the impact - concrete, not abstract. The Implementor should be able to read
this and understand _why_ the commits below exist without backtracking.

---

## Approach

Numbered high-level steps. Prose, not pseudocode. Record rejected alternatives
explicitly so the Implementor doesn't relitigate.

1. <step> - one to three sentences.
2. <step>
3. <step>

**Rejected alternatives:**

- <Alternative A> - rejected because <reason>.
- <Alternative B> - rejected because <reason>.

---

## Open questions

_Optional._ Decisions Schemer is deliberately leaving to the Implementor (the
Overview explicitly permits this). Each entry should be answerable inside the
commit it pertains to; questions that need human input belong in the design's
Open questions, not here.

1. <question> - context for what to weigh.
2. <question>

---

## Reference

File:line citations, tables, small diagrams, API maps. The Implementor reads
this to find the existing code to modify or mirror.

**No reproduced code blocks longer than ~10 lines.** Cite via `path:lines (ref)`
and let the Implementor read the source. Short before/after sketches are allowed
only when a pure reference is ambiguous (e.g., showing the desired call-site
shape).

- Existing implementation: `path/to/file.ts:42-58 (a3f9c21)` - what's there,
  what to mirror or replace.
- Related convention: `[[notes/topic]]` - relevant pattern.
- External: https://example.com - relevant doc.

---

## Commits

The core. One subsection per commit; one concern per commit. Implementor walks
these top-to-bottom, one Implement -> Verify -> Review cycle per commit.

### Commit 1: <descriptive subject>

Two to four sentences setting up what this commit accomplishes and how it fits
into the overall sequence.

#### 1a. <kebab-label>

What to do. Reference existing code via `path:lines (ref)`. Implementor has
latitude to deviate when reality differs from the schema - the schema is a
guide, not a script.

#### 1b. <kebab-label>

...

#### 1v. verify

Explicit shell commands the Implementor must run before declaring the commit
ready. Not prose - actual commands. This block is load-bearing: the Verify step
in the Develop loop runs exactly what's listed here.

```bash
pnpm check
pnpm lint --deny-warnings
pnpm build --target=pi
```

---

### Commit 2: <descriptive subject>

...

#### 2v. verify

```bash
pnpm check
pnpm test --filter=<scope>
```

---

## Files changed

Table summarising the diff across the whole schema. Aids the Reviewer at audit
time and helps the Implementor sanity-check scope creep.

| File               | Nature of change            |
| ------------------ | --------------------------- |
| `path/to/file.ts`  | <one-line characterization> |
| `path/to/other.ts` | <one-line characterization> |

---

## Notes

_Optional._ Caveats, edge cases, sequencing rationale, or anything the
Implementor should know that doesn't belong in a specific commit subsection.

---

<!--
Frontmatter notes:
- `design` is the back-pointer to the upstream design.md the
  Schemer was working from.
- `branch` is the worktree/branch the Develop loop will operate on
  (drives wt_switch_branch).
- `status` enum: `draft | in-progress | blocked | in-review |
  accepted`. `blocked` is a frontmatter value rather than an
  in-body marker, so blockedness is machine-tractable.
- `created` is the ISO date of schema drafting.

Snippet policy:
- No reproduced code blocks longer than ~10 lines outside of
  `verify` blocks (which are commands, not implementation).
- Cite existing code via `path:lines (ref)`.
- The Implementor is allowed grace to modify the schema in-flight.

Shape reference: notes/template-shapes/schema.md section 5.
-->
