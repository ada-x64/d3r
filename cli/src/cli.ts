#!/usr/bin/env node
import { defineCommand, runCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import {
	checkForUpdate,
	printUpdateNotice,
	shouldCheckForUpdate,
} from "./update-notify.js";

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
		// handled below before runCommand ever sees citty. Nothing to do
		// here.
	},
});

// process.argv is [node, script, ...userArgs]; user args start at index 2.
const USER_ARGV_OFFSET = 2;
const rawArgs = process.argv.slice(USER_ARGV_OFFSET);
const subCommandNames = new Set(Object.keys(main.subCommands ?? {}));
const firstPositional = rawArgs.find((a) => !a.startsWith("-"));

// Kick off the registry check before the main command runs so the
// fetch can race with command execution. The promise always resolves;
// errors are swallowed inside checkForUpdate.
const updatePromise = shouldCheckForUpdate(process.argv, process.env)
	? checkForUpdate(pkg.version)
	: Promise.resolve(undefined);

try {
	try {
		if (firstPositional && subCommandNames.has(firstPositional)) {
			await runCommand(main, { rawArgs });
		} else {
			const { default: bare } = await import("./bare.js");
			await runCommand(bare, { rawArgs });
		}
	} catch (error) {
		// Match the prior runMain UX: print the message (not a stack) and
		// exit non-zero. resolveHarness() throws synchronously for invalid
		// D3R_HARNESS values, and verb stubs (e.g. init) throw "not yet
		// implemented"; without this, Node would surface those as an
		// unhandled top-level rejection with a stack trace.
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
} finally {
	// Await inside finally so the notice prints AFTER the main
	// command's output has flushed. The promise never rejects.
	const notice = await updatePromise;
	if (notice) {
		printUpdateNotice(notice);
	}
}
process.exit(process.exitCode ?? 0);
