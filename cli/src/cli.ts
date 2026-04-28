#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };

const subCommandNames = new Set([
	"install",
	"tool",
	"init",
	"sync",
	"migrate",
	"status",
	"version",
]);

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
		const first = ctx.rawArgs.find((a) => !a.startsWith("-"));
		if (first && subCommandNames.has(first)) {
			return;
		}
		const bare = await import("./bare.js").then((m) => m.default);
		await bare.run?.({
			args: {},
			cmd: bare,
			rawArgs: ctx.rawArgs,
			data: undefined,
		} as never);
	},
});

runMain(main);
