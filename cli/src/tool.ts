import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "tool",
		description: "Dispatch a @d3r/tools registry entry.",
	},
	run: async () => {
		throw new Error("d3r tool: not yet implemented");
	},
});
