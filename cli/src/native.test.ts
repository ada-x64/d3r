/* oxlint-disable no-magic-numbers -- Counts and array offsets are explicit test expectations. */
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeDeps } from "./native.ts";
import { nativeModelKey } from "./native-models.ts";
import { parseNativeCheckpoint } from "./native-resources.ts";
import {
	CWD,
	HOME,
	MODEL_A,
	chosenModel,
	nativeFixture,
	testPrompt,
} from "./native-test-support.ts";

/** Composition contracts cover real selector/checkpoint/workflow code with offline injected IO. */
describe("native dependency composition", () => {
	const fixtures: ReturnType<typeof nativeFixture>[] = [];
	const fixture = () => {
		const f = nativeFixture();
		fixtures.push(f);
		return f;
	};
	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
	});

	it("uses private D3R state, advertises terminal login, and does no catalog discovery at startup", async () => {
		const f = fixture();
		const server = await f.server();
		expect(f.deps.createModelRuntime).toHaveBeenCalledWith({
			stateDir: join(HOME, ".agents", "d3r", "private"),
		});
		expect(f.deps.createSessionStore).toHaveBeenCalledWith(
			join(HOME, ".agents", "d3r", "private", "sessions"),
		);
		expect(server.version).toBe("native-test");
		expect(server.authMethods).toEqual([
			{
				id: "d3r-login",
				name: "Log in to a model provider",
				type: "terminal",
				args: ["--terminal-login"],
			},
		]);
		expect(f.models.getAvailable).not.toHaveBeenCalled();
		await f.server({ stateDir: resolve("custom-native-private") });
		expect(f.deps.createSessionStore).toHaveBeenLastCalledWith(
			resolve("custom-native-private", "sessions"),
		);
		await expect(
			createNativeDeps({ home: "relative", version: "test" }, f.deps),
		).rejects.toThrow("absolute");
	});

	it("passes ACP's setup signal to getAvailable and reports missing auth without selecting a catalog entry", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.models.getAvailable.mockResolvedValue([]);
		await expect(f.open({ signal: controller.signal })).rejects.toEqual({
			tag: "native_auth_required",
		});
		expect(f.models.getAvailable).toHaveBeenCalledWith(undefined, {
			signal: controller.signal,
		});
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		expect(f.requestPermission).not.toHaveBeenCalled();
	});

	it("cancels availability discovery cooperatively before exposing a session", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.models.getAvailable.mockImplementation(async (_provider, options) => {
			expect(options?.signal).toBe(controller.signal);
			controller.abort(new Error("setup cancelled"));
			return [MODEL_A];
		});
		await expect(f.open({ signal: controller.signal })).rejects.toThrow(
			"setup cancelled",
		);
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
	});

	it("shows select-model with no configured default, and makes no permission, MCP, or provider request", async () => {
		const f = fixture();
		f.deps.loadModelConfig.mockResolvedValue({
			ok: true,
			value: {
				config: { presets: f.config.config.presets, defaultPreset: null },
				sources: [],
			},
		});
		const session = await f.open();
		expect(session.getConfig?.()[0]).toMatchObject({
			id: "model",
			value: "select-model",
		});
		expect(session.getCommands?.()).toEqual([
			{ name: "design", description: "Design" },
		]);
		expect(
			parseNativeCheckpoint(session.snapshot!()).selection.model,
		).toBeNull();
		const prompt = testPrompt();
		await expect(session.prompt(prompt)).resolves.toBe("refused");
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("Zed's Model picker"),
			}),
		);
		expect(f.models.getAvailable).toHaveBeenCalledTimes(1);
		expect(f.models.streamSimple).not.toHaveBeenCalled();
		expect(f.requestPermission).not.toHaveBeenCalled();
		expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		await session.setConfig!("model", chosenModel);
		await session.prompt(testPrompt());
		expect(f.turns[0].options.model.id).toBe("second");
	});

	it("uses an explicit CLI preset without a default, and refuses unknown or unavailable selections", async () => {
		const f = fixture();
		f.deps.loadModelConfig.mockResolvedValue({
			ok: true,
			value: {
				config: { presets: f.config.config.presets, defaultPreset: null },
				sources: [],
			},
		});
		const server = await f.server({ preset: "chosen" });
		const session = await server.createSession({
			sessionId: "preset",
			cwd: CWD,
		});
		f.sessions.push(session);
		expect(session.getConfig?.()[0].value).toBe(chosenModel);
		await expect(
			session.setConfig!("model", "offline/not-available"),
		).rejects.toThrow("Unavailable model");
		await expect(session.setConfig!("thought_level", "max")).rejects.toThrow(
			"unsupported thought level",
		);
		expect(session.getConfig?.()[0].value).toBe(chosenModel);
		const invalid = await f.server({ preset: "absent" });
		await expect(
			invalid.createSession({ sessionId: "invalid", cwd: CWD }),
		).rejects.toThrow("Unknown model preset");
		f.models.getAvailable.mockResolvedValue([MODEL_A]);
		await expect(
			server.createSession({ sessionId: "unavailable", cwd: CWD }),
		).rejects.toThrow("Unavailable model");
	});

	it("keeps metadata inert and refuses workspace denial without even loading MCP secrets", async () => {
		const f = fixture();
		f.requestPermission.mockResolvedValue(false);
		const session = await f.open();
		session.snapshot!();
		session.getConfig!();
		await session.setConfig!("thought_level", "low");
		expect(f.requestPermission).not.toHaveBeenCalled();
		await expect(session.prompt(testPrompt())).resolves.toBe("refused");
		expect(f.requestPermission).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCallId: expect.stringMatching(/^d3r:permission:/),
				title: expect.stringContaining(CWD),
				input: expect.objectContaining({ cwd: CWD }),
			}),
			expect.any(AbortSignal),
		);
		expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
		expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		const headless = await f.open({ client: undefined });
		await expect(headless.prompt(testPrompt())).resolves.toBe("refused");
	});

	it("asks for every MCP connection, merges Zed by name, and redacts credentials without hiding ordinary argv", async () => {
		const f = fixture();
		const configured = {
			name: "local",
			command: "configured-executable",
			args: ["--token", "private-argument", "public-package"],
			env: [{ name: "TOKEN", value: "private-env" }],
		};
		const remote = {
			type: "http" as const,
			name: "remote",
			url: "https://mcp.invalid/private-path?token=private-query",
			headers: [{ name: "Authorization", value: "private-header" }],
		};
		const supplied = { ...configured, command: "zed-executable" };
		f.deps.loadMcpConfig.mockResolvedValue([configured, remote]);
		const session = await f.open({ mcpServers: [supplied] });
		await session.prompt(testPrompt());
		expect(f.requestPermission).toHaveBeenCalledTimes(3);
		expect(f.deps.connectMcpTools).toHaveBeenCalledWith(
			[supplied, remote],
			expect.objectContaining({ cwd: CWD }),
		);
		const permissions = JSON.stringify(f.requestPermission.mock.calls);
		expect(permissions).toContain("zed-executable");
		expect(permissions).toContain("public-package");
		expect(permissions).toContain("UNSANDBOXED host execution");
		expect(permissions).toContain("https://mcp.invalid");
		for (const secret of [
			"private-argument",
			"private-env",
			"private-header",
			"private-query",
			"private-path",
			"configured-executable",
		]) {
			expect(permissions).not.toContain(secret);
			expect(JSON.stringify(session.snapshot!())).not.toContain(secret);
		}
		await session.prompt(testPrompt());
		expect(f.requestPermission).toHaveBeenCalledTimes(3);
	});

	it("launches nothing if any connection is denied, even after approving an earlier server", async () => {
		const f = fixture();
		f.deps.loadMcpConfig.mockResolvedValue(
			["one", "two"].map((name) => ({
				name,
				command: name,
				args: [],
				env: [],
			})),
		);
		f.requestPermission
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const session = await f.open();
		await expect(session.prompt(testPrompt())).resolves.toBe("refused");
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
		expect(f.turns).toHaveLength(0);
	});

	it("uses canonical roots and unwraps resource text instead of returning an object to the adapter", async () => {
		const f = fixture();
		const cwd = resolve("native-canonical-workspace");
		const extra = resolve("native-additional-workspace");
		f.deps.realpath.mockImplementation(async (path) =>
			path === CWD ? cwd : path,
		);
		f.deps.loadAgentResources.mockResolvedValue({
			...f.resources,
			vaultRoot: join(cwd, ".agents", "vault"),
		});
		const session = await f.open({ additionalDirectories: [extra] });
		await session.prompt(testPrompt());
		expect(f.deps.createWorkspaceTools).toHaveBeenCalledWith({
			cwd,
			additionalDirectories: [extra],
		});
		const [{ options }] = f.turns;
		const { signal } = new AbortController();
		await expect(
			options.resolveResource!(
				{ type: "resource_link", uri: "file:///file.txt", name: "file" },
				{ cwd: "/untrusted-context", signal },
			),
		).resolves.toBe("Resolved resource text");
		expect(f.deps.resolveWorkspaceResource).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ cwd, roots: [cwd, extra], signal }),
		);
	});

	it("uses neutral routing, declared role prompts, capability filtering, reports, and current routing selection", async () => {
		const f = fixture();
		const session = await f.open();
		await session.prompt(testPrompt());
		const router = f.turns[0].options;
		expect(router.systemPrompt).toContain("/design");
		expect(router.systemPrompt).toContain("/delegate");
		expect(router.systemPrompt).toContain("/develop");
		expect(router.systemPrompt).toContain("/summarize");
		expect(router.systemPrompt).toContain("Loaded custom system prompt.");
		expect(router.systemPrompt).not.toContain("LEGACY PERSONA");
		await session.setConfig!("model", nativeModelKey(MODEL_A));
		await session.setConfig!("thought_level", "high");
		await session.prompt(testPrompt("/design a thing"));
		const child = f.turns[1].options;
		expect(child.model.id).toBe("first");
		expect(child.thinkingLevel).toBe("high");
		expect(child.systemPrompt).toContain("Declared designer persona.");
		expect(child.systemPrompt).toContain("Pinned workspace instructions.");
		expect(child.systemPrompt).toContain(f.resources.vaultRoot);
		expect(child.systemPrompt).toContain(f.resources.skills[0].path);
		expect(child.systemPrompt).toContain("Skill description");
		expect(child.systemPrompt).toContain("MUST call d3r_report exactly once");
		expect(child.tools?.map(({ name }) => name)).toEqual([
			"read_file",
			"write_file",
			"list_directory",
			"search",
			"read_skill",
			"d3r_report",
		]);
		expect(
			child.tools?.find(({ name }) => name === "write_file")?.permission,
		).toBe("ask");
		expect(
			parseNativeCheckpoint(session.snapshot!()).inner?.engine?.status,
		).toBe("completed");
		expect(f.disposals).toHaveLength(1);
	});

	it("restores resource and model pins synchronously, without granting trust or creating runtime/MCP effects", async () => {
		const f = fixture();
		const first = await f.open();
		await first.prompt(testPrompt());
		const checkpoint = first.snapshot!();
		await first.dispose();
		f.deps.loadAgentResources.mockResolvedValue({
			...f.resources,
			instructions: "CHANGED workspace instructions",
			agents: f.resources.agents.map((agent) => ({
				...agent,
				prompt: "CHANGED persona",
			})),
			workflow: {
				...f.resources.workflow,
				commands: {
					design: {
						...f.resources.workflow.commands.design,
						description: "CHANGED command",
					},
				},
			},
		});
		const loaded = await f.open();
		const before = f.deps.createEmbeddedRuntime.mock.calls.length;
		const permissions = f.requestPermission.mock.calls.length;
		const mcp = f.deps.connectMcpTools.mock.calls.length;
		expect(loaded.restore!(checkpoint)).toBeUndefined();
		expect(loaded.getCommands?.()).toEqual([
			{ name: "design", description: "Design" },
		]);
		expect(f.deps.createEmbeddedRuntime).toHaveBeenCalledTimes(before);
		expect(f.deps.connectMcpTools).toHaveBeenCalledTimes(mcp);
		expect(f.requestPermission).toHaveBeenCalledTimes(permissions);
		await loaded.setConfig!("model", nativeModelKey(MODEL_A));
		await loaded.prompt(testPrompt("/design from saved resources"));
		expect(f.requestPermission).toHaveBeenCalledTimes(permissions + 1);
		const child = f.turns.at(-1)!.options;
		expect(child.systemPrompt).toContain("Pinned workspace instructions.");
		expect(child.systemPrompt).not.toContain("CHANGED");
		expect(child.model.id).toBe("first");
		expect(
			parseNativeCheckpoint(loaded.snapshot!()).resources.instructions,
		).toBe("Pinned workspace instructions.");
	});

	it("rejects corrupt snapshots atomically without invoking getters or widening workspace roots", async () => {
		const f = fixture();
		const session = await f.open();
		const checkpoint = parseNativeCheckpoint(session.snapshot!());
		const getter = vi.fn(() => "secret");
		const accessor = { ...checkpoint };
		Object.defineProperty(accessor, "selection", { get: getter });
		const cyclic: Record<string, unknown> = { ...checkpoint };
		cyclic.inner = cyclic;
		const invalid = [
			{ ...checkpoint, trusted: true },
			{ ...checkpoint, mcpServers: [] },
			{
				...checkpoint,
				selection: { model: "offline/missing", thinking: "off" },
			},
			{
				...checkpoint,
				resources: {
					...checkpoint.resources,
					vaultRoot: resolve("outside-vault"),
				},
			},
			{
				...checkpoint,
				sources: {
					...checkpoint.sources,
					additionalDirectories: [resolve("outside-root")],
				},
			},
			{ ...checkpoint, phase: "missing-phase" },
			accessor,
			cyclic,
		];
		invalid.forEach((value) => expect(() => session.restore!(value)).toThrow());
		expect(getter).not.toHaveBeenCalled();
		expect(session.snapshot!()).toEqual(checkpoint);
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
	});

	it("cancels pending permission on dispose and waits for cooperative settlement", async () => {
		const f = fixture();
		let release: (() => void) | undefined = undefined;
		const requestPermission = vi.fn(async (_request, _signal: AbortSignal) => {
			await new Promise<void>((done) => {
				release = done;
			});
			return true;
		});
		const session = await f.open({ client: { requestPermission } });
		const prompt = session.prompt(testPrompt());
		await vi.waitFor(() => expect(requestPermission).toHaveBeenCalled());
		let settled = false;
		const disposal = session.dispose().then(() => {
			settled = true;
		});
		expect(requestPermission.mock.calls[0][1].aborted).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		release!();
		await expect(prompt).resolves.toBe("cancelled");
		await disposal;
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
	});

	it("cleans up late MCP setup after cancellation before constructing a runtime", async () => {
		const f = fixture();
		let release: (() => void) | undefined = undefined;
		const dispose = vi.fn(async () => {});
		f.deps.connectMcpTools.mockImplementation(async () => {
			await new Promise<void>((done) => {
				release = done;
			});
			return { tools: [], dispose };
		});
		const session = await f.open();
		const prompt = session.prompt(testPrompt());
		await vi.waitFor(() => expect(f.deps.connectMcpTools).toHaveBeenCalled());
		const disposal = session.dispose();
		release!();
		await expect(prompt).resolves.toBe("cancelled");
		await disposal;
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
	});

	it("rolls back the routing runtime and MCP connection if workflow composition fails", async () => {
		const f = fixture();
		const dispose = vi.fn(async () => {});
		f.deps.connectMcpTools.mockResolvedValue({ tools: [], dispose });
		f.deps.createWorkflowRuntime.mockImplementation(() => {
			throw new Error("setup error with private provider details");
		});
		const session = await f.open();
		await expect(session.prompt(testPrompt())).rejects.toThrow(
			"Unable to initialize native session",
		);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(f.disposals).toHaveLength(1);
		expect(parseNativeCheckpoint(session.snapshot!()).inner).toBeNull();
	});

	it("does not bind established MCP connections to a completed prompt's cancellation signal", async () => {
		const f = fixture();
		const controller = new AbortController();
		const session = await f.open();
		await session.prompt(testPrompt("first", { signal: controller.signal }));
		const connectionSignal = f.deps.connectMcpTools.mock.calls[0][1]?.signal;
		controller.abort();
		expect(connectionSignal?.aborted).toBe(false);
		await expect(session.prompt(testPrompt("second"))).resolves.toBe(
			"completed",
		);
		await session.dispose();
		expect(connectionSignal?.aborted).toBe(true);
	});
});
