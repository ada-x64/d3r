// Citty parent for the `vault` verb. Subverbs (`init`, `lint`,
// `repair`) are wired in subsequent commits and registered here as
// they land. The parent itself only describes the namespace.

import { defineCommand, type CommandDef } from "citty";

const command = defineCommand({
	meta: {
		name: "vault",
		description: "Manage the per-repo D3R vault",
	},
	subCommands: {},
});

export default command as CommandDef;
