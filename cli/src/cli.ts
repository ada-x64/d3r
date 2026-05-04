#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };

const bare = defineCommand({
	meta: { name: "__bare__", hidden: true },
	run: () => {
		throw new Error("not yet implemented: bare launch");
	},
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
});

runMain(root);
