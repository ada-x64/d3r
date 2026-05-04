import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "install",
		description: "Install an adapter package into the harness's user dir",
	},
	run: () => {
		throw new Error("not yet implemented");
	},
});
