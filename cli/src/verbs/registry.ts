import type { CommandDef } from "citty";

/**
 * Single source of truth for the CLI's user-facing verbs.
 *
 * Each entry carries every fact a call-site might need:
 *
 * - `name`: the verb token as typed on the command line.
 * - `gateExempt`: if true, the refuse-to-run gate lets this verb
 *   through even when no vault is registered for the cwd.
 * - `load`: lazy loader for the citty `defineCommand` instance.
 *
 * `cli.ts` builds its `subCommands` map and known-verb set from
 * this list; `vault-gate.ts` derives its allow-list from it. No
 * verb-name string literal should appear in any other file.
 */
export interface VerbEntry {
	readonly name: string;
	readonly gateExempt: boolean;
	readonly load: () => Promise<CommandDef>;
}

export const VERBS: readonly VerbEntry[] = [
	{
		name: "install",
		gateExempt: true,
		load: () => import("./install.ts").then((m) => m.default),
	},
	{
		name: "tool",
		gateExempt: false,
		load: () => import("./tool.ts").then((m) => m.default),
	},
	{
		name: "init",
		gateExempt: true,
		load: () => import("./init.ts").then((m) => m.default),
	},
	{
		name: "sync",
		gateExempt: false,
		load: () => import("./sync.ts").then((m) => m.default),
	},
	{
		name: "migrate",
		gateExempt: true,
		load: () => import("./migrate.ts").then((m) => m.default),
	},
	{
		name: "status",
		gateExempt: false,
		load: () => import("./status.ts").then((m) => m.default),
	},
	{
		name: "version",
		gateExempt: true,
		load: () => import("./version.ts").then((m) => m.default),
	},
];

export const verbNames = (): ReadonlySet<string> =>
	new Set(VERBS.map((v) => v.name));

export const gateExemptVerbs = (): ReadonlySet<string> =>
	new Set(VERBS.filter((v) => v.gateExempt).map((v) => v.name));
