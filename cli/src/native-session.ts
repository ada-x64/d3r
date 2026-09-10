import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	type RuntimeConfigOption,
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeSessionInput,
	type RuntimeStopReason,
	type RuntimeTool,
} from "@d3r/core/runtime";
import { type NativeDependencies } from "./native.ts";
import {
	nativeModelConfig,
	nativeModelKey,
	nativeThoughtLevels,
	SELECT_MODEL,
	validateSelection,
	type NativeModel,
	type NativeSelection,
} from "./native-models.ts";
import {
	createNativeSkillTool,
	nativeRoleTools,
	nativeSystemPrompt,
	parseNativeCheckpoint,
	type NativeCheckpoint,
} from "./native-resources.ts";
import { createWorkflowReportTool } from "./workflow-runtime.ts";
import { createNativeMcpSecurity } from "./native-mcp.ts";
import { isWithinRoot, readDiskText } from "./resource-paths.ts";
import { discoverVaultRoot } from "./resource-vault.ts";
import { createVaultTools } from "./vault-tools.ts";
import { createWebTools } from "./web-tools.ts";

/** All shell dependencies stay explicit, including workspace roots and the inert resource pin. */
interface LazyOptions {
	readonly input: RuntimeSessionInput;
	readonly models: Awaited<
		ReturnType<NativeDependencies["createModelRuntime"]>
	>;
	readonly available: readonly NativeModel[];
	readonly checkpoint: NativeCheckpoint;
	readonly deps: NativeDependencies;
}

/** Try every cleanup even when another resource fails to close. */
const cleanup = async (
	resources: readonly { dispose: () => Promise<void> }[],
): Promise<void> => {
	const results = await Promise.allSettled(
		resources.map((resource) =>
			Promise.resolve().then(() => resource.dispose()),
		),
	);
	if (results.some((result) => result.status === "rejected")) {
		throw new Error("Native session cleanup failed");
	}
};
/** Resource links keep external vaults disk-owned without fallback for workspace editor failures. */
const vaultReadClient = (input: RuntimeSessionInput, vaultRoot: string) => {
	const { client } = input;
	if (isWithinRoot(input.cwd, vaultRoot) || !client?.readTextFile) {
		return client;
	}
	return {
		...client,
		readTextFile: (path: string, signal: AbortSignal) =>
			isWithinRoot(vaultRoot, resolve(input.cwd, path))
				? readDiskText(path, signal)
				: client.readTextFile!(path, signal),
	};
};
/** Capabilities select tools; the runtime dispatcher still asks before every privileged call. */
const scopeTools = (
	tools: readonly RuntimeTool[],
	input: RuntimeSessionInput,
	vaultRoot: string,
): RuntimeTool[] => {
	const client = vaultReadClient(input, vaultRoot);
	const diskClient = client && {
		...client,
		readTextFile: undefined,
		writeTextFile: undefined,
	};
	return tools.map((tool) => ({
		...tool,
		permission: ["read_file", "list_directory", "search"].includes(tool.name)
			? "none"
			: "ask",
		execute: (args, context) => {
			const parsed = tool.schema.parse(args);
			const diskOwned =
				!isWithinRoot(input.cwd, vaultRoot) &&
				typeof parsed.path === "string" &&
				isWithinRoot(vaultRoot, resolve(input.cwd, parsed.path));
			return tool.execute(parsed, {
				...context,
				cwd: input.cwd,
				roots: [input.cwd, ...(input.additionalDirectories ?? [])],
				client: diskOwned ? diskClient : client,
			});
		},
	}));
};
/** Lazy sessions expose metadata immediately, but only a prompt may request workspace trust. */
// oxlint-disable-next-line max-statements -- One closure owns lazy setup, cancellation, and rollback.
export const createLazyNativeSession = ({
	input,
	models,
	available,
	checkpoint,
	deps,
}: LazyOptions): RuntimeSession & {
	readonly validateRestore: (checkpoint: unknown) => void;
} => {
	let saved = checkpoint;
	let inner: RuntimeSession | null = null;
	let mcp: Awaited<ReturnType<NativeDependencies["connectMcpTools"]>> | null =
		null;
	let pending: Promise<RuntimeStopReason> | null = null;
	let configuring: Promise<unknown> | null = null;
	let disposal: Promise<void> | null = null;
	const lifetime = new AbortController();
	const suppliedServers = structuredClone(input.mcpServers ?? []);
	const mcpSecurity = createNativeMcpSecurity(input.client);
	mcpSecurity.collect(suppliedServers);
	const assertIdle = () => {
		if (lifetime.signal.aborted || pending || configuring) {
			throw new Error("Native session is disposed or already running");
		}
	};
	/** Return detached validated data; preflight and restore share checks without caching untrusted inputs. */
	const validateRestoreData = (value: unknown): NativeCheckpoint => {
		assertIdle();
		if (inner) {
			throw new Error(
				"Restore requires a freshly opened native session; live trust cannot be restored",
			);
		}
		const parsed = parseNativeCheckpoint(value);
		if (
			parsed.sources.home !== checkpoint.sources.home ||
			parsed.sources.cwd !== input.cwd ||
			JSON.stringify(parsed.sources.additionalDirectories) !==
				JSON.stringify(input.additionalDirectories ?? [])
		) {
			throw new Error(
				"Saved native resource roots differ from the session roots",
			);
		}
		if (parsed.resources.vaultRoot !== checkpoint.resources.vaultRoot) {
			throw new Error(
				"Saved native vault differs from the discovered workspace vault; open a new session instead",
			);
		}
		validateSelection(available, parsed.selection);
		return parsed;
	};
	const getCommands = () =>
		Object.entries(saved.resources.workflow.commands).map(
			([name, { description }]) => ({ name, description }),
		);
	const getConfig = (): readonly RuntimeConfigOption[] =>
		inner?.getConfig?.() ?? [
			...nativeModelConfig(available, saved.selection),
			{
				id: "phase",
				name: "Phase",
				category: "mode",
				value: saved.phase,
				options: [
					{ value: "routing", name: "Routing" },
					...getCommands().map(({ name }) => ({
						value: name,
						name: `/${name}`,
					})),
				],
			},
		];
	const currentSelection = (runtime: RuntimeSession): NativeSelection => {
		const config = runtime.getConfig?.();
		const selection = {
			model: config?.find(({ id }) => id === "model")?.value ?? null,
			thinking:
				config?.find(({ id }) => id === "thought_level")?.value ?? "off",
		};
		validateSelection(available, selection);
		if (!selection.model) {
			throw new Error("Native routing runtime has no selected model");
		}
		return selection;
	};
	/** Apply a saved pair on the unpublished runtime, bridging incompatible thought-level menus first. */
	const restoreSelection = async (
		runtime: RuntimeSession,
		wanted: NativeSelection,
	): Promise<void> => {
		const previous = currentSelection(runtime);
		validateSelection(available, wanted);
		if (previous.model !== wanted.model) {
			const before = available.find(
				(model) => nativeModelKey(model) === previous.model,
			);
			const after = available.find(
				(model) => nativeModelKey(model) === wanted.model,
			);
			const bridge = nativeThoughtLevels(before).find((level) =>
				nativeThoughtLevels(after).includes(level),
			);
			if (bridge === undefined) {
				throw new Error(
					"Saved and selected models have no compatible thought level for transition",
				);
			}
			if (previous.thinking !== bridge) {
				await runtime.setConfig!("thought_level", bridge);
			}
			await runtime.setConfig!("model", wanted.model!);
		}
		if (currentSelection(runtime).thinking !== wanted.thinking) {
			await runtime.setConfig!("thought_level", wanted.thinking);
		}
	};
	/** Setup guidance ends a turn normally; ACP refusal is reserved for content rejection. */
	const explainSetup = async (
		request: RuntimePrompt,
		text: string,
	): Promise<RuntimeStopReason> => {
		await request.emit({
			kind: "text",
			messageId: `d3r:native:${randomUUID()}`,
			text,
		});
		return "completed";
	};
	const permit = async (
		title: string,
		summary: unknown,
		signal: AbortSignal,
	): Promise<boolean> => {
		signal.throwIfAborted();
		const allowed = await input.client?.requestPermission(
			{
				toolCallId: `d3r:permission:${randomUUID()}`,
				title,
				kind: "execute",
				input: summary,
			},
			signal,
		);
		signal.throwIfAborted();
		return allowed === true;
	};
	// oxlint-disable-next-line max-statements -- Keep ownership of partially initialized resources visible until publication.
	const setup = async (
		signal: AbortSignal,
	): Promise<"ready" | "workspace_denied" | "mcp_denied"> => {
		const { vaultRoot } = saved.resources;
		const externalVault = !isWithinRoot(input.cwd, vaultRoot);
		const checkVault = async () => {
			if (
				externalVault &&
				(await discoverVaultRoot(input.cwd, { signal })) !== vaultRoot
			) {
				throw new Error(
					"Native vault location changed; open a new session instead",
				);
			}
		};
		await checkVault();
		if (
			!(await permit(
				externalVault
					? `Trust workspace ${input.cwd} and vault ${vaultRoot} for this session`
					: `Trust workspace ${input.cwd} for this session`,
				{
					cwd: input.cwd,
					additionalDirectories: input.additionalDirectories ?? [],
					...(externalVault
						? {
								vaultRoot,
								vaultAccess:
									"Allow reads of this vault only, not its parent directory. External vault files use disk IO, not editor buffers. Writes still require separate approval.",
							}
						: {}),
					summary:
						"Allow workspace instructions and skills to guide model requests and workspace reads. Provider requests may incur charges. Mutations, commands, MCP connections and MCP calls still require separate approval. Trust is not saved.",
				},
				signal,
			))
		) {
			return "workspace_denied";
		}
		await checkVault();
		const trustedInput = {
			...input,
			additionalDirectories: externalVault
				? [...new Set([...(input.additionalDirectories ?? []), vaultRoot])]
				: input.additionalDirectories,
		};
		const configured = await deps.loadMcpConfig(
			{ home: saved.sources.home, cwd: input.cwd },
			{ signal, onSecrets: mcpSecurity.registerSecrets },
		);
		signal.throwIfAborted();
		const plan = mcpSecurity.plan(configured, suppliedServers, {
			home: saved.sources.home,
			cwd: input.cwd,
			environment: deps.getMcpEnvironment(),
		});
		const servers = plan.map(({ server }) => server);
		// Approve the complete connection plan before launching any executable or contacting any endpoint.
		const approved = await plan.reduce(async (previous, entry) => {
			if (!(await previous)) {
				return false;
			}
			return permit(entry.title, entry.summary, signal);
		}, Promise.resolve(true));
		if (!approved) {
			return "mcp_denied";
		}
		let opened: typeof mcp = null;
		let runtime: RuntimeSession | null = null;
		const setupLifetime = new AbortController();
		const abort = () => setupLifetime.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			signal.throwIfAborted();
			opened = await deps.connectMcpTools(servers, {
				cwd: input.cwd,
				signal: AbortSignal.any([lifetime.signal, setupLifetime.signal]),
			});
			signal.throwIfAborted();
			const tools = [
				...scopeTools(
					deps.createWorkspaceTools({
						cwd: input.cwd,
						additionalDirectories: trustedInput.additionalDirectories,
					}),
					trustedInput,
					vaultRoot,
				),
				createNativeSkillTool(saved.resources),
				...createVaultTools({ vaultRoot }),
				...createWebTools({
					config: deps.getWebProviderConfig(),
					client: input.client,
				}),
				...opened.tools.map((tool) => ({
					...tool,
					permission: "ask" as const,
				})),
			];
			const create = (
				selection: NativeSelection,
				systemPrompt: string,
				{
					tools: selectedTools,
					budgetLabel = "routing",
				}: {
					tools: readonly RuntimeTool[];
					budgetLabel?: string;
				},
			): RuntimeSession => {
				validateSelection(available, selection);
				const model = available.find(
					(entry) => nativeModelKey(entry) === selection.model,
				);
				if (!model) {
					throw new Error("Select a model before starting a native runtime");
				}
				return deps.createEmbeddedRuntime({
					models,
					model,
					modelChoices: available,
					systemPrompt,
					budgetLabel,
					thinkingLevel: selection.thinking as NonNullable<
						Parameters<
							NativeDependencies["createEmbeddedRuntime"]
						>[0]["thinkingLevel"]
					>,
					tools: selectedTools,
					resolveResource: async (resource, context) => {
						const resolved = await deps.resolveWorkspaceResource(resource, {
							cwd: input.cwd,
							roots: [input.cwd, ...(trustedInput.additionalDirectories ?? [])],
							signal: context.signal,
							client: vaultReadClient(input, vaultRoot),
						});
						return resolved.text;
					},
				})({
					...input,
					sessionId: `${input.sessionId}:${randomUUID()}`,
					signal: undefined,
					mcpServers: undefined,
				});
			};
			const routing = create(
				saved.selection,
				nativeSystemPrompt(saved.resources),
				{ tools },
			);
			runtime = routing;
			runtime = deps.createWorkflowRuntime({
				routing,
				workflow: saved.resources.workflow,
				agents: saved.resources.agents,
				createAgent: (name, report) => {
					lifetime.signal.throwIfAborted();
					const agent = saved.resources.agents.find(
						({ spec }) => spec.name === name,
					);
					if (!agent) {
						throw new Error("Unknown workflow role");
					}
					return create(
						currentSelection(routing),
						nativeSystemPrompt(saved.resources, agent),
						{
							tools: [
								...nativeRoleTools(agent, tools),
								createWorkflowReportTool(report),
							],
							budgetLabel: name,
						},
					);
				},
			});
			if (!runtime.snapshot || !runtime.restore || !runtime.setConfig) {
				throw new Error(
					"Native workflow runtime must support persistence and configuration",
				);
			}
			if (saved.inner !== null) {
				runtime.restore(saved.inner);
				await restoreSelection(runtime, saved.selection);
			}
			if (
				runtime.getConfig?.().find(({ id }) => id === "phase")?.value !==
				saved.phase
			) {
				await runtime.setConfig("phase", saved.phase);
			}
			signal.throwIfAborted();
			inner = runtime;
			mcp = opened;
			return "ready";
		} catch {
			setupLifetime.abort();
			await cleanup([
				...(runtime ? [runtime] : []),
				...(opened ? [opened] : []),
			]);
			throw new Error(
				"Unable to initialize native session; check model selection, saved session, and MCP configuration",
			);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
	return {
		getConfig,
		getCommands,
		setConfig: async (id, value) => {
			assertIdle();
			if (inner) {
				configuring = Promise.resolve().then(() =>
					inner!.setConfig!(id, value),
				);
				try {
					await configuring;
				} finally {
					configuring = null;
				}
				return getConfig();
			}
			if (id === "phase") {
				if (
					saved.inner &&
					(saved.inner.routingInterrupted ||
						(saved.inner.engine && saved.inner.engine.status !== "completed"))
				) {
					throw new Error("Abandon the active workflow before changing phase");
				}
				if (
					value !== "routing" &&
					!Object.hasOwn(saved.resources.workflow.commands, value)
				) {
					throw new Error("Unknown workflow phase");
				}
				saved = {
					...saved,
					phase: value,
					inner: saved.inner ? { ...saved.inner, phase: value } : null,
				};
			} else {
				if (id !== "model" && id !== "thought_level") {
					throw new Error("Unknown native configuration option");
				}
				const selectedModel = value === SELECT_MODEL ? null : value;
				const selection = {
					model: id === "model" ? selectedModel : saved.selection.model,
					thinking: id === "thought_level" ? value : saved.selection.thinking,
				};
				validateSelection(available, selection);
				if (saved.inner && !selection.model) {
					throw new Error("A saved conversation requires a selected model");
				}
				saved = {
					...saved,
					selection: {
						...selection,
						thinking:
							selection.thinking as NativeCheckpoint["selection"]["thinking"],
					},
				};
			}
			return getConfig();
		},
		prompt: (request) => {
			assertIdle();
			const signal = AbortSignal.any([request.signal, lifetime.signal]);
			pending = Promise.resolve()
				.then(async () => {
					if (signal.aborted) {
						return "cancelled" as const;
					}
					if (!inner && saved.selection.model === null) {
						return explainSetup(
							request,
							"Select a model in Zed's Model picker before sending a prompt, or choose an explicit CLI preset configured in .agents/models.json. No model request or MCP connection was made.",
						);
					}
					if (!inner) {
						const outcome = await setup(signal);
						if (outcome !== "ready") {
							return explainSetup(
								request,
								outcome === "workspace_denied"
									? "Workspace permission was not granted. Send your prompt again to retry, and approve workspace use in Zed if you want to proceed. No model request or MCP connection was made."
									: "MCP connection permission was not granted. Send your prompt again to retry, and approve the configured connections if you want to proceed. No model request or MCP connection was made.",
							);
						}
					}
					return inner!.prompt({ ...request, signal });
				})
				.then((reason) => (signal.aborted ? "cancelled" : reason))
				.catch((error: unknown) => {
					if (signal.aborted) {
						return "cancelled" as const;
					}
					throw error;
				})
				.finally(() => {
					pending = null;
				});
			return pending;
		},
		snapshot: () => {
			assertIdle();
			return parseNativeCheckpoint(
				inner
					? {
							...saved,
							selection: currentSelection(inner),
							phase: getConfig().find(({ id }) => id === "phase")?.value,
							inner: inner.snapshot!(),
						}
					: saved,
			);
		},
		validateRestore: (value) => {
			validateRestoreData(value);
		},
		restore: (value) => {
			saved = validateRestoreData(value);
		},
		dispose: () => {
			if (disposal) {
				return disposal;
			}
			lifetime.abort();
			disposal = (async () => {
				await pending?.catch(() => undefined);
				await configuring?.catch(() => undefined);
				await cleanup([...(inner ? [inner] : []), ...(mcp ? [mcp] : [])]);
				inner = null;
				mcp = null;
			})();
			return disposal;
		},
	};
};
