import {
	client,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach } from "vitest";
import { type Models } from "../../../pi/auth.ts";
import { createEmbeddedRuntime } from "../../../pi/embedded.ts";
import {
	createNativeDeps,
	type NativeDependencies,
} from "../../../../cli/src/native.ts";
import {
	nativeModelKey,
	type NativeModel,
} from "../../../../cli/src/native-models.ts";
import { fixture } from "../../test-support.ts";
import {
	type JourneyStream,
	type JourneyContext,
	type JourneyMessage,
	type JourneyScripts,
	JOURNEY_MODEL,
	JOURNEY_SUMMARY,
	journeyStream,
	journeyRouterShortcut,
	type JourneyDecision,
	journeyCheckpoint,
} from "./helpers.ts";
/** One suite owns its real temporary workspaces and ACP connections. */
export const nativeJourneySuite = () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	const open = async (
		scripts: JourneyScripts,
		{
			workspace = "workspace",
			routerShortcuts = true,
			models = [JOURNEY_MODEL],
			readTextFile,
			getWebConfig = () => ({ providerId: "exa" }),
			createRuntime = createEmbeddedRuntime,
			streamResponse = (_role: string, content: JourneyMessage["content"]) =>
				journeyStream(content),
		}: {
			workspace?: string;
			routerShortcuts?: boolean;
			models?: NativeModel[];
			getWebConfig?: NativeDependencies["getWebProviderConfig"];
			createRuntime?: NativeDependencies["createEmbeddedRuntime"];
			streamResponse?: (
				role: string,
				content: JourneyMessage["content"],
				// oxlint-disable-next-line no-magic-numbers -- The provider's third argument carries its cancellation signal.
				settings: Parameters<Models["streamSimple"]>[2],
			) => JourneyStream;
			readTextFile?: (
				request: ReadTextFileRequest,
			) => Promise<ReadTextFileResponse>;
		} = {},
	) => {
		const root = await mkdtemp(
			resolve(await realpath(tmpdir()), "d3r-acp-journey-"),
		);
		directories.push(root);
		const home = resolve(root, "home");
		const cwd = resolve(root, workspace);
		await Promise.all([mkdir(home), mkdir(cwd, { recursive: true })]);
		await writeFile(
			resolve(cwd, "AGENTS.md"),
			"Preserve the offline user's requirements.",
		);
		const requests: {
			role: string;
			model: NativeModel;
			context: JourneyContext;
		}[] = [];
		const runtimes: {
			options: Parameters<NativeDependencies["createEmbeddedRuntime"]>[0];
			input: Parameters<
				ReturnType<NativeDependencies["createEmbeddedRuntime"]>
			>[0];
		}[] = [];
		const permissions: RequestPermissionRequest[] = [];
		const reads: ReadTextFileRequest[] = [];
		const approval = {
			decide: async (
				_request: RequestPermissionRequest,
			): Promise<JourneyDecision> => true,
		};
		const streamSimple: Models["streamSimple"] = (model, context, settings) => {
			const role = context.systemPrompt?.startsWith(
				"You summarize completed D3R workflows.",
			)
				? "summary"
				: (/^You are (\w+)\./.exec(context.systemPrompt ?? "")?.[1] ??
					"router");
			requests.push({
				role,
				model: structuredClone(model),
				context: {
					systemPrompt: context.systemPrompt,
					messages: structuredClone(context.messages),
					tools: context.tools?.map(({ name, description, parameters }) => ({
						name,
						description,
						parameters: structuredClone(parameters),
					})),
				},
			});
			const content =
				role === "summary" && !Object.hasOwn(scripts, role)
					? [{ type: "text" as const, text: JOURNEY_SUMMARY }]
					: ((role === "router" &&
						routerShortcuts &&
						context.systemPrompt?.startsWith(
							"You are D3R's native workflow orchestrator in Zed.",
						)
							? journeyRouterShortcut(context)
							: undefined) ?? scripts[role]?.shift());
			if (!content) {
				throw new Error(`Unexpected offline request for ${role}`);
			}
			return streamResponse(
				role,
				typeof content === "function" ? content(context) : content,
				settings,
			);
		};
		const connect = async () => {
			const deps = await createNativeDeps(
				{ home, version: "journey-test" },
				{
					getWebProviderConfig: getWebConfig,
					createEmbeddedRuntime: (options) => (input) => {
						runtimes.push({ options, input });
						return createRuntime(options)(input);
					},
					createModelRuntime: async ({ stateDir }) => {
						await mkdir(stateDir, { recursive: true, mode: 0o700 });
						return {
							getAvailable: async () => models,
							getProviders: () => [],
							logout: async () => {},
							streamSimple,
						};
					},
				},
			);

			const clientApp = client().onRequest(
				"session/request_permission",
				async ({ params }) => {
					permissions.push(params);
					const decision = await approval.decide(params);
					if (decision === "cancelled") {
						return { outcome: { outcome: "cancelled" } };
					}
					const once = decision ? "allow_once" : "reject_once";
					const kind = decision === "allow_scope" ? "allow_always" : once;
					return {
						outcome: {
							outcome: "selected",
							optionId: params.options.find((option) => option.kind === kind)!
								.optionId,
						},
					};
				},
			);
			const f = fixture(deps.createSession, async () => {}, {
				deps,
				clientApp: readTextFile
					? clientApp.onRequest("fs/read_text_file", ({ params }) => {
							reads.push(params);
							return readTextFile(params);
						})
					: clientApp,
			});
			cleanup.push(f.close);
			await f.peer.agent.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: readTextFile ? { fs: { readTextFile: true } } : {},
			});
			const configure = (sessionId: string, configId: string, value: string) =>
				f.peer.agent.request("session/set_config_option", {
					sessionId,
					configId,
					value,
				});
			const select = (sessionId: string, model: NativeModel | string) =>
				configure(
					sessionId,
					"model",
					typeof model === "string" ? model : nativeModelKey(model),
				);
			const session = async (model: NativeModel | string = JOURNEY_MODEL) => {
				const created = await f.newSession(cwd);
				await select(created.sessionId, model);
				return created;
			};
			const load = (sessionId: string) =>
				f.peer.agent.request("session/load", {
					sessionId,
					cwd,
					mcpServers: [],
				});
			const closeSession = (sessionId: string) =>
				f.peer.agent.request("session/close", { sessionId });
			const checkpoint = async (sessionId: string) => {
				const saved = await deps.store!.get(sessionId);
				const record = saved?.records.at(-1);
				if (record?.kind !== "checkpoint") {
					throw new Error("Missing durable checkpoint");
				}
				return record.state;
			};
			return {
				...f,
				session,
				select,
				configure,
				load,
				closeSession,
				cancel: (sessionId: string) =>
					f.peer.agent.notify("session/cancel", { sessionId }),
				state: async (sessionId: string) =>
					journeyCheckpoint(await checkpoint(sessionId)),
				/** Restore the old on-disk format through ACP, with no orchestration opt-out in production. */
				legacySession: async () => {
					const created = await session();
					const { sessionId } = created;
					await closeSession(sessionId);
					const saved = (await deps.store!.get(sessionId))!;
					const record = saved.records.at(-1)!;
					if (record.kind !== "checkpoint") {
						throw new Error("Missing legacy fixture resource pin");
					}
					const pin = journeyCheckpoint(record.state);
					pin.inner = {
						version: 1,
						format: "d3r.workflow",
						workflow: pin.resources.workflow,
						phase: "routing",
						engine: null,
						history: [],
						input: [],
						routingInterrupted: false,
						routingInput: [],
						routingHistory: 0,
						routing: {
							version: 1,
							format: "d3r.pi.embedded",
							model: { provider: JOURNEY_MODEL.provider, id: JOURNEY_MODEL.id },
							thinkingLevel: "off",
							messages: [],
						},
					};
					await deps.store!.save({
						...saved,
						records: [
							...saved.records.slice(0, -1),
							{
								kind: "checkpoint",
								state: { ...(record.state as object), runtime: pin },
							},
						],
					});
					await load(sessionId);
					return created;
				},
				saved: (sessionId: string) => deps.store!.get(sessionId),
				checkpoint,
				prompt: (sessionId: string, text: string) =>
					f.peer.agent.request("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text }],
					}),
			};
		};
		return {
			root,
			cwd,
			requests,
			runtimes,
			permissions,
			reads,
			approval,
			connect,
		};
	};
	afterEach(async () => {
		try {
			await Promise.all(cleanup.splice(0).map((close) => close()));
		} finally {
			await Promise.all(
				directories
					.splice(0)
					.map((path) => rm(path, { recursive: true, force: true })),
			);
		}
	});
	return { open, cleanup };
};
