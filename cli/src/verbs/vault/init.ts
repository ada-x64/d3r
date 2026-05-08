// `d3r vault init --vault-root <path>` — greenfield vault
// initialisation. The `seedDir` parameter on `initVault` is an
// internal test seam; only `--vault-root` is user-facing here.

import { defineCommand } from "citty";

const formatError = (error: unknown): string => {
	if (typeof error !== "object" || error === null) {
		return String(error);
	}
	const e = error as { kind?: string; path?: string; stderr?: string };
	switch (e.kind) {
		case "vault-not-a-directory": {
			return `vault-not-a-directory: ${e.path} is not a directory`;
		}
		case "vault-not-empty": {
			return `vault-not-empty: ${e.path} is not empty`;
		}
		case "git-already-initialized": {
			return `git-already-initialized: ${e.path} already exists`;
		}
		case "seed-missing": {
			return `seed-missing: ${e.path}`;
		}
		case "git-spawn-failed": {
			return `git-spawn-failed: ${(e.stderr ?? "").trim()}`;
		}
		default: {
			return `init failed: ${JSON.stringify(error)}`;
		}
	}
};

export default defineCommand({
	meta: {
		name: "init",
		description: "Initialise an empty directory as a fresh D3R vault",
	},
	args: {
		"vault-root": {
			type: "string",
			required: true,
			description: "Absolute path to the directory to initialise",
		},
	},
	run: async ({ args }) => {
		const { initVault } = await import("@d3r/core/vault/init");
		const result = await initVault({ vaultRoot: args["vault-root"] });
		if (!result.ok) {
			process.stderr.write(`${formatError(result.error)}\n`);
			process.exit(1);
		}
		process.stderr.write(
			`initialised vault at ${result.value.vaultRoot} @ ${result.value.commit}\n`,
		);
	},
});
