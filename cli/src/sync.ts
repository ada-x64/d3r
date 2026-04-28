import { defineCommand } from "citty";
import { syncAll } from "@d3r/core/vault/sync.ts";
import { vaultGate } from "./vault-gate.js";

export default defineCommand({
	meta: {
		name: "sync",
		description: "Sweep all registered vault views.",
	},
	setup: async () => {
		await vaultGate(process.cwd());
	},
	run: async () => {
		await syncAll();
	},
});
