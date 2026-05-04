import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "init",
		description: "Register a new repo-dir's vault view",
	},
	run: async () => {
		const { initView } = await import("@d3r/core/vault/init");
		await initView({ cwd: process.cwd() });
	},
});
