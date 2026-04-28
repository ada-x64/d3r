import { defineCommand } from "citty";
import { syncAll } from "@d3r/core/vault/sync.ts";

export default defineCommand({
	meta: {
		name: "sync",
		description: "Sweep all registered vault views.",
	},
	run: async () => {
		await syncAll();
	},
});
