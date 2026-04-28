import { defineCommand } from "citty";
import { runPendingMigrations } from "@d3r/core/vault/migrate.ts";

export default defineCommand({
	meta: {
		name: "migrate",
		description: "Run pending vault migrations.",
	},
	run: async () => {
		await runPendingMigrations();
	},
});
