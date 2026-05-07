# Vault

This directory is your project's vault: the durable, human-readable record of
how decisions and work flow alongside the codebase.

It is a plain git repository of Markdown. Everything here is meant to be read,
edited, and reviewed like any other source file. Agents collaborating in this
repo respect the same conventions humans do.

## Where to start

- `d3r.md` — operating model. Read this first. It names the document kinds,
  explains how they relate, and points to the per-kind templates.
- `AGENTS.md` — rules for any automated collaborator working under this
  directory. Cascades into every subdirectory.
- `.misc/templates/` — one template per document kind. Every new document
  follows the matching template.

## Layout

- `blueprints/` — area-scoped principles and conventions.
- `notes/` — durable references and standalone observations.
- `reference/` — third-party material kept verbatim for citation.
- `process/` — designs and per-task working folders.
- `issues/` — kanban columns plus an `.umbrellas/` sibling for parent issues.
- `.misc/` — archive and the shared template set.

Add content as the work demands; the layout above is what tooling expects to see
at the root.
