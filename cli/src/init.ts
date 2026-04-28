import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "init",
		description: "Register a new vault view for the current repo-dir.",
	},
	run: async () => {
		throw new Error("d3r init: not yet implemented");
	},
});
