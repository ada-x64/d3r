import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "tool",
		description: "Dispatch into the @d3r/tools registry",
	},
	run: () => {
		throw new Error("not yet implemented");
	},
});
