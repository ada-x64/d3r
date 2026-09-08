# Zed

D3R can run as a custom Zed agent through the Agent Client Protocol (ACP). The
`d3r acp` process owns ACP stdio, starts `pi-acp`, and routes each ACP session
back through the D3R binary. D3R then starts Pi with the Pi adapter package
explicitly loaded and D3R mode enabled.

```text
Zed -> d3r acp -> pi-acp -> d3r-pi --mode rpc -> pi --extension <adapter> --d3r
```

## Development setup

Build and expose the workspace CLI on `PATH`:

```sh
pnpm build
cd cli
npm link
```

Confirm that both runtime commands are visible:

```sh
d3r version
pi --version
```

Pi owns model-provider authentication. Run `pi` once in a terminal to configure
or verify the provider before opening a D3R thread in Zed.

Add D3R as a custom agent in Zed's `settings.json`:

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

If Zed cannot find the global package-manager bin directory, use the absolute
path to the `d3r` executable for `command`. Open a new external-agent thread and
select `d3r`. ACP protocol logs are available from Zed's `dev: open acp logs`
command.

## Current boundary

This first ACP adapter intentionally reuses `pi-acp`. It provides Pi's model and
thinking selectors, structured tool calls and edits, session persistence, and
file-based commands. Pi extension commands are not exposed by `pi-acp`, so D3R
starts directly in routing mode instead of relying on Zed to invoke `/d3r`.
Nested D3R agents are currently rendered as the Pi `subagent` tool rather than
first-class ACP child sessions.

## Native server development

`@d3r/adapter-acp/server` exports `connectNativeServer(stream, deps)` as an
experimental library seam. It negotiates ACP v1, creates connection-local
in-memory sessions through an injected runtime factory, streams text and thought
chunks, and propagates cancellation. The returned `closed` promise waits for
active prompts to settle and all runtimes to be disposed after disconnect.

This is not yet a complete ACP agent: it rejects non-empty MCP server lists,
additional workspace roots, and rich prompt blocks rather than silently ignoring
them. Only text and resource-link inputs are currently accepted. The runtime
factory is responsible for resolving resource links and retaining conversation
context; it must honor abort signals and await emitted updates before returning.
Session creation checks absolute paths, not filesystem access or workspace
trust. Those policies must be supplied before a real runtime is exposed to
users.

There is no native CLI switch yet. `d3r acp` and terminal authentication still
use the working proxy. The native tests exercise the protocol over
newline-delimited byte streams with injected fake runtimes; they require neither
Pi nor provider credentials and make no model requests.

### Embedded model runtime

`@d3r/adapter-pi/embedded` exports `createEmbeddedRuntime(options)`, a session
factory accepted by the native server. It embeds `pi-ai` and `pi-agent-core`
(version 0.85.1; Node 22.19+), without the Pi executable, extension loader, or
Pi session files. The caller supplies a model, a model collection, a system
prompt, and optionally a thinking level. Provider registration and credentials
belong to the caller; importing this module does not discover configuration or
log in.

Each session retains completed and token-limited conversation turns in memory.
Failed or cancelled turns are rolled back from the model context, though already
streamed output may remain visible in the client. Text and thought deltas carry
stable IDs per response block. Cancellation must settle before disposal, which
releases only that runtime's provider resources.

This slice exposes no tools and permits only one model turn per prompt.
Unexpected tool requests fail instead of retrying indefinitely. Resource links
require an explicit `resolveResource` callback that enforces access policy,
honors its abort signal, and returns text; there is no automatic filesystem or
network fallback. Authentication UI/storage, tools, compaction, persistence, and
the native CLI switch remain separate work. Legacy Pi peer dependencies remain
for the existing interactive extensions and proxy path.
