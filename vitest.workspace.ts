import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineWorkspace } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));
const r = (p: string) => resolve(root, p);

export default defineWorkspace([
	{
		extends: "./vitest.config.ts",
		test: {
			name: "src",
		},
	},
	{
		extends: "./vitest.config.ts",
		resolve: {
			alias: {
				// NOTE: order matters. The longer `@d3r/core/vault/seed-root` key
				// MUST precede `@d3r/core` — vite's resolver matches in
				// declaration order, and `@d3r/core` would otherwise prefix-match
				// first and rewrite seed-root imports incorrectly. Do not sort
				// alphabetically.
				"@d3r/core/vault/seed-root": r("core/dist/vault/seed-root.js"),
				"@d3r/core": r("core/dist/schema.js"),
				"@d3r/tools": r("tools/dist/index.js"),
				"@d3r/cli": r("cli/dist/cli.js"),
				"@d3r/adapter-pi": r("adapters/pi/dist/compile.js"),
			},
		},
		test: {
			name: "dist",
		},
	},
]);
