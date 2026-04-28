# Contributing to d3r

## Boundary

`core/` is harness-agnostic. `adapters/<harness>/` is where harness names are
allowed to appear. Do not leak harness specifics into `core/`, and do not
duplicate `core/` content inside an adapter -- adapters compile from `core/`,
they don't fork it.

## Quality gates

Every change must pass `pnpm check`, `pnpm lint --deny-warnings`,
`pnpm lint:md`, and `pnpm fmt:check` before commit. Run `pnpm fmt` to
auto-format. Authored sources are ASCII-only (vendored files keep their upstream
encoding). Arrow functions only. Prefer `Promise.all` over awaits in loops.

Source code does not reference vault documents -- no decision IDs, section
numbers, or commit-schema labels in comments or commit messages. The code stands
on its own; the vault is for humans.

## Adding a harness adapter

Mirror the shape of `adapters/pi/` as a workspace package with its own
`scripts.build` and invoke it via `pnpm --filter @d3r/<adapter-name> build`. The
adapter owns capability-to-tool mapping, prompt rendering, extension vendoring,
and the install script. If you find yourself wanting to edit `core/` to make
your adapter work, the boundary is wrong somewhere -- stop and reconsider.

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
