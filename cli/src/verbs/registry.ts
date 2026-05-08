import { type CommandDef } from "citty";

/**
 * Single source of truth for the CLI's user-facing verbs.
 *
 * Each verb is responsible for any preconditions it needs (e.g.
 * calling `requireRegisteredVault` from `vault-gate.ts` before
 * touching the vault). There is no name-based allow-list and no
 * parallel "gated" / "exempt" partition: the list below is the whole
 * surface, and gate-or-not is a property of the verb's own `run`
 * handler. New verbs cannot silently miss the gate by being added to
 * the wrong table -- there is only one table.
 *
 * Each `VerbEntry` carries:
 *
 * - `name`: the verb token as typed on the command line.
 * - `load`: lazy loader for the citty `defineCommand` instance.
 */
export interface VerbEntry {
	readonly name: string;
	readonly load: () => Promise<CommandDef>;
}

/** Every verb the CLI exposes, in declaration order. */
export const ALL_VERBS: readonly VerbEntry[] = [
	{
		name: "install",
		load: () => import("./install.ts").then((m) => m.default),
	},
	{
		name: "tool",
		load: () => import("./tool.ts").then((m) => m.default),
	},
	{
		name: "vault",
		load: () => import("./vault/index.ts").then((m) => m.default),
	},
	{
		name: "version",
		load: () => import("./version.ts").then((m) => m.default),
	},
];

/** Names of every verb the CLI recognises. */
export const verbNames = (): ReadonlySet<string> =>
	new Set(ALL_VERBS.map((v) => v.name));
