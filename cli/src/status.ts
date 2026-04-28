import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "status",
		description: "Show vault view registry and lint output.",
	},
	run: async () => {
		throw new Error("d3r status: not yet implemented");
	},
});
