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
- `vault/`: workspace workflow documents and templates.

Built-in role definitions and workflow chains come from the installed core
package, not copied prompt definitions. Workspace agent/skill IDs replace global
IDs. Referenced resources are bounded and validated; executable extensions and
hooks are never loaded. No directory is created just to discover configuration.
Instructions and skill content guide models but are not executable
authorization.

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
events.

The engine executes the declared sequence and parallel batches, requires a
validated `d3r_report` from every role, and never treats ordinary success prose
as a completed step. Review approval or implementor `allDone` can terminate a
loop; loop exhaustion blocks rather than silently skipping to audit. A failed or
malformed report pauses the workflow.

Answer declared human checkpoints normally. Blocked or interrupted workflows
require `abandon` or an explicit `restart`. **Restart reruns the pinned workflow
from its beginning and can repeat effects.** It is not automatic crash recovery.

## Permissions and tools

Before the first model request, approve workspace use for the current session.
Trust is not carried across restoration. File mutations, commands, MCP
connections, and MCP calls require separate approval. Missing, denied, unknown,
or cancelled permission results do not authorize execution.

Native tools include file read/write/edit, directory listing, literal search,
explicit executable-plus-argv commands, skill reads, and configured MCP tools.
Use the snapshot token returned by `read_file` when editing or overwriting an
existing file. Disk writes use staged atomic replacement and preimage checks;
structured diffs show actual old and new content. Negotiated editor reads/writes
include unsaved buffers. Editor protocols do not provide atomic
compare-and-swap, so a concurrent human edit can still race a write.

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
- Portable child work is represented as tool calls and plans, not standardized
  nested ACP sessions. Zed-private child metadata is not required.
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
