import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "install",
		description: "Install an adapter package into the harness's user dir.",
	},
	run: async () => {
		throw new Error("d3r install: not yet implemented");
	},
});
