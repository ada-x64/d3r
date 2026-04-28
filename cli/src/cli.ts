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
	run: async (ctx) => {
		const subCommandNames = new Set(Object.keys(main.subCommands ?? {}));
		const first = ctx.rawArgs.find((a) => !a.startsWith("-"));
		if (first && subCommandNames.has(first)) {
			return;
		}
		throw new Error("d3r bare-launch: not yet implemented");
	},
});

runMain(main);
