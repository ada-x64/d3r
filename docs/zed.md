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

Select a model and thought level with Zed's selectors. Without an explicit
default, D3R shows a selection prompt rather than silently choosing a model.
[Model configuration](./model-config.md) describes global/workspace presets;
`d3r acp --preset careful` selects a named preset. Selection is checked against
the authenticated model catalog, including supported thought levels.

D3R loads inert resources from global `~/.agents/` and workspace `.agents/`:

- `models.json`: model presets and optional default selection.
- `agents.md`, plus `AGENTS.md` at the supplied root: instructions.
- `system-prompt.md`: additional native system instructions.
- `agents/*.md`, `agents/*.agent.md`, or `agents/<id>/agent.md`: role
  definitions using D3R's `AgentSpec` frontmatter (`name`, `description`,
  `tier`, `capabilities`, optional `tools` and `vault_scope`).
- `skills/**/SKILL.md`: skills exposed through the inert `read_skill` tool.
- `workflow.yaml`: optional workflow command overrides.
- `mcp.json`: optional MCP server configuration.
- `vault/`: workflow documents and templates, discovered as described below.

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
after the workspace trust request explicitly names it. Ancestor instructions,
skills, models, and MCP configuration are not loaded by this search. External
vault files use disk IO; workspace editor buffers remain authoritative for
explicit reads and edits. The vault location is pinned per session: if discovery
finds a different location on reload, start a new thread instead of silently
redirecting the saved workflow. This includes older threads that pinned the
former worktree-local path when a shared ancestor vault exists.

## Vault-relative tools

Native sessions expose the vault tools directly; no symlink or shell command is
needed to read a template. Paths use `/` separators and are relative to the
session's discovered, pinned vault, not the worktree:

```text
vault_read({"path": ".misc/templates/remember.md"})
vault_ls({"path": "process/designs"})
vault_find({"glob": ".misc/archive/**/*.md", "query": "approval"})
```

| Tool          | Native behavior                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `vault_read`  | Read saved text with a full-file snapshot token, or list a directory.                                 |
| `vault_ls`    | List immediate children; defaults to the vault root.                                                  |
| `vault_find`  | Find files by glob, body substring, and/or frontmatter kind, including `.misc`.                       |
| `vault_lint`  | Validate frontmatter for explicit paths or discovered Markdown files.                                 |
| `vault_write` | Approved raw-text or frontmatter/body write with checked parent creation and atomic file publication. |
| `vault_edit`  | Approved literal replacement with a snapshot and exact match count.                                   |
| `vault_mv`    | Approved, non-overwriting move of a regular text file using its snapshot.                             |
| `vault_rm`    | Approved removal of a regular text file using its snapshot.                                           |

Role capabilities determine which tools are offered. Reads, listings, search,
and lint run under workspace/vault trust; writes, edits, moves, and removals
require separate approval. Vault tools always use disk IO, even for a vault
inside the workspace. They do not use Zed's unsaved buffers or accept a caller's
vault-root override. Ordinary workspace file tools retain their existing editor
behavior.

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
remain restricted.

`vault_init` is not an agent tool. Initialization remains an explicit
`d3r vault init` operation; no native vault tool implicitly initializes,
commits, or pushes the vault. Directory archival still requires an explicitly
approved command rather than `vault_mv`.

## Workflow commands

- `/design <topic>`: aggregation/research, a human discussion checkpoint,
  design.
- `/delegate <topic>`: planning and task schemas.
- `/develop <task>`: bounded implementation/review loop and audit. D3R asks for
  `semi` or `auto`; `semi` pauses between agent batches.
- `/summarize <task>`: summarization and archival.

The Phase selector can choose a command without running it; the next prompt
starts it. Ordinary routing conversation helps clarify work and select a phase.
Routing context is handed to children, and workflow outcomes are returned to the
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

The engine executes the declared sequence and parallel batches, requires a
validated `d3r_report` from every role, and never treats ordinary success prose
as a completed step. Review approval or implementor `allDone` can terminate a
loop; loop exhaustion blocks rather than silently skipping to audit. A failed or
malformed report pauses the workflow.

Answer declared human checkpoints normally. Blocked or interrupted workflows
require `abandon` or an explicit `restart`. **Restart reruns the pinned workflow
from its beginning and can repeat effects.** It is not automatic crash recovery.

A new slash command does not replace an active workflow or interrupted routing
turn. D3R explains the current block in the conversation instead of reporting an
internal error. To start with a revised prompt, send `abandon`, then resend the
slash command with your new instructions. Abandoning does not undo prior
effects.

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
must not be retried in the same invocation. Extensions never have a
remembered-approval option.

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

Grants live only in the open session and are not written to checkpoints.
Closing, reloading, reconnecting, or starting another thread requires fresh
permission. An **Allow once** decision is not shared with other queued calls,
and late responses after cancellation cannot create a remembered grant.

## Permissions and tools

Before the first model request, approve workspace use for the current session.
Trust is not carried across restoration. File mutations, commands, MCP
connections, and MCP calls require separate approval. Missing, denied, unknown,
or cancelled permission results do not authorize execution.

Command approvals use a terminal-style preview, such as `bash foo bar baz`,
without warning paragraphs or JSON argument dumps. Spaces, empty arguments, and
shell metacharacters are quoted; nonprinting characters use visible Bash-style
escapes. A compact `# cwd: ...` line identifies the runtime-normalized directory
when supplied; unnormalized activity uses `# requested cwd: ...` instead. The
title may shorten a long command, but the detail retains every argument and
masks recognized credentials. This formatting is display-only: execution still
uses the original executable, argv, cwd, and timeout, including any
platform/client launch wrappers. Commands still offer only **Allow once** and
**Reject**. Remembered approvals are limited to explicit built-in web scopes, as
described above.

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

Direct filesystem tools are limited to the session roots and reject sensitive
paths and symlink escapes. Additional roots must be supplied again on
load/resume. These checks are **not an OS sandbox**. An approved command or MCP
process can access the host with the agent's privileges. Connection prompts
identify the executable, nonsecret arguments/environment, and provenance. POSIX
process-group cleanup stops ordinary descendants, not intentionally daemonized
processes.

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

## Persistence and cancellation

Session history supports list, load (replay), resume (without replay), close,
and delete. Native state lives under `~/.agents/d3r/private/sessions/`. It
includes pinned instructions/workflows and conversation checkpoints, not MCP
launch configuration or saved permission grants. Snapshots restore state without
executing historical tools.

An intent is persisted before a prompt or state mutation. An incomplete intent
cannot silently fall back to an older checkpoint after a crash. Already-issued
editor writes remain owned until their outcome is known; cancellation cannot
certify a still-pending write as completed. Ordinary cancellation waits for
started backend/tool work and cleanup before acknowledging completion.

A crash can leave a stale session lock. Confirm no D3R process owns the session
before manually removing its lock. Incomplete sessions are refused rather than
automatically replayed; start a new session and inspect the workspace. Keep a
backup before manually editing persisted state.

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
