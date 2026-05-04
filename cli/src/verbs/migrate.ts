import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "migrate",
		description: "Run pending vault migrations",
	},
	run: () => {
		throw new Error("not yet implemented");
	},
});
