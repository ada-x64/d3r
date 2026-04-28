import { defineCommand } from "citty";
import { vaultStatus } from "@d3r/core/vault/status.ts";

const JSON_INDENT = 2;

export default defineCommand({
	meta: {
		name: "status",
		description: "Show vault view registry and lint output.",
	},
	run: async () => {
		const status = await vaultStatus();
		process.stderr.write(
			`d3r status: ${status.views.length} views registered, lint ${status.lint.kind}\n`,
		);
		process.stdout.write(`${JSON.stringify(status, null, JSON_INDENT)}\n`);
	},
});
