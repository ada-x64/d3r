import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "status",
		description: "Show view registry, dangling links, and run vault_lint",
	},
	run: async () => {
		const { vaultStatus } = await import("@d3r/core/vault/status");
		const result = await vaultStatus();
		const JSON_INDENT = 2;
		console.log(JSON.stringify(result, null, JSON_INDENT));
	},
});
