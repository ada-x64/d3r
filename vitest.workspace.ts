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
			alias: [
				// NOTE: order matters. The longer `@d3r/core/vault/*` regex
				// MUST precede `@d3r/core` — vite matches in declaration
				// order, and `@d3r/core` would otherwise prefix-match first
				// and rewrite vault subpath imports incorrectly. Do not
				// reorder.
				{
					find: /^@d3r\/core\/vault\/(.+)$/,
					replacement: r("core/dist/vault/$1.js"),
				},
				{ find: "@d3r/core", replacement: r("core/dist/schema.js") },
				{ find: "@d3r/tools", replacement: r("tools/dist/index.js") },
				{ find: "@d3r/cli", replacement: r("cli/dist/cli.js") },
				{
					find: "@d3r/adapter-pi",
					replacement: r("adapters/pi/dist/compile.js"),
				},
			],
		},
		test: {
			name: "dist",
		},
	},
]);
