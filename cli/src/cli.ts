#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };
import bareLaunch, { ARGV_USER_OFFSET } from "./bare.ts";
import { gate } from "./vault-gate.ts";
import { ALL_VERBS, verbNames } from "./verbs/registry.ts";

const KNOWN_VERBS = verbNames();

const resolveVerb = (rawArgs: readonly string[]): string | undefined => {
	for (const arg of rawArgs) {
		if (!arg.startsWith("-")) {
			return KNOWN_VERBS.has(arg) ? arg : undefined;
		}
	}
	return undefined;
};

const bare = defineCommand({
	meta: { name: "__bare__", hidden: true },
	run: (ctx) => bareLaunch(ctx.rawArgs ?? process.argv.slice(ARGV_USER_OFFSET)),
});

const subCommands = {
	...Object.fromEntries(ALL_VERBS.map((v) => [v.name, v.load])),
	__bare__: bare,
};

const root = defineCommand({
	meta: {
		name: "d3r",
		version: pkg.version,
		description: "D3R: design / delegate / develop tooling",
	},
	subCommands,
	default: "__bare__",
	setup: async (ctx) => {
		const rawArgs = ctx.rawArgs ?? process.argv.slice(ARGV_USER_OFFSET);
		await gate(resolveVerb(rawArgs), process.cwd());
	},
});

runMain(root);
