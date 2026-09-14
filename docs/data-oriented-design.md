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
be absent). Mutating objects through hidden-class transitions can cost more in
long-running processes. For one-shot CLI invocations, startup and JIT warmup can
dominate; persistent ACP sessions need their own workload measurements. Neither
justifies speculative `.transform(o => ({ x: o.x ?? undefined }))`,
`.default(undefined)`, or other force-initialization scaffolding to "fix" the
shape. Optional properties remain an accepted trade-off. Benchmark the actual
workload before optimizing; measured evidence that changes this trade-off should
amend this principle, not prompt a one-off workaround.

## DOD-AOS-DEFAULT

The default in-memory layout for a collection of records is array-of-structs
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
Frame the change honestly: do not dress maintainability findings in substrate
vocabulary they have not earned.

## DOD-DRY-IS-LOAD-BEARING

DRY is positively load-bearing for this codebase, not merely tolerated. Removing
duplication can justify extra code, indirection, or a small runtime hit when it
makes behavior easier to maintain. One-shot CLI invocations and persistent ACP
sessions have different cost profiles; neither is proof that a path is cold or
hot. An anti-DRY performance argument must identify a specific hot path and
benchmark its cost in the actual workload. Absent that evidence, prefer shared
behavior, subject to DOD-MINIMUM-ABSTRACTIONS and the safety/clarity priorities.

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
mean: claim wall-clock wins from V8-shape changes. Startup and JIT warmup can
dominate one-shot CLI invocations; persistent ACP sessions can expose repeated
hot paths and accumulated allocation costs. Benchmark the relevant workload
before optimizing either. No principle here promises faster execution from
substrate-shape changes, and data-safety and clarity still outrank substrate
preferences.

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

KISS (keep it simple) is the golden rule: simple is not the same as easy. Prefer
less code and fewer concepts when they preserve safety and make behavior easier
to read; a quick abstraction or a shorter but cryptic expression is not simpler.
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
assertions for invariants the type system cannot express. "Non-trivial" means
the function does more than direct field access — it performs joins, narrowings,
parsing beyond a zod boundary, path resolutions, state transitions, or other
computed transforms whose correctness the static types cannot prove. Use
`node:assert/strict` (or an equivalent that throws on failure). Boundary parsing
already covered by zod is not the target; mid-pipeline preconditions and
postconditions are. The cost is assertion noise; the benefit is faster, clearer
failure when an upstream change violates an assumption a downstream function
silently relied on.

## DOD-DATA-AS-ROWS

A collection of records is rows in a table, not entities in a domain model. The
shape is a packed `Array` of plain objects (or, when justified per
DOD-AOS-DEFAULT and DOD-ELEMENT-KIND-DISCIPLINE, columnar arrays); the
operations are filters, joins, mappings, and reductions over those rows, written
as free functions. This binds the vault and any future store of documents,
relationships, or derived indices: documents are rows, links between them are
join keys, queries are transforms. Do not introduce an entity class with methods
to represent a document, a link, or an index entry; the row plus a function over
rows is the representation. Behavior that naturally clusters with one shape
(e.g. a schema's `.parse()`, an ADT's constructors) still lives next to that
shape — what is rejected is the rich-domain-model move of attaching mutable
identity-bearing methods to every record kind.

## DOD-IDENTITY-VALUE-STATE

When the same logical thing changes over time, model it as three distinct
concepts rather than as one mutable object. A **value** is the immutable content
at an instant — the file bytes at this hash, the row at this timestamp, the
parsed record at this revision. An **identity** is the stable handle that points
to whichever value is current — a path, a slug, a primary key. **State** is the
association between an identity and a value at a moment in time, and changing
state means swapping which value the identity points at, not mutating the value
in place. Any data structure where "the same thing changes" is in scope: vault
documents under edit, recollection entries that get re-summarized, caches that
get invalidated. Reading a record returns a value; updating it produces a new
value and re-binds the identity. This composes with DOD-NO-MUTABLE-STATE (no
in-place mutation of records) and DOD-DATA-AS-ROWS (the value is a row; the
identity is the key).

## DOD-IDS-OVER-REFS

Cross-record references are stable IDs resolved through a central registry, not
in-memory object pointers between records. A document that mentions another
document carries the other document's id (path, slug, hash) as a plain string or
branded primitive; the resolver — the vault index, the recollection store, the
lookup table — turns the id into the row when needed. Object-graph
representations (a `Document` whose `.links` field is an array of other
`Document` instances) are rejected: they do not round-trip through JSON, they
tangle ownership and lifetime, they make schema evolution painful, and they
fight every other principle in this document that wants flat rows. The id +
registry shape composes with DOD-DATA-AS-ROWS (links are join keys),
DOD-TYPED-DOD (ids are branded primitives or schema fields, not bare numbers
floating around), and DOD-IDENTITY-VALUE-STATE (the id is the identity).

## DOD-PIPELINE-DATA-IS-PLAIN

Data flowing between phases of an in-process pipeline is plain in-memory
records, not bytes that get serialized at one phase boundary and parsed back at
the next. The legitimate serialization boundaries are at IO: argv in, file
contents in, tool output out — covered by DOD-PARSE-DONT-VALIDATE and
DOD-ZOD-AT-BOUNDARIES. Inside the functional core, when a vault walk produces
joined `(entry, frontmatter)` rows that feed a linter that feeds a reporter, the
rows are passed through as the typed values they already are; no
`JSON.stringify` between phases, no zod re-parse on data already known to be
valid by construction, no "normalize via round-trip" idioms. Re-parsing
in-memory data is duplicated work and a duplicated source of truth: the type is
the contract once it is established.

## DOD-SEGREGATE-BY-VARIANT-WATCH

When a sequence of records carries a discriminator and a hot loop iterates the
sequence in bulk, branching on the discriminator inside the loop is the worst
shape: it produces a megamorphic call site and pays the discriminator cost on
every element. The fix is to segregate the sequence into one packed array per
variant up front, then loop each homogeneous array separately — each loop
becomes monomorphic and the discriminator is implicit in which array you are in.
d3r has no such hot loop today; this rule binds when one emerges. The likely
first surface is bulk processing across heterogeneous result streams (lint
output growing past per-doc serial scanning, a future analysis pass over many
vault documents at once). When that day arrives, the answer is segregation, not
a `switch` per element. Until then, the principle records the shape so a
reviewer can name it the moment a bulk-iterated tagged union appears.

## DOD-HOIST-RARE-FIELDS-WATCH

When a record type accumulates fields that only a small fraction of instances
ever use, those fields belong in a side table keyed by record id, not as
optional fields on the hot type. Carrying a sparsely-populated optional on every
row pays a hidden-class and reading-cost tax on the common case to serve the
rare case; lifting the rare fields out leaves a smaller, more uniform hot type
and concentrates the rare-case complexity in one explicit place. The shape is
`Map<RecordId, Extra>` (or a parallel array indexed by id) alongside the main
rows. This rule bites the moment a record gains a third or fourth optional field
that genuinely is rare in practice, or when a schema review notices that a hot
type has grown a long tail of `?:` fields each used by one caller. Until
measured to matter on a specific record type, the default stays plain rows; the
principle names the move so it can be reached for without debate when the
conditions trigger.

## DOD-DISPATCH-TABLE-IF-HOT-WATCH

When a dispatch path becomes hot and currently branches polymorphically on the
shape of its input — a chain of `instanceof` checks, a `switch` on a `kind` tag,
an `if/else` ladder over feature presence — replace it with a dispatch table
indexed by the discriminator, where each row is a homogeneous handler. The
dispatched-to function then operates on a single subtype, the call site stays
monomorphic, and adding a new variant is a one-row diff in one place rather than
a new branch threaded through a switch. d3r's tool dispatch path is not
currently hot in this sense, and the polymorphic shape there is not yet a
problem. The watchlist trigger is: a dispatch site shows up in real profiles,
_or_ adding a new variant has come to require edits in more than one branch of
the same switch. Either condition turns this from a future-shape note into an
active recommendation; absent both, plain dispatch is fine.

## DOD-BOUNDED-LOOPS-WATCH

Loops and queues that consume external input — directory walks, glob expansions,
recursive tree traversals, retry loops, queue drains — are unbounded by default
in JavaScript and that is fine until it is not. The watchlist rule: when an
unbounded loop in d3r causes a real failure (a vault walk pathology, a glob that
explodes, a recursion that does not terminate, a retry that hammers a flaky
boundary), the fix is to add an articulated upper bound at that site — a maximum
depth, a maximum count, a maximum wall-clock budget — chosen to be larger than
any real workload and small enough to convert a runaway into a clean failure.
Until then, do not pre-emptively sprinkle bounds on every loop in the codebase;
that is the kind of ceremony DOD-MINIMUM-ABSTRACTIONS rejects. The principle
exists so that when a real incident happens, the response is structural (bound
the loop) rather than tactical (add a one-off guard).
