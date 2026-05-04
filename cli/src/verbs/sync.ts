import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "sync",
		description: "Full sweep of all registered vault views",
	},
	run: () => {
		throw new Error("not yet implemented");
	},
});
