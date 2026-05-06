---
area: <kebab-case slug, matches the parent directory name>
repos: [<owner/repo>] # may be empty if not repo-bound
tags: [] # optional; aids discovery
created: <ISO Date>
updated: <ISO Date> # bumped on edit
summary: <one-line statement of what this blueprint governs>
---

# <Area name> — blueprint

> One paragraph: what region of concern this blueprint covers, why it exists,
> and what kind of design work draws from it. Written for a future operator (or
> agent) opening the area cold.

---

## Purpose

What is this area? What problems does it claim authority over? What does its
existence assert about how the project works?

Keep this section stable — it should change rarely, only when the area itself is
reframed.

## Scope

What's in scope for this area, and what's adjacent-but-out. Cite neighbouring
blueprints (`blueprints/<other-area>/`) where boundaries abut.

- **In scope:** …
- **Out of scope:** …
- **Adjacent areas:** `blueprints/<other-area>/` — what differs.

## Principles

Operator-ratified beliefs that govern decisions within this area. Append-only;
never delete, only supersede with explanation. Each principle should be the kind
of statement a downstream design can inherit without re-deriving.

- **P1.** …
- **P2.** …

## Conventions

Concrete rules that apply within this area — naming, layout, ordering, required
artifacts, forbidden patterns. Sub-headings as needed for readability. These are
the load-bearing operational specifics; designs in this area MUST honor them or
supersede them with a new conventions revision.

### <subtopic>

- …

## Open questions

Area-level questions that remain open. Distinct from design-phase open questions
(those live in a specific `process/designs/<topic>/` bundle). These are the
"what we still don't know about how this area should work" items.

- **Q1.** …

## References

Where this blueprint draws from and where downstream work hangs off.

- **Source designs:** `.misc/archive/designs/<slug>/` — the in-flight design
  that produced this blueprint, if any.
- **Active downstream designs:** `process/designs/<slug>/` — designs currently
  operating within this area.
- **Related notes:** `process/notes/<slug>/` — observations relevant to this
  area but not governing.
- **External references:** URLs, papers, prior art.

---

## Lifecycle

This blueprint is **maintained**, not archived. Revisions happen in-place; git
history is the change record. If the area itself is dissolved or absorbed,
archive the directory under `.misc/archive/blueprints/<area-slug>/` with a final
commit noting the supersession (and ideally a link to whatever absorbed it).

---

<!--
Frontmatter notes:
- `area` is the kebab-case slug and matches the parent directory
  name (`blueprints/<area>/blueprint.md`).
- `repos` may be empty for cross-cutting areas not tied to a
  specific repo.
- `tags` aids discovery and vector-DB routing.
- `created` / `updated` are ISO dates; `updated` is bumped on
  every non-trivial revision (this blueprint is maintained, not
  archived, so `updated` is the freshness signal).
- `summary` is a one-line statement used by readers (and the
  Researcher) to decide whether to load the full blueprint.

Filling in the body:
- Populate `## Purpose`, `## Scope`, `## Principles`,
  `## Conventions`, `## Open questions`, `## References`, and
  `## Lifecycle` in that order. All sections are required;
  empty sections SHOULD say so explicitly rather than be
  omitted.
- Principles are operator-ratified and append-only. Number them
  `P1`, `P2`, ... and never renumber. Supersede with a new
  principle that cites the prior one by id rather than editing
  in place.
- Decisions made inside designs that draw on this blueprint cite
  principles by id (`P3`) and cite this file by path
  (`blueprints/<area>/blueprint.md`). Do not invent a separate
  decision-numbering scheme inside the blueprint itself; that
  belongs in the design that ratified the decision.
- `## Lifecycle` should state, in one paragraph, whether the
  blueprint is maintained in place (the default) or has a
  scheduled review cadence, and what an absorption / dissolution
  looks like. The default text shipped with this template covers
  the maintained-in-place case; rewrite if the area's lifecycle
  differs.

Shape reference: notes/template-shapes/blueprint.md section 4.
-->
