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
