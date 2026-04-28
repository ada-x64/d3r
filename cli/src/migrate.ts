import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "migrate",
		description: "Run pending vault migrations.",
	},
	run: async () => {
		throw new Error("d3r migrate: not yet implemented");
	},
});
