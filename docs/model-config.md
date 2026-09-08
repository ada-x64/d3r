# Model configuration

D3R's native runtime configuration is being built around `.agents/`, with
portable model selection kept separate from provider credentials. This document
describes the **D3R version 1 profile** of `models.json`, not a claim that all
editors or the draft .agents Protocol use the same file schema.

The current change supplies parsing and loading APIs only. The working `d3r acp`
launcher still uses the Pi proxy; it does not read these files yet.

## File format

Global defaults live at `~/.agents/models.json`. Workspace overrides live at
`<workspace>/.agents/models.json`:

```json
{
  "version": 1,
  "defaultPreset": "careful",
  "presets": [
    {
      "id": "careful",
      "provider": "openai",
      "model": "gpt-4o",
      "thinkingLevel": "off"
    }
  ]
}
```

- `version` is required and must be `1`.
- `presets` is optional and defaults to an empty array.
- Each preset requires `id`, `provider`, and `model`. Identifiers are trimmed
  and must be non-empty; duplicate IDs in one file are errors.
- `thinkingLevel` is optional: `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, or `max`. The runtime must still validate support against the
  selected model.
- `defaultPreset` is optional. A string selects an effective preset ID; `null`
  explicitly clears an inherited selection. Without a selection, the loader does
  not silently choose the first preset or a provider default.

This is selection metadata, not a live model catalog. The loader does not verify
provider availability, credentials, or model capabilities, and makes no network
requests. Custom endpoints and arbitrary provider options are not supported by
this initial profile.

## Overlay rules

1. Load the global layer, then the workspace layer.
2. Later presets replace earlier presets with the same ID **in full**. Omitted
   fields in a replacement do not inherit values from the previous preset.
3. First-seen IDs retain their display position. New workspace IDs append in
   workspace declaration order.
4. An omitted `defaultPreset` inherits the previous value. A string replaces it;
   `null` clears it. The final non-null ID must exist in the combined presets.
5. An empty `presets` array adds nothing; it does not delete inherited presets.
   Per-preset removal/disable semantics are not part of this version.

For example, a workspace can select a global preset without redeclaring it:

```json
{
  "version": 1,
  "defaultPreset": "careful"
}
```

## Discovery and failures

`@d3r/cli/model-config` exports `loadModelConfig({ home, cwd })`. Both roots
must be absolute and are supplied by the composition root. The loader checks
only `.agents/models.json` under those roots, not ancestor directories, Pi
settings, or the process working directory. The caller must identify the
intended workspace root before calling it. Equal home/workspace paths are loaded
once.

Missing files are optional. A malformed or unreadable file is an error, even if
the other layer is valid. Successful results include the parsed source paths in
global/workspace order. Errors identify the affected path or missing preset;
they do not include raw file contents or parser exception messages. Discovery
never creates directories, repairs files, or writes settings.

`@d3r/core/model-config` owns the strict Zod schemas and pure
`resolveModelConfig(layers)` overlay function. No filesystem or provider
behavior belongs in that core module.

## Credentials and trust

Unknown fields are rejected at both the root and preset level, including inline
API keys, tokens, and authorization headers. Do not put credentials in
version-controlled `.agents/` files. Credential storage and login will be
handled separately; there is no automatic import of Pi credentials here.

Loading model metadata is **not** a workspace trust decision or authorization to
use a provider. Before native startup uses these selections, the composition
layer must enforce its provider, authentication, and workspace policies. Shared
`.agents/` conventions do not make their contents trusted automatically.
