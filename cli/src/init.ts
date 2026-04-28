import { defineCommand } from "citty";
import { initView } from "@d3r/core/vault/init.ts";

export default defineCommand({
	meta: {
		name: "init",
		description: "Register a new vault view for the current repo-dir.",
	},
	run: async () => {
		await initView({ cwd: process.cwd() });
	},
});
