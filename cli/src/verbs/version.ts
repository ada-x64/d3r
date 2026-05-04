import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };

export default defineCommand({
	meta: {
		name: "version",
		description: "Print the d3r version",
	},
	run: () => {
		console.log(pkg.version);
	},
});
