import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "sync",
		description: "Full sweep of all registered vault views",
	},
	run: async () => {
		const { syncAll } = await import("@d3r/core/vault/sync");
		await syncAll();
	},
});
