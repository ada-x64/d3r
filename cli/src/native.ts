import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	createSessionStore,
	nativeAuthRequired,
	type NativeServerDeps,
} from "@d3r/adapter-acp/server";
import { createModelRuntime, type Models } from "@d3r/adapter-pi/auth";
import { createEmbeddedRuntime } from "@d3r/adapter-pi/embedded";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectMcpTools, loadMcpConfig } from "./mcp.ts";
import { loadModelConfig } from "./model-config.ts";
import { initialSelection } from "./native-models.ts";
import { parseNativeCheckpoint } from "./native-resources.ts";
import { createLazyNativeSession } from "./native-session.ts";
import { loadAgentResources, resolveWorkspaceResource } from "./resources.ts";
import { createWorkspaceTools } from "./runtime-tools.ts";
import { createWorkflowRuntime } from "./workflow-runtime.ts";
import { parseWebProviderConfig } from "./utils/env.ts";

/** Native remains an explicit composition choice; the launcher owns its default switch. */
export interface NativeOptions {
	readonly home: string;
	readonly stateDir?: string;
	readonly version: string;
	readonly preset?: string;
}
/** Narrow IO seams let tests use inert catalogs without auth, network, or subprocesses. */
export interface NativeDependencies {
	readonly createModelRuntime: (options: {
		readonly stateDir: string;
	}) => Promise<
		Pick<Models, "getAvailable" | "streamSimple" | "logout"> & {
			readonly getProviders: () => readonly Pick<
				ReturnType<Models["getProviders"]>[number],
				"id"
			>[];
		}
	>;
	readonly createSessionStore: typeof createSessionStore;
	readonly realpath: (path: string) => Promise<string>;
	readonly loadModelConfig: (
		roots: Parameters<typeof loadModelConfig>[0],
		options?: { readonly signal?: AbortSignal },
	) => ReturnType<typeof loadModelConfig>;
	readonly loadAgentResources: typeof loadAgentResources;
	readonly loadMcpConfig: typeof loadMcpConfig;
	readonly getMcpEnvironment: typeof getDefaultEnvironment;
	readonly getWebProviderConfig: () => ReturnType<
		typeof parseWebProviderConfig
	>;
	readonly connectMcpTools: typeof connectMcpTools;
	readonly createWorkspaceTools: typeof createWorkspaceTools;
	readonly createEmbeddedRuntime: typeof createEmbeddedRuntime;
	readonly createWorkflowRuntime: typeof createWorkflowRuntime;
	readonly resolveWorkspaceResource: typeof resolveWorkspaceResource;
}
/** Absolute roots must be supplied; native sessions never inherit the server process cwd. */
const requireAbsolute = (path: string): string => {
	if (!isAbsolute(path) || path.includes("\0")) {
		throw new Error(
			"Native home, state directory, and workspace roots must be absolute paths",
		);
	}
	return resolve(path);
};
/** A rejected sibling must not leave started filesystem/provider discovery running after creation settles. */
const settleReads = async <T extends readonly unknown[]>(
	tasks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> => {
	try {
		return await Promise.all(tasks);
	} catch (error) {
		await Promise.allSettled(tasks);
		throw error;
	}
};
/** Compose dependencies for one ACP connection; reconnect by creating a fresh dependency object. */
export const createNativeDeps = async (
	options: NativeOptions,
	injected: Partial<NativeDependencies> = {},
): Promise<NativeServerDeps> => {
	const deps: NativeDependencies = {
		createModelRuntime,
		createSessionStore,
		realpath,
		loadModelConfig,
		loadAgentResources,
		loadMcpConfig,
		getMcpEnvironment: getDefaultEnvironment,
		getWebProviderConfig: () => parseWebProviderConfig(process.env),
		connectMcpTools,
		createWorkspaceTools,
		createEmbeddedRuntime,
		createWorkflowRuntime,
		resolveWorkspaceResource,
		...injected,
	};
	const home = requireAbsolute(options.home);
	const stateDir = requireAbsolute(
		options.stateDir ?? join(home, ".agents", "d3r", "private"),
	);
	const models = await deps.createModelRuntime({ stateDir });
	// Credential initialization validates and creates the store; protect its canonical spelling too.
	const privateDirectory = requireAbsolute(await deps.realpath(stateDir));
	let loggedOut = false;
	let loggingOut: Promise<void> | null = null;
	const requireAuthentication = (): void => {
		if (loggedOut) {
			throw nativeAuthRequired();
		}
	};
	return {
		authenticate: async () => requireAuthentication(),
		logout: () => {
			loggedOut = true;
			loggingOut ??= Promise.resolve().then(async () => {
				try {
					const results = await Promise.allSettled(
						models
							.getProviders()
							.map(({ id }) => Promise.resolve().then(() => models.logout(id))),
					);
					if (results.some((result) => result.status === "rejected")) {
						throw new Error("Credential deletion failed");
					}
				} catch {
					throw new Error(
						"Could not clear all D3R provider credentials; this connection remains logged out",
					);
				}
			});
			return loggingOut;
		},
		version: options.version,
		store: deps.createSessionStore(join(stateDir, "sessions")),
		authMethods: [
			{
				id: "d3r-login",
				name: "Log in to a model provider",
				type: "terminal",
				args: ["--terminal-login"],
			},
		],
		createSession: async (input) => {
			requireAuthentication();
			input.signal?.throwIfAborted();
			const workspace = requireAbsolute(input.cwd);
			const directories = (input.additionalDirectories ?? []).map(
				requireAbsolute,
			);
			const [canonicalHome, cwd, ...additionalDirectories] = await settleReads(
				[home, workspace, ...directories].map((path) =>
					Promise.resolve().then(() => deps.realpath(path)),
				),
			);
			input.signal?.throwIfAborted();
			const [available, config, resources] = await settleReads([
				Promise.resolve().then(() =>
					models.getAvailable(undefined, { signal: input.signal }),
				),
				Promise.resolve().then(() =>
					deps.loadModelConfig(
						{ home: canonicalHome, cwd },
						{ signal: input.signal },
					),
				),
				Promise.resolve().then(() =>
					deps.loadAgentResources(
						{ home: canonicalHome, cwd },
						{ signal: input.signal },
					),
				),
			] as const);
			input.signal?.throwIfAborted();
			requireAuthentication();
			if (!available.length) {
				throw nativeAuthRequired();
			}
			if (!config.ok) {
				throw new Error(
					"Invalid .agents/models.json; fix the model configuration before opening a native session",
				);
			}
			const checkpoint = parseNativeCheckpoint({
				version: 1,
				format: "d3r.native",
				sources: {
					home: canonicalHome,
					cwd,
					additionalDirectories,
					models: config.value.sources,
				},
				resources,
				selection: initialSelection(available, config.value, options.preset),
				phase: "routing",
				inner: null,
			});
			return createLazyNativeSession({
				input: { ...input, cwd, additionalDirectories },
				stateDir: privateDirectory,
				models,
				available,
				checkpoint,
				deps,
			});
		},
	};
};
