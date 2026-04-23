---
topic: <kebab-case slug, matches filename>
repos: [<owner/repo>] # may be empty if not related to any repo
tags: [] # optional; aids vector-DB routing. TODO: Add a tool to scrape tags so researcher can see which tags are already available.
created: <ISO Date>
updated: <ISO Date> # bumped on edit; supports staleness GC
summary: <string> # short description, used to indicate when this note should be loaded into context
---

# <Descriptive title>

---

## Overview

What this note covers, what it doesn't, and when to reach for it.
Scope, audience, and a pointer to related notes if any. Keep it
short - the body sections carry the substance.

---

## <free-form sections>

Topic-driven, not prescribed. Use whatever sectioning makes the
material legible. Reference tables, prose, diagrams, and code
snippets are all fair game. Try to keep code snippets up-to-date; if they are used, specify the git ref, file, and line number. 

Cite external facts inline using `path:lines (ref)` (repo),
vault-relative paths (vault), or full URLs (web).

---

## References

Footnote-style source list for the citations made
above. Inline `path:lines` is preferred for one-off references;
this section collects sources that are referenced repeatedly or
that warrant a one-line description.

- `path/to/file.ts:42-58` - what it shows.
- `[[notes/related-topic]]` - sibling note worth reading alongside.
- https://example.com - external doc.

---

## Changelog

*Optional.* Dated bullets when the note is non-trivially revised.
Supports the `updated` frontmatter field; lets a reader spot what's
new since they last looked. Trivial typo fixes don't need entries.

- `YYYY-MM-DD` - <what changed and why>.
