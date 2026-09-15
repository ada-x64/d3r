# D3R

This is d3r - a build system for D3R agent harness configurations.

## Engineering charter

These principles apply to the orchestrator and every worker role. A
self-contained task brief defines the requested work; it does not replace
applicable project instructions or engineering standards.

- **KISS is the golden rule. Simple is not easy.** Minimize concepts,
  dependencies, and obligations, not just line count. Compare simpler
  alternatives before adding machinery. Prefer the smallest coherent change;
  broader changes must earn their review and maintenance cost.
- **Protect data, then clarity.** Preserve user work and explicit invariants. Do
  not trade correctness for cleverness or speculative performance gains. Measure
  the relevant workload before optimizing.
- **Keep data plain and behavior explicit.** Use immutable records and focused
  transformations. Keep IO and mutable lifecycle state at clear boundaries; pass
  dependencies explicitly instead of hiding shared mutable state.
- **Parse at boundaries and use the result.** Turn external input into narrow,
  typed values. Carry that proof inward rather than revalidating raw input,
  discarding normalization, or casting uncertainty away.
- **Model valid states constructively.** Prefer precise variants and exhaustive
  handling over bags of flags and optional fields. Assert internal invariants;
  report recoverable input errors instead of replacing them with default data.
- **Give each rule one owner.** Keep representations, validation, policy, and
  identifiers with their owning subsystem. Share repeated knowledge when that
  removes a maintenance obligation; do not invent a framework for superficial
  similarities or hypothetical reuse.
- **Test behavior, not incidental structure.** Derive expectations from user
  requirements and independent evidence. Exercise real boundaries and actual
  effects; keep assertions outside callbacks that can swallow failures. A
  behavior-preserving refactor should not break tests unless a deliberately
  chosen UX or compatibility contract changes. Counts are not confidence.
- **Keep work reviewable and claims verifiable.** Stay within the requested
  scope, avoid unrelated moves, and keep comments focused on intent. Run the
  relevant project checks and report actual results and coverage gaps. Never
  bypass a failed check or claim verification that did not happen.

Read `CONTRIBUTING.md` for architecture, build, install, and mandatory checks.
`docs/data-oriented-design.md` contains the detailed, citable DOD rules;
`docs/testing.md` defines test and journey conventions. Read their relevant
sections before making or evaluating changes. Reuse instruction text already
provided; if essential guidance is inaccessible or contradictory, identify the
specific gap rather than guessing. Do not copy the full rule catalogue into role
prompts, task briefs, or generated artifacts.

## Human review

Crit is the standing default for human review of saved documents and scoped
commits, via an available harness integration or the installed CLI. This is a
presentation preference, not an extra browser checkpoint for every AI review. AI
reviewers remain read-only report producers; human approval neither replaces
that gate or a worker report nor authorizes commits, pushes, or unrelated work.

Follow [`docs/crit.md`](docs/crit.md) for target selection, CLI usage, approval,
cancellation, and privacy. Keep reviews local and unshared unless the user
explicitly requests exposure or upload. Honor explicit inline-only requests;
otherwise, if Crit is unavailable, explain and use Markdown. Do not auto-install
or download tools, or substitute `npx difit`.
