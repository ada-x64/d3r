# Data-oriented design

> **Polemic stance.** d3r's code shape is governed by an opinionated stance, not
> a neutral style guide (D2). PRs are reviewed against the principle IDs minted
> here. If you disagree with a principle, the path is to amend it on its own PR
> — not to ignore it in code.

## 1. Preamble

### Lineage

The principles in this document are a particular synthesis of three traditions,
named explicitly so a reader can tell which prescription draws from which (D9):

- **Data-oriented design** (Acton, Fabian, Kelley) for tables, normalisation,
  existence-based processing, segregate-by-variant.
- **Functional programming** (Hickey, King, Bernhardt) for values vs. places,
  `parse, don't validate` (D10), and the functional-core / imperative-shell
  split.
- **Transformation pipelines** (esbuild, ndjson-cli, Bostock-style data work)
  for the stream-of-records-through-transforms shape.

The audit deliverable that companions this doc is "DOD + FP + pipelines vs. the
OO/DDD default", not "pure DOD canon vs. everything." Treat lineage tags as
honest provenance, not branding.

### Audiences

This doc has three audiences, listed in priority order:

1. **Future contributors** (humans) writing or reviewing d3r code. Primary.
2. **Future agent runs** — re-audits, regression detection, and any hypothetical
   lint-rule generation. The rules table is shaped to be grep-able for this
   reason (D13).
3. **Designers of incoming work** consuming the forward-binding callouts in §8 —
   vault-store, recollection-store, and future vault tooling (P20, P22).

### Headline commitments

Six commitments frame the rest of the document. Each is one phrase here; the
load-bearing definitions live in §3–§5.

1. **Priority order:** data-safety > clarity > anti-pessimization (D12).
2. **Named layers:** `cli/` is the imperative shell, `core/` + `tools/` are the
   functional core, `adapters/pi/` is the harness boundary (D11).
3. **No mutable state:** no module-level `let`, no mutable singletons, DI at the
   composition root (P21).
4. **Parse, don't validate** at IO boundaries; zod is the boundary parser, not a
   pervasive internal type system (D6, D10).
5. **AoS by default:** rows-of-objects in packed `Array`s; SoA only with
   articulated cause (D7).
6. **Schema-as-interface:** the per-tool `FooParams` zod schema and inferred
   type alias are the contract; consumers read and write the schema's shape
   directly (P18).

### Rule-of-rules

Two cross-cutting disciplines apply to every non-trivial principle row in §5:

- **Cost and benefit are both reported.** Every non-trivial principle states
  both an honest cost (code volume, type-safety surrender, reading effort) and a
  behaviour-side benefit — never a data-shape-aesthetic benefit alone (P13,
  P19). One-sided rules are defects.
- **Minimum of excellent abstractions.** Recommend an abstraction only when
  nothing simpler will do; the rule's `benefit` cell must articulate why a
  plainer alternative was rejected (P26).

## 2. Data-flow map of d3r

Stub. Authored in a follow-up commit.

## 3. Named architectural layers

Stub. Authored in a follow-up commit.

## 4. Priority lens

Stub. Authored in a follow-up commit.

## 5. Principles

Rows are sorted by `tier` (1 — data-safety, 2 — clarity, 3 — anti-pessimization)
and then by `area` slug alphabetically within each tier (D12). IDs
(`P-<area>-<n>`) are stable once minted; downstream artifacts cite them by ID.

| id  | area | principle | anti-rule | tier | cost | benefit | lint-hint? | cite |
| --- | ---- | --------- | --------- | ---- | ---- | ------- | ---------- | ---- |

## 6. Beachheads to defend

Stub. Authored in a follow-up commit.

## 7. Why this isn't an anemic domain model

Stub. Authored in a follow-up commit.

## 8. Forward-binding callouts

Stub. Authored in a follow-up commit.

## 9. Future-trigger watchlist

Stub. Authored in a follow-up commit.

## 10. Out-of-scope clarifications

The following are intentionally outside this document's scope:

1. **Rust port viability.** A possible future port of d3r to Rust is a real
   downstream constraint on how much restructuring effort is worth investing in
   the TypeScript code, but reasoning about it is not part of these principles
   (ORQ1).
2. **Vendored surface.** Code under `adapters/pi/extensions/{subagent,mode}/**`
   is vendored and is not bound by these principles by default. The
   forward-binding callouts in §8 may name it where relevant.
3. **No affirmative perf claims.** The V8 substrate is treated as an
   anti-pessimization guardrail, not as an optimization lever. No principle here
   promises wall-clock speed-ups from V8-shape changes (P9, P14).
4. **Snapshot and `vi.mock` doctrine.** Test mechanics are owned by
   [`testing.md`](./testing.md); these principles cross-reference it but do not
   extend it.
5. **Authored lint rules.** Mechanical enforcement is future work; the
   `lint-hint?` column on each principle row tags candidates only and is not a
   commitment to write the rule.
