// Per-tool, per-field overrides for string parameters that should be
// emitted as a JSON-Schema string enum instead of a free-form string.
//
// The bridge in `zod-to-typebox.ts` already converts native `z.enum(...)`
// to `StringEnum(...)` automatically; this table covers the rarer case
// where a tool authored its parameter as a plain `z.string()` but, by
// convention or downstream contract, should be constrained to a fixed
// value list. Google-family models reject `anyOf`/`const` shapes, so a
// single canonical `{ type: "string", enum: [...] }` is the only
// portable encoding.
//
// Keys are tool names (matching `ToolEntry.name`), then field names on
// the top-level params object.

export const STRING_ENUM_HINTS: Record<
	string,
	Record<string, readonly string[]>
> = {
	vault_write: {
		mode: ["doc", "raw"] as const,
	},
};
