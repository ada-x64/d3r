import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "bare",
		description: "Launch the configured harness in routing mode.",
	},
	run: async () => {
		throw new Error("d3r bare-launch: not yet implemented");
	},
});
