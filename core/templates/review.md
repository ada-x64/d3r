---
created: <ISO Date>
round: 1
---

# Review: <task-slug> (round <R>)

**Branch:** `<branch-name>` **Commit group:** `<group label or short sha range>`
**Diff:** `<+N -M across K files>`

---

## Verdict: <Accept | Accept with nits | Request changes | Reject>

One to three sentences summarising the round. State what the commit group
accomplished and the headline reason for the verdict. This is what the
Implementor reads first on the next loop.

---

## Issues

Numbered. One subsection per issue. Order by severity (critical first), then by
logical grouping (related issues kept together). Be thorough but only flag real
issues - do not pad.

**Category rubric** (combinable, comma-separated):

_Correctness and safety:_

- `bug` - incorrect behavior; the code does the wrong thing.
- `security` - exploitable weakness; unsafe handling of secrets, inputs, or
  trust boundaries.

_Behavior quality:_

- `performance` - measurable efficiency concern (CPU, memory, allocation, I/O).
- `types` - type-system specific; signatures, generics, soundness, narrowing,
  inference.

_Code shape (now):_

- `design` - structural / architectural concern above the line level; API
  surface, module boundaries, abstraction level, coupling, pattern fit.
- `complexity` - cognitive load _now_; branching depth, function size,
  control-flow density.
- `readability` - local clarity of the code itself; naming, comments,
  line-of-sight, intent legibility.

_Code shape (over time):_

- `maintenance` - ability to maintain over time; tech debt, brittleness,
  future-change friction, hidden coupling, drift potential, bus factor. Distinct
  from `design` (structural shape _now_) and `complexity` (local cognitive load
  _now_).

_Process artifacts:_

- `reviewability` - clarity of _the diff itself_; commit scope, unrelated
  changes mixed together, gratuitous churn, or a change that should have been
  split into multiple commits. About the change as a thing-to-review, not the
  code.
- `testing` - test coverage, test quality, or testability of the code under
  change. Ensure added tests are not gratuitous and actually test functionality
  instead of padding the test suite.
- `docs` - explanatory deficit; missing or misleading docstrings, README,
  comments-as-spec. Overly verbose comments or references to process thoughts
  and vault materials should be removed.
- `tooling` - linter / formatter territory; lint config, formatting, idiomatic
  choices the toolchain would normally enforce.

### 1. <Short issue title>

**Severity:** `nit | low | medium | high | critical` (pick one) **Category:**
comma-separated from the rubric above **File:**
`path/to/file.ts:42-58 (a3f9c21)`

Description of the problem. Cite the offending lines via `path:lines (ref)`
rather than reproducing them - the code is already in the diff under review.

**Suggested fix:** prose for obvious changes. For non-obvious changes, a fenced
before/after block is allowed (and encouraged) - unlike `schema.md`, the code
under discussion already exists, so snippets here are commentary, not
pre-implementation.

```diff
- old line
+ new line
```

### 2. <Short issue title>

...

---

## Observations

_Optional._ Lettered (A, B, C). Non-blocking notes, praise, or context the
Implementor might want but does not need to act on. Useful for "this is fine but
worth knowing" remarks that would be noise as Issues.

### A. <Observation title>

...

---

## File summary

_Optional._ Table for large diffs. Helps the Implementor and human orient before
reading Issues.

| File              | LOC delta | Notes                       |
| ----------------- | --------: | --------------------------- |
| `path/to/file.ts` |    +42 -3 | <one-line characterization> |

---

<!--
Frontmatter notes:
- `created` and `round` are the only structural fields. The
  filename `reviews/<round>.md` carries the round number; the
  frontmatter `round` field is the machine-readable mirror.
- Branch / commit-group / diff stats live in the body header
  because they change per round and don't warrant frontmatter
  churn.

Severity rubric (used by Implementor in fully-auto mode):
- `critical`, `high`, `medium` -> Implementor must address.
- `low`, `nit` -> Implementor deliberates; may defer.

Verdict to loop edge:
- `Accept`, `Accept with nits` -> proceed to commit.
- `Request changes`, `Reject` -> loop back to Implement.

Shape reference: notes/template-shapes/review.md section 4.
-->
