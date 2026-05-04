import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "migrate",
		description: "Run pending vault migrations",
	},
	run: async () => {
		const { runPendingMigrations } = await import("@d3r/core/vault/migrate");
		await runPendingMigrations();
	},
});
