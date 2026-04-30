# Testing conventions

> **Principle.** Many tests does not mean good tests. We test our seams, not our
> dependencies.

A test that exercises an upstream library's documented behaviour adds
maintenance cost without buying confidence: when the library changes, the test
breaks for reasons unrelated to our code; when our code changes, the test passes
whether or not we broke anything that matters. Every test in this repo should
pin a behaviour we own at a seam we control.

## Runner basics

`pnpm test` runs the Vitest workspace, which has two projects:

- `src` -- runs the `*.test.ts` files against TypeScript sources.
- `dist` -- runs the same files with `@d3r/*` workspace specifiers aliased to
  each package's compiled `dist/` entrypoint, catching publish-path regressions
  (`exports`, `main`, declaration emit).

Other scripts:

- `pnpm test:dist` runs only the `dist` project. It silently depends on a prior
  `pnpm -r build`; the alias targets do not exist on a clean checkout.
- `pnpm test:coverage` runs both projects with v8 coverage. The report is
  informational; there is no threshold gate yet.

Configuration lives in `vitest.config.ts` (shared defaults: `node` environment,
`forks` pool, exclude rules, coverage settings) and `vitest.workspace.ts` (the
two-project shape and the `dist` alias map).

## Test-double categories

| Category                  | When to use                                            | Mechanism                                                       | Exemplar                                  |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------- |
| Pure / table-driven       | Logic with no I/O: parsers, validators, mappers.       | Plain `it.each` tables; no mocks.                               | `core/schema.test.ts`                     |
| memfs FS unit             | Code that reads or writes files but not symlinks.      | `vi.mock("node:fs")` + `vi.mock("node:fs/promises")` shims.     | `tools/vault/read.test.ts`                |
| `mkdtemp` FS integration  | Code that touches `realpath`, `lstat`, or symlinks.    | Real `fs.mkdtemp(os.tmpdir(), ...)` + `afterEach` cleanup.      | (use when memfs fidelity is insufficient) |
| MSW HTTP (below the seam) | Verifying request shape or response handling for HTTP. | `setupServer` in `beforeAll`, `server.use(...)` per test.       | `cli/test/exemplars/http-mapper.test.ts`  |
| DI fake (above the seam)  | Verifying business logic that consumes a provider.     | Hand-written fake passed through the production seam.           | `cli/test/exemplars/http-mapper.test.ts`  |
| Real subprocess fixture   | Verifying spawn-shape, argv, stdio, exit handling.     | `*.mjs` stub on disk; pass absolute path via `import.meta.url`. | `cli/test/exemplars/spawn-runner.test.ts` |

## Conventions

### HTTP -- DI above the seam, MSW below it

Rule of thumb: **DI fake above the provider seam, MSW below it.** If the code
under test takes a provider (an Octokit, a `fetch`, a typed client) as an
argument, give it a hand-written fake; do not stand up MSW just to prove the
code passes the right object through. If the code under test _is_ the provider
boundary -- the layer that constructs requests, parses responses, or translates
errors -- mock at the network with `msw`'s `setupServer` so the request shape
itself is what the test asserts. A third tier exists for Octokit specifically:
the constructor accepts a `request.fetch` injection and that is acceptable when
MSW would obscure more than it clarifies, but it is not the default.

### Filesystem -- memfs unit, `mkdtemp` integration

Rule of thumb: **memfs for unit, real `mkdtemp` for integration.** The workspace
ships `__mocks__/fs.cjs` and `__mocks__/fs/promises.cjs` that re-export
`memfs.fs`; opting in is `vi.mock("node:fs")` plus `vi.mock("node:fs/promises")`
at the top of the test file. memfs and the `vol` singleton are shared across
tests in the same worker, so reset it in `beforeEach(() => vol.reset())`. memfs
does not faithfully model symlinks, `realpath`, or `lstat`; tests of
path-hardening logic MUST use `fs.mkdtemp(path.join(os.tmpdir(), "d3r-"), ...)`
and clean up in `afterEach`.

### Subprocess -- real fixtures, not module mocks

Rule of thumb: **spawn a real fixture, do not mock `node:child_process`.**
Per-package fixtures live at `<package>/test/fixtures/bin/<name>.mjs` -- small
Node scripts that print known output, exit with known codes, or echo their argv.
Tests resolve the absolute path via `import.meta.url` and pass it to production
code through the existing harness or package-manager override hook. Mocking
`child_process` couples tests to spawn internals (env propagation, stdio piping,
signal forwarding) that the test will then assert without exercising; a real
fixture proves the end-to-end behaviour cheaply.

### Snapshots

Use `toMatchInlineSnapshot()` for small, local payloads where seeing the
expected value next to the assertion aids the reader. Use the
`__snapshots__/<file>.snap` external form for larger fixtures where inline noise
would drown the test. Do not adopt `node:test`'s snapshot format; Vitest's is
the project default.

## Caveats

### `dist` project depth

The `dist` project's resolve aliases rewrite only the four top-level package
specifiers (`@d3r/core`, `@d3r/tools`, `@d3r/cli`, `@d3r/adapter-pi`) to their
compiled entrypoints. Deep relative imports under test (anything resolved via
`./foo.ts` or a non-entrypoint subpath) still go through Vite's TypeScript
pipeline against source. In practice this means `dist` mode catches publish-path
regressions for the four package entrypoints and their transitive imports, but a
smoke test that imports a deep module by relative path will not exercise
compiled JS for that module. Smoke tests SHOULD import only via the package
entry; if you find yourself reaching for a deep import, prefer widening the
entry or adding a sibling test that goes through the entry.

## What NOT to test

- Do not assert that `citty.runCommand` parses flags.
- Do not assert that `Octokit` constructs URLs.
- Do not assert that `fs.mkdir` creates directories.
- Do not assert that pi's `registerTool` registers a tool.
- Do not assert that `vi.mock` substitutes a module.
- Do not assert that `msw` intercepts a request.
- Do not write tests of vendored upstream code under
  `adapters/pi/extensions/subagent/` or `adapters/pi/extensions/mode/`.

A test belongs in this repo when it pins the d3r mapping, error-translation, or
assembly logic that USES the upstream -- not when it pins the upstream itself.

---

Design: `.agents/vault/designs/testing-strategy/design.md`.
