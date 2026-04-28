import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "sync",
		description: "Sweep all registered vault views.",
	},
	run: async () => {
		throw new Error("d3r sync: not yet implemented");
	},
});
