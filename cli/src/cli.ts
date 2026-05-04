#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };
import bareLaunch, { ARGV_USER_OFFSET } from "./bare.ts";
import { gate } from "./vault-gate.ts";

const KNOWN_VERBS: ReadonlySet<string> = new Set([
	"install",
	"tool",
	"init",
	"sync",
	"migrate",
	"status",
	"version",
]);

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

const root = defineCommand({
	meta: {
		name: "d3r",
		version: pkg.version,
		description: "D3R: design / delegate / develop tooling",
	},
	subCommands: {
		install: () => import("./verbs/install.ts").then((m) => m.default),
		tool: () => import("./verbs/tool.ts").then((m) => m.default),
		init: () => import("./verbs/init.ts").then((m) => m.default),
		sync: () => import("./verbs/sync.ts").then((m) => m.default),
		migrate: () => import("./verbs/migrate.ts").then((m) => m.default),
		status: () => import("./verbs/status.ts").then((m) => m.default),
		version: () => import("./verbs/version.ts").then((m) => m.default),
		__bare__: bare,
	},
	default: "__bare__",
	setup: async (ctx) => {
		const rawArgs = ctx.rawArgs ?? process.argv.slice(ARGV_USER_OFFSET);
		await gate(resolveVerb(rawArgs), process.cwd());
	},
});

runMain(root);
