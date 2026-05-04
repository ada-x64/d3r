import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "status",
		description: "Show view registry, dangling links, and run vault_lint",
	},
	run: () => {
		throw new Error("not yet implemented");
	},
});
