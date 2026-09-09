# Testing conventions

> **Principle.** Test code correctness and consistency of the user experience.
> Start feature testing with complete user journeys, not a collection of unit
> tests. Test counts and coverage percentages are not measures of confidence.

## Feature testing: journeys first

For a feature or user-visible bug fix, first state the observable acceptance
criteria from the user requirement, documented contract, or reproduced failure.
Do not derive the expected answer solely from what the implementation currently
does. A separate test-writing agent does not make that answer independent if its
instructions merely repeat the implementation.

Make a small set of complete end-to-end journeys the primary evidence that the
feature works. Choose scenarios by risk and distinct outcomes: successful use,
an important failure or denial, and recovery where applicable. Extend an
existing journey when it covers the feature; do not multiply near-identical
cases to increase the count. If a journey cannot be automated, explain the
missing boundary and record manual validation rather than calling unit coverage
end-to-end coverage.

For native ACP, the target path is:

```text
ACP requests -> native composition -> shipped workflow -> real embedded loop
             -> tools, effects, checkpoints -> client-visible response
```

- Keep D3R's production path intact, including resource loading, role dispatch,
  tool argument validation, permission handling, and persistence. Use isolated
  temporary workspaces and private state, not the developer's credentials or
  working files.
- Replace external provider/network IO with deterministic fixtures. Feed model
  responses through the real embedded loop; do not replace `prompt()`, directly
  submit successful role reports, or substitute a simpler workflow and call the
  result a shipped-workflow journey. Inspect consequential provider requests so
  canned success cannot hide missing user context or malformed tools.
- Drive the client boundary and assert visible outcomes plus actual effects:
  useful messages, correct stop reasons, intended file contents, and successful
  recovery without unauthorized or repeated work. When streaming segmentation is
  not a contract, assemble the response before asserting its content.
- Include the compiled executable when validating launch, packaging, or stdio
  behavior. In-process ACP journeys do not prove that the installed binary
  launches correctly. An initialization/EOF smoke test alone does not establish
  that a feature works.
- State what is outside the test. An offline ACP client does not validate Zed's
  rendered UI, live authentication, or a real model's judgment. Use targeted
  client/manual checks and separately controlled live evaluations for those.

Keep offline journeys bounded and repeatable: no paid provider calls or real
login required, no arbitrary sleeps for synchronization, and deterministic
cleanup of temporary files and processes.

### Focused tests support the journeys

Unit and narrow integration tests remain useful for pure logic, input domains,
security boundaries, concurrency, and failure injection that would be expensive
or hard to diagnose end to end. Prefer properties such as round trips,
idempotence, and no-effects-before-approval where applicable. They complement,
not substitute for, evidence that the assembled feature works.

Prefer real implementations, then behavioral fakes, then stubs, then interaction
mocks. Assertions about calls are justified when the interaction is the
contract, such as not invoking a provider before approval. Do not freeze
incidental helper calls, object identity, parallel arrival order, or ID
spelling. An implementation-only refactor should not require changing behavioral
tests.

Test the D3R behavior that uses a dependency, not the dependency's documented
guarantees. A test that merely verifies a mock returned its configured answer
adds maintenance cost without demonstrating product correctness.

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
two-project shape and the `dist` alias map). Report their results separately
when discussing confidence: running a case against both projects does not make
it two independent behavioral guarantees.

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

Snapshots are allowed when they protect a deliberately chosen user-visible
surface: rendered output, CLI help and diagnostics, generated documents, or a
representative assembled conversation. Their purpose is intentional UX change
detection. Do not confuse this with freezing incidental internal data shapes,
object dumps, mock transcripts, or transport chunk boundaries.

A useful snapshot has:

- A representative scenario and a baseline captured from the exercised product
  path, then independently reviewed for correctness. Capturing the current
  output does not by itself make that output correct.
- A named UX guarantee and a bounded, readable diff. Prefer a stable projection
  of what the user sees over an entire ACP envelope or runtime object.
- Minimal normalization of genuinely irrelevant variability, such as temporary
  roots or timestamps. Do not normalize away errors, ordering that matters,
  missing content, or other differences the test is meant to expose.
- Explicit assertions for critical semantics: for example, a guidance snapshot
  does not replace checking the stop reason, permission outcome, file effect, or
  preservation of a checkpoint.
- Human review of intentional baseline changes. Do not bulk-accept updates just
  to make CI green. Keep credentials and private user/project content out of
  committed fixtures; recorded data must be safe to retain.

Snapshot baselines provide empirical examples, not automatic statistical
confidence. Exact snapshots of nondeterministic live-model prose are not a
reliable CI oracle. Use deterministic provider fixtures for repeatable product
journeys; evaluate real-model quality separately with representative samples,
repeated runs, and an explicit rubric.

Use `toMatchInlineSnapshot()` for small reviewable output and external
`__snapshots__/<file>.snap` files when they improve reviewability. Vitest is the
project default. A before/after comparison using a runtime's `snapshot()` API
can instead be a state-preservation invariant; it is not necessarily a golden
output snapshot test.

### Review test value, not just test results

Before considering a feature verified, ask:

- Which user requirement or regression does each journey establish? Which real
  components does it execute, and which boundaries are substituted or untested?
- Could a plausible bug still pass because the fixture manufactures success, the
  expectation comes from the same logic, or production code catches an assertion
  thrown inside a callback? Observe outcomes and assert outside such callbacks.
- Does a race test actually reach the contested state before cancellation or
  failure is injected? Use a synchronization point, not an immediate abort that
  tests only preflight.
- Would a behavior-preserving refactor break this assertion? If so, is the
  frozen detail an intentional UX or compatibility contract?
- Does the test add a distinct guarantee, or repeat existing coverage with more
  incidental assertions? Use targeted fault injection or mutation checks when
  needed to establish that the oracle detects the intended failure.

## Caveats

### `dist` project depth

The `dist` project's resolve aliases rewrite only the workspace package
specifiers (`@d3r/core`, `@d3r/tools`, `@d3r/cli`, `@d3r/adapter-acp`,
`@d3r/adapter-pi`) to their compiled entrypoints. Deep relative imports under
test (anything resolved via `./foo.ts` or a non-entrypoint subpath) still go
through Vite's TypeScript pipeline against source. In practice this means `dist`
mode catches publish-path regressions for the five package entrypoints and their
transitive imports, but a smoke test that imports a deep module by relative path
will not exercise compiled JS for that module. Smoke tests SHOULD import only
via the package entry; if you find yourself reaching for a deep import, prefer
widening the entry or adding a sibling test that goes through the entry.

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
