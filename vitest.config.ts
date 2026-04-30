import { defineConfig } from "vitest/config";

const sharedExclude = [
	"**/node_modules/**",
	"**/dist/**",
	"adapters/pi/extensions/subagent/**",
	"adapters/pi/extensions/mode/**",
];

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		exclude: sharedExclude,
		environment: "node",
		pool: "forks",
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json"],
			include: ["**/*.ts"],
			exclude: [...sharedExclude, "**/*.test.ts", "scripts/**"],
			reportsDirectory: "./coverage",
		},
	},
});
