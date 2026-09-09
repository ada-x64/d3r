# Contributing to d3r

## Boundary

`core/` is harness-agnostic. `adapters/<harness>/` is where harness names are
allowed to appear. Do not leak harness specifics into `core/`, and do not
duplicate `core/` content inside an adapter -- adapters compile from `core/`,
they don't fork it.

## Quality gates

Every change must pass `pnpm check`, `pnpm lint`, `pnpm lint:md`,
`pnpm fmt:check`, and `pnpm test` before commit. Run `pnpm fmt` to auto-format.
Authored sources are ASCII-only (vendored files keep their upstream encoding).
Arrow functions only. Prefer `Promise.all` over awaits in loops.

Source code does not reference vault documents -- no decision IDs, section
numbers, or commit-schema labels in comments or commit messages. The code stands
on its own; the vault is for humans.

## Code shape & data-oriented design

d3r's TypeScript is reviewed against an opinionated, polemical stance, not a
neutral style guide; PRs are evaluated against named principle IDs from
`docs/data-oriented-design.md`, and disagreement is resolved by amending a
principle on its own PR rather than ignoring it in code.

The lineage is data-oriented design, functional programming, and transformation
pipelines: rows of plain data flow through pure functions, with IO confined to a
thin imperative shell.

Headline principles (one phrase each):

- `DOD-PRIORITY-ORDER` -- data-safety > clarity > anti-pessimization.
- `DOD-LAYERED-SHELL-CORE` -- imperative shell (`cli/`, `adapters/pi/`) wraps a
  pure functional core (`core/`, `tools/`).
- `DOD-NO-MUTABLE-STATE` -- no module-level `let`, no mutable singletons; inject
  dependencies as parameters.
- `DOD-PARSE-DONT-VALIDATE` -- at every untyped boundary, parse into a typed
  value and operate on the typed value thereafter.
- `DOD-AOS-DEFAULT` -- array-of-structs is the default in-memory layout for
  collections of records.
- `DOD-SCHEMA-AS-INTERFACE` -- the per-tool zod schema is the interface; no
  wrapper classes around it.

See `docs/data-oriented-design.md` for the full list of `DOD-` codes and the
review-citable IDs.

## Code comments

Only include comments where necessary to explain intention. A good comment
explains how the code got to this state, _not_ what the code does. A description
of intention will not drift, a mechanical description will.

All top-level items should have a brief jsdoc style comment.

## Adding a harness adapter

Mirror the shape of `adapters/pi/`: a workspace package with a `prebuild` script
that compiles `core/` into the package's own `dist/` and a `build` that
type-checks and emits the package's TypeScript. `pnpm -r build` then picks the
adapter up alongside everything else. The adapter owns capability-to-tool
mapping, prompt rendering, and extension vendoring. End-user installation is the
`d3r install <adapter>` verb's job, not a per-adapter shell script. If you find
yourself wanting to edit `core/` to make your adapter work, the boundary is
wrong somewhere -- stop and reconsider.

## Vault docs

The vault at `<repo-dir-root>/.agents/vault/` is its own git repo with linear
history. Most documents carry only `status` and `created` in frontmatter; path
encodes the rest. Schema documents under `tasks/<x>/schema.md` are the exception
and use the richer header that ties them to a task, design, branch, and date.

## Where the rules actually live

- Workflow shape: `core/schema.ts` (`Workflow` zod).
- Agent shape: `core/schema.ts` (`AgentSpec` zod).
- Slash commands and their chains: `core/workflow.yaml`.
- Open design questions: `.agents/vault/issues/`.

If you change a shape, update the zod schema first; the build will tell you what
else needs to move.

## File types

Avoid writing shell scripts. All code in this repo should be cross-platform
scripts written in TypeScript.

## Tests

ALWAYS add tests when writing new code, I don't care what the schema says. For
features and user-visible fixes, prioritize complete end-to-end journeys through
the production path, with external provider/network IO controlled for offline
runs. Add focused unit and seam tests where they provide distinct value; they
are not a substitute for proving the assembled feature works.

Test correctness and UX consistency, not incidental implementation details.
Reviewed snapshots of meaningful user-visible output are allowed; freezing
incidental internal shapes or blindly approving changed baselines is not. See
`docs/testing.md` for journey boundaries, snapshot review, and test-value
checks.

## Imports

Don't do this.

```ts
import type { AdapterEntry } from "../utils/data.ts";
// oxlint-disable-next-line no-duplicate-imports
import { ADAPTERS } from "../utils/data.ts";
```

Do this.

```ts
import { ADAPTERS, type AdapterEntry } from "../utils/data.ts";
```
