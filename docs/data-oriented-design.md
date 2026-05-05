# Data-oriented design

This document collects the design principles d3r's TypeScript code is held to in
review. It is written for contributors writing or reviewing PRs against this
repo. Each principle has a greppable code (`DOD-…`) so reviews and follow-up
tooling can cite it directly: `git grep DOD-NO-MUTABLE-STATE` finds the rule and
any PR comment that invoked it. If you disagree with a principle, the path is to
amend it on its own PR — not to ignore it in code.

## Scope

These principles apply to authored TypeScript under `cli/`, `core/`, `tools/`,
and the d3r-side of `adapters/`. They do not apply to vendored code under
`adapters/pi/extensions/{subagent,mode}/**`. Test-mechanics guidance (snapshots,
`vi.mock`, runner setup) lives in [`testing.md`](./testing.md) and is not
duplicated here.

## DOD-PRIORITY-ORDER

Concerns are ranked: **data-safety > clarity > anti-pessimization**. Code that
touches user state (vault writes, file moves, path resolution, future non-vault
data) must not corrupt or lose that state, no matter what other properties it
has to give up. Below that, code should be readable and intent-clear before it
is clever about the substrate. Below that again, avoid writing actively
V8-pessimal shapes when an equally readable alternative exists. Aggressive
optimization is not a primary motivator at all: if performance ever becomes the
goal, the answer is a port to a faster language, not contortions in TypeScript.
When two principles in this document conflict on a specific piece of code,
resolve the conflict by this order.

## DOD-LAYERED-SHELL-CORE

The codebase has named layers and new code is placed by what it does. `cli/` is
the **imperative shell**: it does IO, parses argv, dispatches verbs, and
orchestrates side effects. `core/` and `tools/` are the **functional core**:
they consume and return plain values, do no IO, and are unit-testable without
mocks. `adapters/pi/` is a second imperative shell on the harness side.
Placement rule for new code: _does this do IO? → shell. Does this transform
plain data? → core._ The same shell/core pattern recurs at the agent layer (an
orchestrating agent is the shell; subagents are the functional core), and the
same placement rule applies when designing agent workflows.

## DOD-NO-MUTABLE-STATE

Mutable shared state is the enemy. No `let` at module scope; no mutable
singletons; no module-level caches that accumulate across calls. Where a
function needs a dependency it cannot construct itself (a subprocess runner, an
IO seam, a clock), inject it as a parameter and let the composition root wire
the real implementation. `InstallDeps` in `cli/src/verbs/install.ts` and
`DispatchIO` in `cli/src/verbs/tool.ts` are examples of the pattern —
generalize, do not regress. A hidden mutable singleton is a tier-1 finding under
DOD-PRIORITY-ORDER, because it silently couples otherwise-independent transforms
and lets state escape the layer it belongs to.

## DOD-PARSE-DONT-VALIDATE

At every boundary where untyped bytes enter the program — argv, stdin, file
contents, frontmatter, env vars, tool params — parse the input into a typed
value and operate on the typed value thereafter. Do not pass raw input deeper
into the program with a separate "is this valid?" check guarding each use; the
parser is the validator and its return type is the proof. The phrase "parse,
don't validate" is the canonical search term for this discipline; use it in PR
review.

## DOD-ZOD-AT-BOUNDARIES

Zod is the boundary parser, not a pervasive internal type system. Every
IO/argv/frontmatter/tool-params boundary uses a zod schema, and its inferred
type flows into the rest of the program. Internal-only data shapes that never
cross a serialization boundary should be plain `interface`/`type` or branded
primitives — not zod schemas dragged through the core for uniformity. Zod's job
is parsing; once a value is parsed it is just typed data and the type system
carries it from there.

## DOD-ZOD-OPTIONAL-ACCEPTED

`z.object({ x: z.string().optional() })` infers `{ x?: string }` (property may
be absent), which is the shape V8 likes least when an object is mutated through
hidden-class transitions in a long-running process. d3r runs as a short-lived
CLI where startup and JIT warmup dominate, so this cost is invisible in
practice. Do **not** introduce `.transform(o => ({ x: o.x ?? undefined }))`,
`.default(undefined)`, or other force-initialization scaffolding to "fix" the
shape. The trade-off is documented here so contributors know it is a knowingly
accepted cost, not an oversight; if a future workload changes the answer, that
will amend this principle, not show up as a one-off workaround in code.

## DOD-AOS-DEFAULT

The default in-memory layout for a collection of records is array-of- structs
(rows of objects in a packed `Array`). Plain JavaScript struct-of-arrays buys at
most ~1.2× on the kinds of microbenchmarks that flatter it and is sometimes
negative; V8 specifically optimizes arrays-of-objects, and there is no
auto-vectorization to chase. SoA is permitted only with an articulated reason —
bulk numeric math through typed arrays, a genuine variant-segregation hot path,
or a downstream consumer that needs columnar shape. "DOD canon says SoA" is not
such a reason.

## DOD-ELEMENT-KIND-DISCIPLINE

When SoA is justified, name the V8 elements kind the arrays will land in.
Numeric data goes into typed arrays (`Float64Array`, `Int32Array`, etc.), which
are exempt from the `PACKED_*`/`HOLEY_*` transition machinery. Object and string
rows go into a plain `Array` kept packed and homogeneous: do not push mixed
types, do not write past the length to create holes, do not assign `undefined`
where you mean "remove". A code review for a new SoA-shaped data structure
should be able to point at the sentence in the PR that says which elements kind
it lands in.

## DOD-SCHEMA-AS-INTERFACE

The per-tool zod schema _is_ the interface. The pattern is
`export const FooParams = z.object({...}); export type FooParams = z.infer<typeof FooParams>;`
— consumers read and write the schema's shape directly. Do not wrap a schema in
a class, a service, or a "view model" that re-exposes the same fields with
getters and setters. Encapsulation in DOD-shaped code is the schema's job; a
wrapping object adds ceremony without changing what the data is. New tools and
new boundary shapes use the same idiom.

## DOD-EXISTENCE-OVER-FLAGS

Prefer presence in a table or set to a boolean or enum field on a record. The
verb registry already does this once: `gateExemptVerbs` is a `Set` that names
the verbs exempt from the vault gate, instead of a `verb.exempt: boolean` field
hanging off every verb row. Optional behaviors that attach to "some of these
things" should attach as membership in a side table, not as a field that is
mostly false. This keeps the row shape stable, makes the exception list itself
reviewable in one place, and avoids the readability tax of fields that almost
never matter.

## DOD-NO-CLASSES-FOR-DATA

Authored TypeScript does not introduce class hierarchies to model data. Use zod
schemas, plain `type`/`interface` records, free functions, and discriminated
unions (the `Result<T, E>` ADT is the worked example). TypeScript-specific
reasons reinforce the rule: classes do not round-trip through
`JSON.parse`/`JSON.stringify` without bespoke revivers, and most of d3r's data
either crosses a JSON boundary or could; `instanceof` is not a type-safety
boundary because structural typing can spoof it; and getters, setters, and
decorators promote hidden mutation, which directly violates
DOD-NO-MUTABLE-STATE. If you find a problem that seems to want a hierarchy, the
move is almost always a discriminated union of plain records, not a base class.

## DOD-TYPED-DOD

Never silently lose types in the name of a data-oriented shape. When a
recommendation here proposes flattening typed structures into index-keyed tables
or homogeneous rows, it must specify how typing is retained. Preference order:
zod schemas first; branded primitive types
(`type NodeId = number & { __brand: 'NodeId' }`) for opaque ids and table keys
where a schema would be overkill; explicit, logged acceptance of a type-erasing
cast only when neither will work. The `as (...args: never[]) => unknown` cast in
`tools/registry.ts` is an example of the third tier — kept because the
registry's homogeneity is the load-bearing property and the cast is the cost of
that homogeneity, not because casts are fine.

## DOD-TABLES-OVER-FILES

When a set of files exists only because they share a kind (one file per lint
kind, one file per tool type), and their byte content is materially the same
modulo a key, replace them with a single table indexed by that key. The per-kind
frontmatter lint files are the canonical case: seven sibling files differing
only by the kind tag collapse to one `kindSchemas` table. The cost is one denser
file instead of several smaller ones; the benefit is that adding or changing a
kind is a single-row diff in a single place, and any rule that should apply to
"every kind" cannot be silently missed on one file.

## DOD-DEFEND-HOMOGENEOUS-REGISTRIES

Where a registry table already exists and works — `tools/registry.ts` is the
canonical case — defend its row homogeneity. Do not dissolve a table back into
per-tool exports because one row's type signature is inconvenient. The
registry's value is that every tool is reachable through the same dispatch path,
with the same row shape, in one place that can be enumerated, audited, and
tested. A type-system inconvenience inside one row is a candidate for a typed
factory or a tightened cast, not for breaking the table apart. New cross-cutting
concerns (telemetry, gating, help text) attach as columns or as side tables, not
as scattered imports.

## DOD-MATERIALIZE-SHARED-WALKS

When the same traversal-plus-join pattern appears at more than one site — the
canonical case is `walkVault → filter .md → Promise.all(read + parseFm)`, which
produces the joined `(entry, frontmatter)` rows that several vault tools need —
promote it to a shared primitive that returns the joined rows. Do not duplicate
the walk and the join, and do not extract only the inner helpers while leaving
the join skeleton repeated at each call site. The principle is older than the
current sites: any future vault tooling that needs the same shape should call
the shared walk, not write a new one.

## DOD-CONFIG-AT-SHELL

Configuration is loaded once at the shell boundary, parsed and narrowed there,
and passed as plain data into the core. No `process.env.X` reads inside `tools/`
or `core/`; no scattered defaults injected from arbitrary modules; one parse
site per config source. The vault-gate's YAML config walk in `cli/` is the
worked example — it produces a plain config object that flows into core-layer
transforms, and core-layer code never asks the environment a question. New
configuration sources land at the same boundary in the same shape.

## DOD-CORE-TESTS-FIRST

Test coverage prioritizes core-layer gaps over shell-layer gaps. The functional
core is unit-testable without mocks, so a missing test there is cheap to add and
high-leverage. The imperative shell needs few integration tests because it has
little branching, but each test costs mocks, fixtures, and IO setup. When
deciding what to test next, untested core code (the `tools/` family in
particular) outranks untested shell code (CLI entry points, install spawn) at
equal risk. Lower-priority does not mean ignore; it means the cost-benefit ratio
favors core coverage when both are open.

## DOD-DUPLICATION-IS-MAINTAINABILITY

Duplication is a maintainability problem, not a performance or data-oriented
problem. When you remove a repeated `errMessage`, an `isEnoent` check, or a
`safeStat` wrapper, the justification is "changing this shouldn't require
finding seven copies", not "V8 will inline it better" or "DOD wants tables".
Frame the change honestly. The polemic stays sharp by refusing to dress
maintainability findings in substrate vocabulary they do not earn.

## DOD-DRY-IS-LOAD-BEARING

DRY is positively load-bearing for this codebase, not merely tolerated. Removing
duplication is worth a real cost in code volume, an extra indirection, or a
small runtime hit, because d3r is one-off-task-shaped (CLI invocations) and has
no hot path in the sense that "don't DRY in hot paths" arguments require. The
general rejection of DRY-as-anti- pattern that some performance-oriented writing
trades in does not bind here. Any anti-DRY argument that wants to apply must
show a specific hot path and a measured cost; absent that, DRY wins.

## DOD-COVER-TYPE-OPTIONAL

A "cover type" is a type whose fields are mostly optional because it covers
several real shapes that share one nominal type — zod's `_def` accessed through
`as { typeName?: string; ... }` is the example in this codebase. Tightening a
cover type into a discriminated union is an optimization, not a requirement.
Raise it as a finding only when the cover-type access is causing a real reading
or maintenance problem, not because the substrate would prefer a stable shape.
The substrate preference is real but does not bind d3r's workloads (see
DOD-SUBSTRATE-AS-GUARDRAIL).

## DOD-FILE-SIZE-TASTE

Roughly 500 lines is a soft taste threshold for a single source file in authored
code. A file over that length is a _trigger to look_ for a clarity-or-intent
split, not an automatic finding. A file under it is not a finding for being
long. Any recommendation to split a file must articulate the readability or
intent gain (this rule isolates that concern; this section captures one stable
lifecycle) — not invoke size on its own. The threshold scopes to code only; this
document and `testing.md` are not bound by it.

## DOD-SUBSTRATE-AS-GUARDRAIL

The V8 + Node substrate is treated as an anti-pessimization guardrail, not as an
optimization lever. That means: don't write code that forces megamorphic inline
caches or `HOLEY_ELEMENTS` arrays for no reason (monomorphic call sites, packed
homogeneous arrays, stable hidden classes are the defaults). It does **not**
mean: claim wall-clock wins from V8-shape changes. d3r is a short-lived CLI;
startup and JIT warmup dominate hot-path IC behavior. No principle here promises
faster execution from substrate-shape changes; the rationale for a guardrail is
"this would be actively bad if we ignored it", not "this will make the program
faster".

## DOD-COST-AND-BENEFIT

Every non-trivial structural change states both an honest cost and a
behavior-side benefit. Cost includes added code volume, added types or schemas,
type-safety surrender, reading effort, additional indirection. Benefit includes
what becomes simpler to write, read, test, change, or extend. One-sided pitches
— only benefits, no costs; only costs, no articulated benefit — are defects in
the proposal, not virtues. A change that looks free is one whose costs were not
yet found.

## DOD-BEHAVIOR-PAYOFF

The benefit half of DOD-COST-AND-BENEFIT must include a _behavior-side_ win —
something that becomes simpler to write, read, test, or extend — not only a
data-shape-aesthetic win. The failure mode this guards against is piling on
schemas, branded types, table collapses, side tables, and registries until the
data layer _looks_ sophisticated while the actual behavior still lives in a
single fat switch with the same shape it always had. If you cannot point at the
function or the test that gets simpler, the structural change has not earned
itself yet.

## DOD-MINIMUM-ABSTRACTIONS

Introduce an abstraction only when nothing simpler will do. Zod offers
everything; class hierarchies are easy to write; effect systems and state
machines are available off the shelf. The bar is "excellent for this specific
job", not "available". When proposing a new abstraction, the proposal must
articulate why a plainer alternative — a function, a record, a switch — was
rejected. The minimum-of-excellent-abstractions discipline composes with
DOD-BEHAVIOR-PAYOFF: an abstraction that does not earn its keep on the behavior
side is the kind that should not have been introduced.

## DOD-ASSERT-INVARIANTS

At non-trivial transformation points inside the functional core, add runtime
assertions for invariants the type system cannot express. "Non- trivial" means
the function does more than direct field access — it performs joins, narrowings,
parsing beyond a zod boundary, path resolutions, state transitions, or other
computed transforms whose correctness the static types cannot prove. Use
`node:assert/strict` (or an equivalent that throws on failure). Boundary parsing
already covered by zod is not the target; mid-pipeline preconditions and
postconditions are. The cost is assertion noise; the benefit is faster, clearer
failure when an upstream change violates an assumption a downstream function
silently relied on.
