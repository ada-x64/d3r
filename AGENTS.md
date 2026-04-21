This is d3r - a build system for D3R agent harness configurations.

See `CONTRIBUTING.md` for architecture, build, install, and conventions.

Repo-dir-root context (topology, vault location, workflow pointer) lives
in `../AGENTS.md` (untracked).

## Git identity

Do not pass `-c user.name=...` or `-c user.email=...` to `git`, and do
not set `GIT_AUTHOR_*` / `GIT_COMMITTER_*` in your environment. Use
the ambient identity from the user's git config. Do not invent a
"bot" or "agent" persona (e.g. `Ada <ada@d3r.local>`) -- if commits
need to be tagged as agent-authored, the user will configure that
themselves.
