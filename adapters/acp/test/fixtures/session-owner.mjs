import { mkdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

/** A lost parent or stalled startup/provider cannot leave an indefinite orphan. */
const CHILD_TIMEOUT_MS = 25_000;
const crash = () => process.kill(process.pid, "SIGKILL");
const watchdog = setTimeout(crash, CHILD_TIMEOUT_MS);
process.on("disconnect", crash);

/** Both Vitest runners cross the same compiled Node/stdio boundary; run pnpm build first.
 * Workspace exports point at TS, unlike published packages: redirect only those exports.
 */
registerHooks({
	resolve: (specifier, context, nextResolve) => {
		const resolved = nextResolve(specifier, context);
		if (specifier.startsWith("@d3r/") && resolved.url.endsWith(".ts")) {
			resolved.url = resolved.url.replace(
				/\/(core|tools|adapters\/(?:acp|pi))\/(.+)\.ts$/,
				"/$1/dist/$2.js",
			);
		}
		return resolved;
	},
});
/** Import after installing the published-package resolution shim. */
const { createNativeDeps } = await import("../../../../cli/dist/native.js");
const { runNativeStdio } = await import("../../dist/stdio.js");
const { createEmbeddedRuntime } = await import("../../../pi/dist/embedded.js");
const { createWorkspaceTools } =
	await import("../../../../cli/dist/runtime-tools.js");
/** Never inherit auth discovery, a user's home, or a live model transport. */
// oxlint-disable-next-line no-magic-numbers -- The fixture accepts exactly two trailing arguments.
const [home, mode] = process.argv.slice(-2);
const model = {
	id: "offline",
	name: "Offline lock journey",
	provider: "fixture",
	api: "openai-completions",
	baseUrl: "https://provider.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 16_384,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
/** IPC observations never contaminate the ACP NDJSON streams. */
const calls = { runtime: 0, model: 0, tools: [] };
process.on("message", (message) => {
	if (message === "observe") {
		process.send({ event: "observed", calls });
	}
});
/** One tool response and one final response finish the first prompt. */
const COMPLETE_CALLS = 2;
/** Start/done events drive the real embedded loop, including its real workspace tool. */
const streamSimple = (_model, _context, settings) => {
	calls.model++;
	if (mode === "restore-only") {
		throw new Error("Load must not call a model");
	}
	const content =
		calls.model === 1
			? [
					{
						type: "toolCall",
						id: "once-write",
						name: "write_file",
						arguments: { path: "marker.txt", content: "written once\n" },
					},
				]
			: [{ type: "text", text: "Wrote marker once." }];
	const message = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: calls.model === 1 ? "toolUse" : "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { ...model.cost, total: 0 },
		},
	};
	const events = [
		{ type: "start", partial: message },
		{ type: "done", reason: message.stopReason, message },
	];
	let index = 0;
	return {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				if (mode === "inflight" && calls.model > COMPLETE_CALLS) {
					process.send({ event: "gate" });
					await delay(CHILD_TIMEOUT_MS, undefined, { signal: settings.signal });
					throw new Error("Provider gate timed out");
				}
				return index < events.length
					? { value: events[index++], done: false }
					: { done: true };
			},
		}),
		result: async () => message,
	};
};
/** The actual NativeDeps, store and runtimes remain assembled; only provider IO is fake. */
const deps = await createNativeDeps(
	{ home, version: "session-owner-test" },
	{
		getWebProviderConfig: () => ({ providerId: "exa" }),
		createModelRuntime: async ({ stateDir }) => {
			await mkdir(stateDir, { recursive: true, mode: 0o700 });
			return {
				getAvailable: async () => [model],
				getProviders: () => [],
				logout: async () => {},
				streamSimple,
			};
		},
		createEmbeddedRuntime: (options) => {
			calls.runtime++;
			return createEmbeddedRuntime(options);
		},
		createWorkspaceTools: (options) =>
			createWorkspaceTools(options).map((tool) => ({
				...tool,
				execute: (...args) => {
					calls.tools.push(tool.name);
					return tool.execute(...args);
				},
			})),
	},
);
try {
	process.exitCode = await runNativeStdio(deps);
} finally {
	clearTimeout(watchdog);
	process.off("disconnect", crash);
	process.disconnect();
}
