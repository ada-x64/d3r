# D3R in Zed

`d3r acp` now runs the native ACP v1 server. It embeds the Pi model and agent
libraries; it does not start the Pi executable or load Pi extensions. The
previous proxy remains available as `d3r acp --legacy`.

## Install from this workspace

Use Node 22.19 or newer on Linux/macOS (or inside WSL):

```sh
pnpm install
pnpm build
npm link --prefix cli
d3r version
```

The installed command is a Node-backed executable, not a standalone compiled
binary. Build before linking. Published packages use compiled JavaScript
exports; workspace development still uses TypeScript source exports.

## Authenticate

D3R owns native credentials separately from Pi and Zed. Existing Pi logins and
Zed-hosted model credentials are **not** automatically imported.

```sh
d3r auth list
d3r auth login github-copilot
d3r auth status
d3r auth logout github-copilot
```

`login` supports provider-offered API-key and OAuth flows. Free-form terminal
input is masked. Authorization URLs and device codes are shown only during
explicit login. Zed can invoke the same flow through its Authenticate action;
`d3r acp --terminal-login` completes login and exits without starting ACP.

Provider-supported environment credentials also work. OAuth support in a library
does not guarantee subscription eligibility or provider permission for a custom
client. Check the provider's terms and account settings.

Native credentials live in `~/.agents/d3r/private/credentials.json`. This is a
**plaintext, permission-protected** store, not an OS keychain. The
implementation checks POSIX ownership/modes, rejects symlinks/hardlinks, and
serializes refresh and updates with a cross-process lock. Never commit or share
this directory.

Native credential storage currently refuses Windows because user-only ACL
verification is not implemented. On Windows, run D3R on the WSL/remote side with
the workspace and credentials in the same environment. Native Windows support is
not claimed.

## Register the agent

Add to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "d3r": {
      "type": "custom",
      "command": "d3r",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

If necessary, use the absolute path to the linked `d3r` executable. For WSL or
remote projects, ensure the agent runs where the session's absolute paths are
valid; launching a Linux binary does not automatically translate Windows paths.
Use `dev: open acp logs` to inspect protocol traffic. Logs and transcripts can
contain project content; treat them as private.

## Models and resources

Select a model first. Zed shows a thought-level selector only when that model
has more than one supported level; there is no universal thinking control for an
unselected or non-reasoning model. Changing models initializes the new model's
supported default (`off` when available, otherwise its lowest supported level),
rather than carrying an incompatible setting across models. Choose a level after
selecting the model. Reselecting the same model preserves its setting; session
reload preserves the saved model/level pair. Explicitly unsupported settings are
rejected, not silently clamped.

Without an explicit default, D3R shows a model-selection prompt.
[Model configuration](./model-config.md) describes global/workspace presets;
`d3r acp --preset careful` selects a named preset. Selection is checked against
the authenticated model catalog. Fixed capability values remain in internal
checkpoint metadata for compatibility, but are not displayed as selectors.

D3R loads inert resources from global `~/.agents/` and workspace `.agents/`:

- `models.json`: model presets and optional default selection.
- `agents.md`: legacy instructions at the supplied home/workspace root.
  `AGENT.md` and `AGENTS.md` are also inherited as described below.
- `system-prompt.md`: additional native system instructions.
- `agents/*.md`, `agents/*.agent.md`, or `agents/<id>/agent.md`: role
  definitions using D3R's `AgentSpec` frontmatter (`name`, `description`,
  `tier`, `capabilities`, optional `tools` and `vault_scope`).
- `skills/**/SKILL.md`: skills exposed through the inert `read_skill` tool.
- `workflow.yaml`: optional workflow command overrides.
- `mcp.json`: optional MCP server configuration.
- `vault/`: workflow documents and templates, discovered as described below.

D3R walks from the session workspace up to the filesystem root for **both
`AGENT.md` and `AGENTS.md`**, crossing repository and vault boundaries. Each
file's path and text are included in the system prompt of the router and every
worker, including the implementor; workers do not need to rediscover ancestor
instructions through tools. Files are ordered broadest to most specific, with
nearer-directory rules taking precedence. When both names exist in one
directory, `AGENTS.md` takes precedence over `AGENT.md`; legacy
`.agents/agents.md` is last and is read only at home and the exact workspace
root. Home instructions are loaded once, as global defaults if home is outside
the workspace ancestry. Sibling and descendant directories are not scanned by
this ancestor lookup.

Only these instruction files are read from ancestors; this does not grant tools
access to parent directories or load their agents, skills, model presets, or MCP
configuration. Missing files are skipped, while unreadable or invalid files
produce errors rather than silently dropping project rules. Existing bounded
text reads, cancellation, and path checks still apply. Instructions are pinned
with the session; restart D3R and start a new thread to pick up newly discovered
or changed files.

Keep the project's concise engineering charter in its `AGENTS.md`, with detailed
standards in linked documents. D3R's own charter lives in this repository's
`AGENTS.md`; it is not imposed on unrelated projects. Core role prompts require
applicable instructions and relevant linked engineering/testing standards,
without duplicating that policy. A self-contained task brief defines scope, not
an exemption from standards. Native sessions reuse the inherited text in every
role; agents read missing relevant sections through their existing tools. Links
are not automatically expanded into the system prompt, and do not grant
additional filesystem access. Implementors run project-required checks even when
a task's verification instructions omit them; reviewers retain their read-only
remit.

D3R also discovers workspace `.github/skills/**/SKILL.md` files. Skills with the
same name resolve in this order (highest priority first):

1. Workspace `.agents/skills/`
2. Workspace `.github/skills/`
3. Global `~/.agents/skills/`

Duplicates within one skill directory tree remain an error. Only skills are
loaded from `.github`, not workflow files, Copilot instructions, or custom agent
definitions. Parent repositories and `~/.github/skills/` are not searched.

This discovery belongs to D3R, not Zed:
[Zed's skills](https://zed.dev/docs/ai/skills#agent-path-boundaries) apply to
the built-in Zed Agent, not external ACP agents. The router and workers with
`read_skill` see the skill catalog and load a skill's body on demand. Resources
are pinned when a D3R session is created, including across reloads; start a new
thread to pick up newly added or changed skills. For WSL sessions, the files
must be visible in the D3R process's WSL workspace/home.

Built-in role definitions and workflow chains come from the installed core
package, not copied prompt definitions. Workspace agent/skill IDs replace global
IDs. Referenced resources are bounded and validated; executable extensions and
hooks are never loaded. No directory is created just to discover configuration.
Instructions and skill content guide models but are not executable
authorization.

Vault discovery walks from the session workspace upward to the filesystem root
and selects the nearest existing `.agents/vault` directory. This supports nested
worktrees whose shared vault lives in the parent repository. Discovery is
bounded and rejects symlinked, malformed, or inaccessible candidates rather than
silently selecting another vault. If none exists, the suggested location remains
`<workspace>/.agents/vault`; discovery does not create it.

Only that vault directory, not its parent repository, is added to tool access
after the workspace trust request explicitly names it. Ancestor instruction
lookup is separate from vault discovery; ancestor skills, models, and MCP
configuration are not loaded by either search. External vault files use disk IO;
workspace editor buffers remain authoritative for explicit reads and edits. The
vault location is pinned per session: if discovery finds a different location on
reload, start a new thread instead of silently redirecting the saved workflow.
This includes older threads that pinned the former worktree-local path when a
shared ancestor vault exists.

## Vault-relative tools

Native sessions expose the vault tools directly; no symlink or shell command is
needed to read a template. Paths use `/` separators and are relative to the
session's discovered, pinned vault, not the worktree:

```text
vault_read({"path": ".misc/templates/remember.md"})
vault_ls({"path": "process/designs"})
vault_find({"glob": ".misc/archive/**/*.md", "query": "approval"})
```

| Tool          | Native behavior                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| `vault_read`  | Read saved text with a full-file snapshot token, or list a directory.                        |
| `vault_ls`    | List immediate children; defaults to the vault root.                                         |
| `vault_find`  | Find files by glob, body substring, and/or frontmatter kind, including `.misc`.              |
| `vault_lint`  | Validate frontmatter for explicit paths or discovered Markdown files.                        |
| `vault_write` | Raw-text or frontmatter/body write with checked parent creation and atomic file publication. |
| `vault_edit`  | Literal replacement with a snapshot and exact match count.                                   |
| `vault_mv`    | Non-overwriting move of a regular text file using its snapshot.                              |
| `vault_rm`    | Removal of a regular text file using its snapshot.                                           |

Role capabilities determine which tools are offered. After initial
workspace/vault trust, **all enabled native vault operations run automatically**
without per-operation approval, including writes, edits, file moves, and file
removals. This skips permission prompts, not the assigned task scope or the
constraints below. Vault tools always use disk IO, even for a vault inside the
workspace. They do not use Zed's unsaved buffers or accept a caller's vault-root
override. Ordinary workspace file tools retain their existing editor behavior.

`vault_read` returns JSON text containing `path`, `text`, `snapshot`, and
`truncated`. Follow `nextOffset` to read subsequent pages: `offset` and `limit`
count Unicode code points, with a maximum/default page size of 8192. Every page
carries the snapshot of the whole file; restart the read if snapshots differ.
Files are capped at 1 MiB. Directory results and scans report incomplete
coverage with `truncated`/`skipped` rather than claiming exhaustive results.

For `vault_write`, `mode: "raw"` uses `contents`; `mode: "doc"` uses `kind`,
optional `frontmatter`, and `body`. Doc mode writes YAML frontmatter without
executing language tags or parsing the body as frontmatter. It does not merge a
template automatically. Existing-file writes, edits, moves, and removals require
the snapshot from `vault_read`. New-file creation can omit it. Reads and edits
use the same pinned root after restoration, with renewed trust.

Native move/remove currently support files only, not directories or recursive
operations. Moves create a private-mode destination then remove the revalidated
source; they do not preserve source metadata and are not an atomic transaction.
If the second step fails, the destination is retained and the result identifies
both paths for manual recovery. Checked empty parents may remain after a later
write failure. Root, traversal, private-store, symlink, and hard-link accesses
remain restricted. Preimage checks do not guarantee atomic compare-and-swap
(CAS) against hostile external file replacement or removal races.

`vault_init` is not an agent tool. Initialization remains an explicit
`d3r vault init` operation; no native vault tool implicitly initializes,
commits, or pushes the vault. Directory archival still requires an explicitly
approved command rather than `vault_mv`.

The native orchestrator receives a fresh, read-only status check of the pinned
vault root every turn. If the vault is **missing**, it is instructed to ask
whether you want to run `d3r vault init --vault-root <pinned root>` before vault
document work. Initialization creates seed files and directories plus the
vault's own Git repository and initial commit; it does not push. It requires
both your explicit direction and ordinary command authorization, using the exact
pinned root. An existing command-scope grant can satisfy command approval, but
never replaces your direction to initialize or disclosure of the initial commit.
The guidance forbids automatic initialization, `mkdir`, or `vault_write` to
create a partial vault. After approved initialization succeeds, the orchestrator
should recheck with `vault_ls` before document phases in that turn; the next
turn refreshes the status.

You can decline or request no vault artifacts and continue inline audits or code
work without a vault. The orchestrator is instructed not to ask repeatedly
unless you change that direction. Unsafe, unreadable, or symlinked paths are
reported as **unavailable**, not missing: inspect access restrictions instead of
initializing, overwriting, or switching vaults. These are model-facing
instructions, not a hard lifecycle gate preventing phase or role invocation
before initialization; ordinary tool permissions and path checks still apply.

## Workflow commands

### New native sessions

Newly initialized native sessions use one persistent orchestrator (the router)
for the continuous conversation. Ordinary messages and slash commands both go to
that router, which receives authoritative workflow state every turn. Discuss or
clarify normally; the router chooses direct tools, a worker role, or a phase to
fit your request. Phase and role work starts through structured workflow tools.
Printing a command is not execution.

The built-in phase shortcuts express intent:

- `/design <topic>`: aggregation/research, a human discussion checkpoint,
  design.
- `/delegate <topic>`: planning and task schemas when requested.
- `/develop <task>`: bounded implementation/review loop and audit.
- `/summarize <task>`: summarization and archival when requested.

**Any configured phase can start independently.** You can go straight to
`develop` with an adequate conversation brief; no earlier phase or formal vault
schema, design, or plan documents are prerequisites. The Phase picker supplies a
**routing preference**, not a required workflow or a tool restriction. The
router prefers it when it fits, but your current request takes precedence: it
can choose a different phase, one worker, direct tools, or simply answer without
asking you to change the picker. `Routing` leaves that choice to the router.
Selecting a phase while idle does not launch it; only a phase-tool call does.
This flexibility does not replace unfinished work or skip an active phase's
checkpoints.

Routine requests such as **"clean up the vault" use vault tools directly** in
the router, even with `Design` selected. They do not need a phase, research
agents, a task topic, or a `semi`/`auto` declaration. The router inspects the
relevant documents and instructions, clarifies unclear cleanup criteria, and
makes scoped changes using file snapshots. Enabled vault operations require no
additional approval after workspace/vault trust. Unrelated cleanup can also run
while a worker is paused without resuming or abandoning that worker. This is
routing guidance, not a deterministic natural-language intent classifier.

The router has these workflow tools:

| Tool                 | Parameters and purpose                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d3r_start_phase`    | A configured `phase`, structured `brief`, optional `mode` (`semi` or `auto`), and optional `topic`; starts only when no unfinished task is retained.                                        |
| `d3r_run_role`       | A `role` from the pinned loaded worker-role enum (excluding `orchestrator`), the same `brief`, and optional `mode` and `topic`; runs exactly one role. Omitted if no workers are available. |
| `d3r_continue_phase` | `instructions` containing the user's checkpoint answer, correction, or explicit resume direction; continues only a pending checkpoint or safely resumable role batch.                       |
| `d3r_abandon_phase`  | A user-directed `reason`; releases the retained unfinished phase or role task when execution is not running. Existing effects remain.                                                       |
| `d3r_phase_status`   | No parameters; reads current state without starting or changing work.                                                                                                                       |

The `brief` contains `goal`, `context`, nonempty `acceptanceCriteria`, and
`constraints` (an empty list by default). The orchestrator builds it from known
conversation facts and approved scope, not invented citations. If facts are
missing, it asks for those facts rather than demanding documents. For `develop`
or a direct `implementor` run, choose `semi` or `auto` explicitly. If `mode` is
omitted, the engine asks; D3R must not silently assume `auto`. Other direct
roles do not require a mode. `semi` pauses between agent batches; `auto` can run
the whole phase without those pauses, while still respecting required human
checkpoints, reviews, and tool approvals.

Core roles follow project guidance within their assigned remits. The native
handoff contract substitutes the conversation brief for document-specific
schema/design/plan requirements when those documents are absent. Roles work in
the current approved workspace and requested scope, without inventing documents,
branches, commits, or approvals. They can review working-tree changes and report
findings inline without a vault artifact unless one was requested. Project
constraints, role remit, mandatory tests, review gates, and approvals still
apply; commits and pushes require explicit user authorization. The workflow
tools themselves do not request separate permission: underlying worker tools
authorize real effects. The router delegates implementation rather than doing
the workers' implementation itself.

### Shared topics and artifact paths

Native orchestrated phase starts and standalone role calls accept an optional
top-level `topic`: a safe lowercase ASCII kebab slug of at most 80 characters,
not a full path. Whitespace, path separators, traversal, and Windows device
names are rejected. When omitted, the runtime generates a readable goal-derived
slug with a short random suffix once per newly accepted task, without another
model request or asking you to invent a name. Omission always creates a fresh
topic, even for the same goal; it does not reuse the most recent topic.

For a later phase or role on the same subject, the orchestrator copies the exact
topic from runtime state into the next call. If you reference an existing topic,
it uses that exact safe slug instead. It omits `topic` for unrelated work.

The runtime supplies one authoritative topic and vault-relative artifact map to
the orchestrator and every worker, including parallel roles and roles restarted
from saved checkpoints. Briefs should refer to these shared defaults rather than
ask each worker to choose a folder or independently name researcher notes:

| Artifact        | Default vault-relative path           |
| --------------- | ------------------------------------- |
| Aggregation     | `process/designs/<topic>/remember.md` |
| Research        | `process/designs/<topic>/research.md` |
| Design          | `process/designs/<topic>/design.md`   |
| Plan            | `process/designs/<topic>/plan.md`     |
| `taskDirectory` | `process/tasks/<topic>`               |

Explicit operator paths take precedence; the plan's explicit child-task names
also take precedence over the default `taskDirectory`. This is shared context,
not filesystem path rewriting: it does not move existing artifacts, assert that
files exist, or grant permission or require anyone to create documents. Inline,
docs-free work remains supported, without changing role capabilities or approval
requirements.

### Standalone role requests

For focused audit, review, research, or other single-role work, ask naturally;
the router chooses `d3r_run_role` rather than starting the full `develop` chain.
For example:

> Audit this worktree. Include uncommitted and untracked changes. Report
> findings here; don't change code or create vault documents.

A direct run uses a synthetic single-role graph, not a configured phase, with no
phase prerequisites or automatic follow-on roles. Loaded role definitions set
its scope. Results are evidence, not phase completion or approval, and do not
advance an existing workflow. Once the role task completes, you can select a
future phase. Direct roles are not added to workflow commands or the Phase
picker.

For standalone audits/reviews, the native handoff lets auditors and reviewers
inspect the current worktree, including dirty tracked and untracked changes in
the requested scope. No PR, commit range, or vault documents are mandatory.
Their remit is read-only inspection and inline findings unless you request a
report file. Existing role capability and permission policies still apply: this
is not sandbox-enforced read-only execution, and approved commands can mutate
the workspace or host.

Role tasks share the report, permission, and checkpoint lifecycle, including
`d3r_continue_phase`, `d3r_phase_status`, and `d3r_abandon_phase` for
clarification, safely resumable cancellation, and abandonment. After rebuilding,
restart the actual `d3r acp` server used by Zed to load the new code. Reloading
an initialized orchestrated session then exposes the direct-role tool; retained
legacy native sessions need a new session instead.

### Checkpoints and corrections

The runtime permits only **one start, role, or continue per user turn**. A task
may run to its next pause or completion, but the router cannot start it and then
answer its new human checkpoint in that same turn. Waiting, blocked, or
interrupted results must return a question or recovery guidance to you, not
trigger an automatic answer, retry, or abandonment.

A role's valid `needs_human` report presents its question and retains its
conversation checkpoint. Clean cancellation can also retain checkpoints after
started tools and role cleanup settle. Your answer, correction, or explicit
continue resumes only the unfinished roles when all required child checkpoints
are available. Completed parallel siblings and their outcomes remain retained;
prior commands and mutations are not automatically replayed. Resumed roles must
inspect current state before further effects and report again.

This is **not a blanket failure retry**. Unknown-write outcomes, failed effect
settlement or checkpointing, and missing required child checkpoints fail closed;
D3R cannot safely resume by recreating a role without its retained evidence.
Inspect the workspace and discuss recovery instead of assuming every blocked or
interrupted run supports continuation.

Running or unresolved phase/role tasks cannot be replaced. To switch away from a
retained unfinished task, explicitly ask to abandon it when execution is not
running, then start the desired phase or role. A user-directed abandon can
precede the next operation in the same turn; it does not consume the
start/role/continue allowance. It cannot follow that operation to bypass a new
pause. **Abandoning retains all existing effects; it is not rollback.** Starting
again is a fresh run and can repeat effects, not a continuation or a safe
automatic recovery procedure.

For example:

1. Send: "Implement search cancellation directly in develop using semi mode.
   Search currently keeps running after cancellation. Acceptance: cancellation
   stops the search and regression tests pass. Keep the public API; no new
   dependencies, commits, or vault documents."
2. At a human checkpoint or reported question, answer: "Keep the existing
   cancellation error type. Continue with that correction."
3. For a correction while work is running, use **Send Immediately** with "Keep
   the current edits, but change only the search worker; continue with that
   narrower scope." This cancels and waits before submitting the correction;
   safe continuation still depends on retained checkpoints. See
   [Sending corrections in Zed](#sending-corrections-in-zed).

### Role execution and results

Routing context is handed to children, and workflow outcomes return to the
routing conversation. Plans and named role calls appear as structured ACP
events. Each role's streamed response and separately labeled thoughts appear
inside its role tool card, not in the coordinator's chat stream. Parallel roles
keep separate message blocks. Tool, permission, terminal, and file operations
continue to use the root session independently.

Role cards retain their final status and structured outcome alongside the
transcript, including after reload. Live transcript snapshots are coalesced
while output is pending; replay retains only the latest grouped snapshot per
role per turn. Display transcripts are limited to 65,536 characters and 128
text/thought blocks per role, with an explicit truncation marker. These limits
do not truncate structured outcomes or model context. Cancellation/disconnect
stops further snapshot sends and retains accepted buffered text in the settled
checkpoint when checkpointing succeeds.

Every role, including a standalone run, must submit a validated `d3r_report`;
ordinary success prose is not a completed step. For configured phases, the
engine executes the declared sequence and parallel batches and governs role
progression, reviews, and checkpoints; implementor `allDone` is not a shortcut
around required review. Loop exhaustion blocks rather than silently skipping to
audit. A failed or malformed report pauses the workflow.

For new native sessions, the **same persistent router** synthesizes
workflow-tool results into one concise Markdown response: the outcome, relevant
evidence, and any question or next step. There is no separate summary
worker/request path. Structured reports remain internal handoff/checkpoint data,
not JSON to dump into chat. The router also handles discussion between phases
without launching implementation or another phase implicitly.

### Legacy initialized native sessions

An older, already-initialized native checkpoint without the `orchestrated` flag
keeps the legacy deterministic/slash-command workflow dispatch and separate
summary behavior below. Reloading or upgrading does not convert that initialized
session; start a new session for persistent orchestration and `d3r_run_role`.
This compatibility path is distinct from the Pi proxy selected by
`d3r acp --legacy`. These older checkpoints still receive the current native
tool permission policy, including automatic implementor edits, enabled vault
operations, and thread-scoped approvals. No checkpoint version migration is
needed for this policy; the legacy workflow behavior remains unchanged.

In these legacy native sessions, ordinary routing conversation clarifies work
separately from phase execution. A recognized slash command starts its phase, or
the Phase selector chooses a phase for the next prompt to start.

After the entire workflow completes, legacy native sessions make one additional,
tool-free model request using the selected model to synthesize the original
brief, role outcomes, prior context, and human checkpoint answers. It returns
one concise Markdown summary of what happened, why, and the next steps, with
known artifact links and unresolved questions where relevant. This is not a
role-by-role report dump, a new worker, or a new research pass.

Legacy summary text is buffered until complete; partial text and thoughts are
not streamed into the parent chat. The cached summary is replayed on load and
passed to later routing context without another model request. Checkpoints and
blocked workflows do not trigger final synthesis. If synthesis fails or returns
unusable text such as raw report JSON, a short Markdown fallback preserves
completion and points to reviewing the results. Cancelling synthesis never
restarts completed work or fabricates a successful summary. Detailed role
transcripts remain in their cards; old checkpoints without a cached summary are
still supported.

Answer declared human checkpoints normally. In this legacy path, blocked or
interrupted workflows, including reported role questions, require `abandon` or
an explicit `restart`, not the new role-continuation tools. **Restart is a
potentially destructive full rerun: it reruns the pinned workflow from its
beginning and can repeat previously completed effects.** It does not undo those
effects and is not automatic crash recovery. An interrupted routing turn also
requires `abandon` or `restart`; restarting repeats its original prompt and can
duplicate effects.

A new slash command does not replace a legacy active workflow or interrupted
routing turn. D3R explains the current block in the conversation instead of
reporting an internal error. To start with a revised prompt, send `abandon`,
then resend the slash command with your new instructions. Abandoning does not
undo prior effects.

## Sending corrections in Zed

The client behavior here is pinned to Zed main
[`5a773a406e499a3314ff0ab9b145c63e8489da0e`](https://github.com/zed-industries/zed/commit/5a773a406e499a3314ff0ab9b145c63e8489da0e).
It is Zed's client-side behavior, not a D3R server queue or a promise that
queued messages survive reconnect or reload.

- **Send** while an ACP prompt is running queues messages client-side in FIFO
  order. Zed submits them after the current ACP prompt completes, not between
  worker tool calls. In `auto`, that prompt may finish the entire phase before a
  queued correction arrives; use `semi` for regular checkpoints.
- **Send Immediately** cancels the current prompt, waits for it to finish, then
  submits the correction as a new prompt. Default shortcuts are
  `Ctrl+Shift+Enter` on Windows/Linux and `Cmd+Shift+Enter` on macOS. This is
  cancel-and-continue, not an instruction injected into a still-running worker.
- **Stop** cancels the active prompt and pauses the client queue. D3R aborts and
  waits for started runtime/tool work and cleanup to settle before returning
  `cancelled`. Uncertain writes or failed checkpointing require recovery rather
  than being reported as a clean cancellation.

True live **Steer** is available for Zed's native agent, not exposed to external
ACP agents such as D3R. A new correction can resume retained unfinished roles as
described above, but neither Send nor Send Immediately guarantees continuation
when a safe child checkpoint is unavailable. Older initialized native sessions
still use the legacy abandon/restart behavior.

## Request budgets and extensions

Each routing prompt and each dispatched role starts with **50 model requests**,
with a default hard cap of **100** for that invocation. This counts provider
requests, not individual tool calls or tokens; final synthesis also consumes a
request. The model receives its current count, allowance, remaining requests,
and hard cap before each request, with a warning when five or fewer remain.
These reminders are not stored as conversation messages.

A role can ask for more through a tool call before its allowance is exhausted:

```text
d3r_request_extension({"reason": "Finish retrieving sources and save the research report", "additionalRequests": 50})
```

The permission request names the role and proposed allowance. Only approval
increases that invocation's limit; it does not affect siblings, later prompts,
file permissions, or the hard cap. `additionalRequests` accepts 1-50 and
defaults to the smaller of 50 and available headroom. Duplicate requests are
suppressed; a denial or failed/cancelled approval cannot increase the limit and
must not be retried in the same invocation.

Every displayed extension approval also offers **Allow identical requests for
`<title>` for this thread**, using the exact-request identity described under
[Permissions and tools](#permissions-and-tools), not a broad budget grant. A
later invocation starts with its own initial allowance and must still call
`d3r_request_extension`; only an explicitly selected, exactly matching thread
grant can satisfy that approval without another prompt. Changes to the request's
reason, role/title, amount, or limits need new approval. No budget is inherited,
and the hard cap is unchanged.

Request the extension early enough to save and report if it is denied. The
requesting response itself counts, and there is no hidden extra allowance for a
final response after `d3r_report`. Hitting the limit still stops unfinished
work; it does not automatically resume a disposed role or rerun earlier effects.

## Built-in web research

Roles with the `web` capability, including the researcher, receive `web_search`
and `web_fetch` directly. The native runtime directs them to these tools instead
of curl or inspecting environment credentials, without changing the underlying
role definitions.

```text
web_search({"query": "ACP tool approval behavior", "k": 5})
web_fetch({"urls": ["https://agentclientprotocol.com/"]})
```

Configure `EXA_API_KEY` in the D3R host process environment; Exa is the default
and currently supported `D3R_WEB_SEARCH_PROVIDER`. These credentials are
separate from model-provider authentication. Missing or invalid configuration
produces a safe tool error without a network request, rather than requiring a
shell workaround. Credentials are not model arguments and are redacted from
retained tool output.

Both operations contact the fixed Exa service: searches send queries, and
fetches send the requested URLs for extracted text. They may incur Exa charges.
D3R does not fetch the supplied URLs directly; it rejects non-HTTP(S), userinfo,
and recognized credential-bearing URLs. Network requests have a 30-second
deadline, redirects are rejected, response bodies are bounded at 1 MiB, and
displayed output is capped at 64 KiB with `[Output truncated]` when needed.
Truncated text is not guaranteed to remain parseable JSON; use smaller
result/page batches.

The first request offers **Allow once**, **Reject**, and **Allow web searches
via Exa for this thread** or **Allow web fetches via Exa for this thread**.
Search and fetch grants are separate. A thread grant covers subsequent calls of
that kind across roles, including queued concurrent calls, without another
approval. A fetch grant is not a domain allowlist; it covers all URLs accepted
by that tool. It never authorizes commands, file/vault mutations, MCP calls, or
request-budget extensions.

These grants follow the shared thread-only lifecycle described under
[Permissions and tools](#permissions-and-tools).

## Permissions and tools

Before the first model request, approve workspace use and any discovered
external vault for the current session. Trust is not carried across restoration.
After that initial trust:

- The `implementor` role's enabled `write_file` and `edit_file` run
  automatically, without per-call approval.
- All enabled native vault tools run automatically for every role, including
  writes, edits, file moves, and file removals.
- Other roles' workspace writes/edits, the router's workspace writes/edits,
  commands, MCP connections, and MCP calls still require authorization, unless
  their displayed scope has already been granted for this thread.

Skipping asks by default or remembering a grant does not expand role
capabilities, task scope, or user intent. Read-only audit/review remits and
requests for no code changes or vault artifacts still apply; commits and pushes
still need explicit user direction. Path, snapshot, private-store, symlink, and
CAS constraints are unchanged.

**Every displayed ACP permission card** offers **Allow once**, **Reject**, and
**Allow `<scope>` for this thread** (`optionId: "allow_scope"`,
`kind: "allow_always"`). This is the "always" option for the current thread, not
permanent approval for all future workspaces. Automatic operations and requests
covered by an existing grant do not display another approval card.

Native setup and tool definitions supply these explicit scopes, not model
arguments:

- **workspace file writes and edits**: both `write_file` and `edit_file` where
  approval is still required.
- **all command executions (not sandboxed)**: all `run_command` calls, not just
  the displayed executable or arguments. This broad scope is opt-in, not a
  safe-command allowlist.
- **this MCP connection configuration**: a setup grant keyed by a per-root HMAC
  over the complete materialized actual server configuration and `cwd`, before
  display redaction, not an exact match of the redacted summary. Changes to the
  URL (including path/query), header values, executable/argv, effective
  environment, or `cwd` require fresh approval on setup retry, even if the
  displayed card looks identical. Neither raw credentials nor the HMAC digest is
  displayed. This setup grant does not authorize tool calls.
- **calls to MCP tool `<name>`**: a separate grant for one tool in the live
  connection's catalog, not other tools, servers, or connection approvals.
- **web searches via Exa** and **web fetches via Exa**: separate scopes, as
  described above.

Other requests without an explicit scope, including workspace trust and budget
extensions, use **identical requests for `<title>`**. Matching uses the
original, unredacted `title`, `kind`, and `input`, before display redaction or
shortening; `toolCallId` is excluded and object property order does not matter.
Changing any of those values, including any input value, requires new approval
even if the redacted cards look identical. Unsafe inputs are denied before
displaying a card; without a valid explicit scope, inputs that cannot be
identified losslessly also fail closed.

Explicitly selected thread grants are shared across roles and queued concurrent
calls in the same live root ACP session. They are never persisted and reset on
close, load/resume, or reconnect; another thread or workspace never inherits
them. At most 1024 grants are retained, with the oldest evicted when full. There
is no global or permanent "allow all". **Allow once** and **Reject** apply only
to that call, not other queued calls; late responses after cancellation cannot
create stale grants. Missing, denied, unknown, or cancelled permission results
do not authorize execution.

Command approvals use a terminal-style preview, such as `bash foo bar baz`,
without warning paragraphs or JSON argument dumps. Spaces, empty arguments, and
shell metacharacters are quoted; nonprinting characters use visible Bash-style
escapes. A compact `# cwd: ...` line identifies the runtime-normalized directory
when supplied; unnormalized activity uses `# requested cwd: ...` instead. The
title may shorten a long command, but the detail retains every argument and
masks recognized credentials. This formatting is display-only: execution still
uses the original executable, argv, cwd, and timeout, including any
platform/client launch wrappers.

Command working directories are separate from the vault location. Omit `cwd` to
use the session workspace; do not infer a workspace from the vault's parent.
Directory preflight failures report that no process started, so the agent can
correct the input and retry rather than treating the error as disabled command
permissions. Generic tool failures are not blanket retry prohibitions: inspect
current state before repeating changes with uncertain results, and honor actual
permission denials.

A paused workflow does not disable the router's command tool. Explicitly
requested operational work, such as checking ports or restarting a local review
server, can be handled directly without abandoning or advancing a reviewer task.
Workflow checkpoint and incomplete-journal protections still govern workflow
resumption, not every diagnostic command.

An approval-gated tool waits for its permission response before executing. This
does not freeze the whole session: independent parallel workflow roles may
continue while another role awaits approval, and already-streamed text may
remain visible. Reject denies that call, not the entire turn; use cancellation
to stop the active turn. Read-only tools run under workspace trust without a
separate permission prompt for each call.

If no model is selected or setup permission is not granted, D3R replies with
setup guidance and ends the turn normally, without contacting a model or
connecting to MCP. Select a model or retry with the required approvals in the
same thread. These setup checks are not model safety refusals. Older binaries
reported them as ACP `refusal`, which made Zed show a misleading content-policy
warning; rebuild and restart the agent connection if you still see that warning
instead of setup guidance.

Native tools include file read/write/edit, directory listing, literal search,
explicit executable-plus-argv commands, skill reads, built-in web research, and
configured MCP tools. Use the snapshot token returned by `read_file` when
editing or overwriting an existing file. Disk writes use staged atomic
replacement and preimage checks; structured diffs show actual old and new
content. Negotiated editor reads/writes include unsaved buffers. Editor
protocols do not provide atomic compare-and-swap, so a concurrent human edit can
still race a write.

Search scans saved disk contents without opening each candidate through the
editor. Results retain file paths and line numbers in their text, but are not
emitted as bulk follow-agent locations. Search therefore does not include
unsaved editor changes; explicitly reading a chosen file still uses its editor
buffer and provides a deliberate follow location.

Direct filesystem tools are limited to the session roots. Auth, credential,
secret, token, and key implementation code is ordinary source: these words in
file or directory names do not exclude it from reads, listings, searches, or
permitted edits. Known private storage paths (including `.agents/d3r/private`
and the configured native state directory), environment/key files, repository
metadata, and symlink escapes remain excluded. Do not store live credentials in
ordinary source or configuration files. Additional roots must be supplied again
on load/resume. These checks are **not an OS sandbox**. POSIX `700` directories
and `600` credential files protect against other users, not an agent running
under the same user account. An authorized command, including one covered by a
thread grant, can run arbitrary host code and access the network and files
outside direct filesystem roots. MCP processes likewise run with the agent's
privileges. Connection prompts identify the executable, nonsecret
arguments/environment, and provenance. POSIX process-group cleanup stops
ordinary descendants, not intentionally daemonized processes.

## MCP

Session-supplied servers override matching global/workspace names. Stdio and
streamable HTTP are supported; deprecated SSE is not advertised. Connections are
lazy and approval-gated. HTTP redirects are rejected rather than forwarding
credentials to a different endpoint. Tool inputs are validated against each
server's original JSON Schema; tool hints never grant permission.

Example `.agents/mcp.json`:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": {
        "SERVICE_TOKEN": { "env": "SERVICE_TOKEN" }
      }
    }
  }
}
```

Use environment references for credentials; never put literal keys, auth
headers, or credential-bearing URLs in tracked configuration. Resolved
credential values are registered for transcript/checkpoint redaction. Redaction
is a backstop, not permission to deliberately send secrets through prompts or
tools.

## Failure reports

Model failures retain a safe explanation through the runtime and workflow layers
instead of becoming only "Role setup or execution failed". Reports identify the
failing role, configured provider/model, and an HTTP status or recognized error
code when available. They distinguish authentication, access, rate limits,
quota, invalid request settings, unavailable models, context limits,
network/timeouts, and provider service errors. Specific tool-schema or thinking
option advice is included only when supported by the diagnostic evidence.

Raw provider messages, response bodies, headers, stack traces, credentials, and
private paths are not copied into the report. Unknown failures explicitly say
safe details are unavailable rather than guessing at a cause. Previously
discarded diagnostics cannot be recovered from old threads.

"No tool execution started in this invocation" refers only to the failing
runtime invocation, not all earlier workflow work. If tools already started, the
report warns that their effects may remain; it does not automatically retry,
roll back, switch models, or change permissions. Safe reports remain in role
history after reload. For ordinary routing failures, ACP error data also
contains the validated failure classification, while the message is prose.

Finalization errors are sanitized too. A metadata-publication failure cannot
replace a useful primary failure when checkpointing succeeds. Failed or
uncertain effect settlement/checkpointing takes precedence and requires
recovery; it cannot be hidden by a normal cancellation result.

## Persistence and cancellation

Session history supports list, load (replay), resume (without replay), close,
and delete. Native state lives under `~/.agents/d3r/private/sessions/`. It
includes pinned instructions/workflows and conversation checkpoints, not MCP
launch configuration or saved permission grants. New orchestrated sessions also
retain eligible unfinished-role checkpoints for reported questions and clean
cancellation. Snapshots restore state without executing historical tools;
resuming work requires a new user-directed workflow action and all required
child checkpoints.

An accepted task's topic is immutable through continuation, corrections, and
reload; continue, abandon, and status do not accept a replacement topic. After
completion or abandonment, it remains in runtime state as the most recent topic
for explicit reuse in follow-on work. Older active snapshots without a topic
remain without one: their original artifact names and paths are preserved, with
no automatic topic generation or migration on reload or continuation.

An intent is persisted before a prompt or state mutation. An incomplete intent
cannot silently fall back to an older checkpoint after a crash. Already-issued
editor writes remain owned until their outcome is known; cancellation cannot
certify a still-pending write as completed. Ordinary cancellation waits for
started backend/tool work and cleanup before acknowledging completion. A failed
or missing required child checkpoint does not authorize a fresh role replay;
unknown-write and checkpoint failures fail closed. A clean cancellation with
complete retained checkpoints is different from this recovery-required state.

New session locks record their owning process in private claims inside a
`<session-id>.lock` directory. On trusted local filesystems, loading a session
reclaims claims only when their owners are provably gone. Linux/WSL checks boot
identity, PID namespace visibility, and process start ticks to handle reboot and
PID reuse. There is no age-based expiry: a slow or idle live owner keeps its
lease. Unknown or foreign ownership requires manual inspection, not takeover.
Empty `.lock` directories are normal reusable registries and do not block
resume.

EOF, stream errors, or a closed output pipe initiate cancellation and wait for
started work and cleanup before releasing ownership. If a Windows/WSL bridge
keeps the old D3R process and its pipes alive, automatic takeover is unsafe;
close that agent connection or stop the old process before retrying. The lock
error identifies a live owner by PID when verifiable.

Older empty `.lock` **files** contain no owner information and still need a
one-time manual cleanup after confirming the previous D3R process has stopped.
Use the current D3R version to read the new directory-based locks. Recovering a
lock does not recover an incomplete mutation: those sessions remain refused
rather than automatically replayed or rolled back to an older checkpoint.
Inspect the workspace before repeating work, and keep a backup before manually
editing persisted state.

Text-only failed/cancelled model turns roll back their model context. Once a
tool starts, its results and effects are retained conservatively. Already
displayed partial text may remain visible even when absent from subsequent model
context.

## Compatibility boundaries

- Native state is independent of Pi session files. The legacy proxy still uses
  Pi's original credentials and session format.
- Portable child work is represented as ordinary tool content and plans, not
  nested ACP sessions. Zed main `52b2927a` has no live external subagent-spawn
  contract. D3R emits no private spawn metadata, unknown session notifications,
  or child-session API calls, and does not infer support from capabilities.
- Images and embedded text context are supported; audio is not advertised.
- Configuration changes are accepted while idle, not in the middle of a turn.
- Form elicitation is available when the client supports it; secrets always use
  terminal/provider authentication, never a form.
- Token/context/cost events use provider-reported values. Billing estimates are
  not provider invoices.
- Automatic context compaction, native OS-keychain storage, ACP v2, a native
  terminal frontend, and ACP Registry publication remain follow-up work.

For the previous integration, use `args: ["acp", "--legacy"]` in Zed. The legacy
path still requires the Pi executable and `d3r-pi` on `PATH`.
