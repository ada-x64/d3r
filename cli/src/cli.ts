#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };

const main = defineCommand({
	meta: {
		name: "d3r",
		version: pkg.version,
		description: "D3R agent harness CLI.",
	},
	subCommands: {
		install: () => import("./install.js").then((m) => m.default),
		tool: () => import("./tool.js").then((m) => m.default),
		init: () => import("./init.js").then((m) => m.default),
		sync: () => import("./sync.js").then((m) => m.default),
		migrate: () => import("./migrate.js").then((m) => m.default),
		status: () => import("./status.js").then((m) => m.default),
		version: () => import("./version.js").then((m) => m.default),
	},
	run: async () => {
		// Sub-commands run through citty's own dispatcher; the bare path is
		// handled below before runMain ever sees citty. Nothing to do here.
	},
});

// process.argv is [node, script, ...userArgs]; user args start at index 2.
const USER_ARGV_OFFSET = 2;
const rawArgs = process.argv.slice(USER_ARGV_OFFSET);
const subCommandNames = new Set(Object.keys(main.subCommands ?? {}));
const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
if (firstPositional && subCommandNames.has(firstPositional)) {
	runMain(main);
} else {
	const { default: bare } = await import("./bare.js");
	const { runCommand } = await import("citty");
	await runCommand(bare, { rawArgs });
}
