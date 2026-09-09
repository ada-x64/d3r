import { join, resolve } from "node:path";
import { createEmbeddedRuntime } from "@d3r/adapter-pi/embedded";
import { type SessionStore, type StoredSession } from "@d3r/adapter-acp/server";
import { AgentSpec } from "@d3r/core";
import {
	type RuntimePrompt,
	type RuntimeSessionInput,
	type RuntimeSession,
} from "@d3r/core/runtime";
import { vi } from "vitest";
import {
	createNativeDeps,
	type NativeDependencies,
	type NativeOptions,
} from "./native.ts";
import { nativeModelKey, type NativeModel } from "./native-models.ts";
import { type AgentResources } from "./resources.ts";
import { type LoadedModelConfig } from "./model-config.ts";
import { createWorkspaceTools } from "./runtime-tools.ts";
import { createWorkflowRuntime } from "./workflow-runtime.ts";

/** Virtual absolute roots make pure composition tests independent of platform and process cwd. */
export const HOME = resolve("native-test-home");
/** The session workspace deliberately differs from the private home. */
export const CWD = resolve("native-test-workspace");
/** Complete model metadata exercises the real adapter's selector/checkpoint validators. */
export const MODEL_A: NativeModel = {
	id: "first",
	name: "First",
	provider: "offline",
	api: "openai-completions",
	baseUrl: "https://provider.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
/** A second model catches accidental first-model and frozen-child-selection behavior. */
export const MODEL_B: NativeModel = {
	...MODEL_A,
	id: "second",
	name: "Second",
};
/** Actual core schemas and workflow engine, with a short single-role chain. */
export const testResources = (): AgentResources => ({
	agents: [
		{
			spec: AgentSpec.parse({
				name: "designer",
				tier: "low",
				description: "Design things",
				capabilities: ["read", "write"],
			}),
			prompt: "Declared designer persona.",
		},
		{
			spec: AgentSpec.parse({
				name: "orchestrator",
				tier: "moderate",
				description: "Legacy router",
				capabilities: ["read", "bash", "delegate"],
			}),
			prompt: "LEGACY PERSONA: enter pi normal mode and dispatch subagent.",
		},
	],
	workflow: {
		commands: {
			design: {
				description: "Design",
				chain: [{ kind: "agent", name: "designer" }],
			},
		},
		vault: { dirs: [], template_kinds: [] },
	},
	instructions: "Pinned workspace instructions.",
	systemPrompt: "Loaded custom system prompt.",
	skills: [
		{
			name: "test-skill",
			description: "Skill description",
			prompt: "Do not execute this skill at startup.",
			path: join(HOME, ".agents", "skills", "test-skill", "SKILL.md"),
		},
	],
	vaultRoot: join(CWD, ".agents", "vault"),
});
/** Session envelopes round-trip through a memory store; no private files are created by these tests. */
export const memoryStore = (): SessionStore => {
	const saved = new Map<string, StoredSession>();
	return {
		acquire: vi.fn(async () => async () => {}),
		get: vi.fn(async (id) => structuredClone(saved.get(id) ?? null)),
		save: vi.fn(async (session) => {
			saved.set(session.sessionId, structuredClone(session));
		}),
		delete: vi.fn(async (id) => saved.delete(id)),
		list: vi.fn(async () => ({ sessions: [] })),
	};
};
/** Real metadata/checkpoint behavior with an explicit offline prompt callback instead of model inference. */
export interface TestTurn {
	readonly options: Parameters<typeof createEmbeddedRuntime>[0];
	readonly input: RuntimeSessionInput;
	readonly request: RuntimePrompt;
	readonly runtime: RuntimeSession;
}
/** Dependency fixtures still run the real workflow wrapper, report tool, and workspace tool construction. */
export const nativeFixture = () => {
	const config: LoadedModelConfig = {
		config: {
			presets: [
				{
					id: "chosen",
					provider: MODEL_B.provider,
					model: MODEL_B.id,
					thinkingLevel: "medium",
				},
			],
			defaultPreset: "chosen",
		},
		sources: [join(CWD, ".agents", "models.json")],
	};
	const resources = testResources();
	const store = memoryStore();
	const models = {
		getProviders: vi.fn(() => [{ id: "offline" }, { id: "other-offline" }]),
		logout: vi.fn(async (_providerId: string) => {}),
		getAvailable: vi.fn<
			Awaited<
				ReturnType<NativeDependencies["createModelRuntime"]>
			>["getAvailable"]
		>(async () => [MODEL_A, MODEL_B]),
		streamSimple: vi.fn<
			Awaited<
				ReturnType<NativeDependencies["createModelRuntime"]>
			>["streamSimple"]
		>(() => {
			throw new Error("Unexpected provider call in offline test");
		}),
	};
	const turns: TestTurn[] = [];
	const disposals: RuntimeSession[] = [];
	const onTurn = vi.fn(async ({ options, input, request }: TestTurn) => {
		const report = options.tools?.find(({ name }) => name === "d3r_report");
		if (report) {
			await report.execute(
				{ status: "completed", summary: "Role completed" },
				{
					toolCallId: "report",
					cwd: input.cwd,
					roots: [input.cwd],
					signal: request.signal,
				},
			);
		}
		await request.emit({
			kind: "text",
			messageId: "offline-reply",
			text: "Offline reply",
		});
	});
	const deps = {
		createModelRuntime: vi.fn<NativeDependencies["createModelRuntime"]>(
			async () => models,
		),
		createSessionStore: vi.fn<NativeDependencies["createSessionStore"]>(
			() => store,
		),
		realpath: vi.fn(async (path: string) => path),
		loadModelConfig: vi.fn<NativeDependencies["loadModelConfig"]>(async () => ({
			ok: true,
			value: config,
		})),
		loadAgentResources: vi.fn<NativeDependencies["loadAgentResources"]>(
			async () => resources,
		),
		loadMcpConfig: vi.fn<NativeDependencies["loadMcpConfig"]>(async () => []),
		getMcpEnvironment: vi.fn<NativeDependencies["getMcpEnvironment"]>(
			() => ({}),
		),
		connectMcpTools: vi.fn<NativeDependencies["connectMcpTools"]>(async () => ({
			tools: [],
			dispose: vi.fn(async () => {}),
		})),
		createWorkspaceTools: vi.fn(createWorkspaceTools),
		createWorkflowRuntime: vi.fn(createWorkflowRuntime),
		resolveWorkspaceResource: vi.fn<
			NativeDependencies["resolveWorkspaceResource"]
		>(async () => ({ type: "text", text: "Resolved resource text" })),
		createEmbeddedRuntime: vi.fn<NativeDependencies["createEmbeddedRuntime"]>(
			(options) => (input) => {
				const runtime = createEmbeddedRuntime(options)(input);
				return {
					...runtime,
					prompt: async (request) => {
						const turn = { options, input, request, runtime };
						turns.push(turn);
						await onTurn(turn);
						return request.signal.aborted ? "cancelled" : "completed";
					},
					dispose: async () => {
						disposals.push(runtime);
						await runtime.dispose();
					},
				};
			},
		),
	};
	const requestPermission = vi.fn(async () => true);
	const sessions: RuntimeSession[] = [];
	const server = (
		options: Partial<NativeOptions> = {},
		overrides: Partial<NativeDependencies> = {},
	) =>
		createNativeDeps(
			{ home: HOME, version: "native-test", ...options },
			{ ...deps, ...overrides },
		);
	const open = async (
		input: Partial<RuntimeSessionInput> = {},
		overrides: Partial<NativeDependencies> = {},
	) => {
		const dependencies = await server({}, overrides);
		const session = await dependencies.createSession({
			sessionId: "offline-session",
			cwd: CWD,
			client: { requestPermission },
			...input,
		});
		sessions.push(session);
		return session;
	};
	return {
		config,
		resources,
		models,
		store,
		deps,
		turns,
		disposals,
		onTurn,
		requestPermission,
		sessions,
		server,
		open,
		close: () => Promise.all(sessions.map((session) => session.dispose())),
	};
};
/** Standard prompt with captured emissions; all effects are opt-in test callbacks. */
export const testPrompt = (
	text = "hello",
	overrides: Partial<RuntimePrompt> = {},
): RuntimePrompt => ({
	content: [{ type: "text", text }],
	signal: new AbortController().signal,
	emit: vi.fn(async () => {}),
	...overrides,
});
/** Selector identity as exposed to ACP, not the catalog's raw id. */
export const chosenModel = nativeModelKey(MODEL_B);
