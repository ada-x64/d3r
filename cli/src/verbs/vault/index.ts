// Citty parent for the `vault` verb. The remaining subverbs
// (`lint`, `repair`) are wired in subsequent commits.

import { defineCommand, type CommandDef } from "citty";

const command = defineCommand({
	meta: {
		name: "vault",
		description: "Manage the per-repo D3R vault",
	},
	subCommands: {
		init: () => import("./init.ts").then((m) => m.default),
	},
});

export default command as CommandDef;
