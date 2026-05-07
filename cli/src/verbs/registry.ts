import { type CommandDef } from "citty";

/**
 * Single source of truth for the CLI's user-facing verbs.
 *
 * Verbs are split across two homogeneous tables -- `GATED_VERBS`
 * and `GATE_EXEMPT_VERBS` -- so that *which table a row lives in*
 * is the only signal of gate-exempt status. There is no boolean
 * flag and no parallel string list of verb names. Consumers that
 * need the unified set use `ALL_VERBS` (the concatenation done
 * once, here).
 *
 * Each `VerbEntry` carries:
 *
 * - `name`: the verb token as typed on the command line.
 * - `load`: lazy loader for the citty `defineCommand` instance.
 *
 * `cli.ts` builds its `subCommands` map and known-verb set from
 * `ALL_VERBS`; `vault-gate.ts` derives its allow-list from
 * `gateExemptVerbs()`. No verb-name string literal should appear
 * in any other file.
 */
export interface VerbEntry {
	readonly name: string;
	readonly load: () => Promise<CommandDef>;
}

/** Verbs that require a registered vault for the cwd. */
export const GATED_VERBS: readonly VerbEntry[] = [
	{
		name: "tool",
		load: () => import("./tool.ts").then((m) => m.default),
	},
	{
		name: "vault",
		load: () => import("./vault/index.ts").then((m) => m.default),
	},
];

/** Verbs the refuse-to-run gate lets through unconditionally. */
export const GATE_EXEMPT_VERBS: readonly VerbEntry[] = [
	{
		name: "install",
		load: () => import("./install.ts").then((m) => m.default),
	},
	{
		name: "init",
		load: () => import("./init.ts").then((m) => m.default),
	},
	{
		name: "version",
		load: () => import("./version.ts").then((m) => m.default),
	},
];

/** All verbs, gated first then gate-exempt. */
export const ALL_VERBS: readonly VerbEntry[] = [
	...GATED_VERBS,
	...GATE_EXEMPT_VERBS,
];

/** Names of every verb the CLI recognises. */
export const verbNames = (): ReadonlySet<string> =>
	new Set(ALL_VERBS.map((v) => v.name));

/** Names of verbs that bypass the vault gate. */
export const gateExemptVerbs = (): ReadonlySet<string> =>
	new Set(GATE_EXEMPT_VERBS.map((v) => v.name));
