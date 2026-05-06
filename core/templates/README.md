# `.agents/vault/.misc/templates/`

Document templates, one per kind. Every output document MUST follow the matching
template; deviations break downstream agents.

The vault root holds three governance files (`README.md`, `AGENTS.md`, `d3r.md`)
and six top-level directories (`blueprints/`, `notes/`, `process/`, `issues/`,
`reference/`, `.misc/`). The full layout — bucket semantics, loading-tier
gradient, and graduation rules — is governed by
`blueprints/vault-shape/blueprint.md`. Templates here scaffold the documents
that flow through that layout.

See `../../d3r.md` for which phase produces which kind.

## Frontmatter conventions

Frontmatter is **not** mechanically consumed yet — treat it as a human-facing
convention. A future tooling pass will tighten this.

Cross-vault references in frontmatter use **wiki-link style**: a bare slug, not
a path. The slug resolves within the field's home directory under `process/` and
may name either a file or a directory. Examples:

- `design: vault-architecture` — resolves under `process/designs/`.
- `plan: tooling` — resolves under `process/plans/`.
- `issue: adapter-pi-skeleton` — resolves under `issues/` (which lives at the
  vault root, not under `process/`).

Use a path only when a slug is ambiguous and disambiguation is required.
