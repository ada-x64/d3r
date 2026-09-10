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

/** Phase controls belong only to the persistent router, never to delegated workers. */
const PHASE_TOOLS = [
	"d3r_start_phase",
	"d3r_continue_phase",
	"d3r_abandon_phase",
	"d3r_phase_status",
];

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

	it("completes with model-selection guidance and stays inert until a same-session retry", async () => {
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
		const prompt = testPrompt("Hi! tell me about yourself.");
		await expect(session.prompt(prompt)).resolves.toBe("completed");
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "text",
				text: expect.stringContaining("Select a model in Zed's Model picker"),
			}),
		);
		expect(f.models.getAvailable).toHaveBeenCalledTimes(1);
		expect(f.models.streamSimple).not.toHaveBeenCalled();
		expect(f.requestPermission).not.toHaveBeenCalled();
		expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
		expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		expect(f.turns).toHaveLength(0);
		expect(parseNativeCheckpoint(session.snapshot!()).inner).toBeNull();
		await session.setConfig!("model", chosenModel);
		expect(f.requestPermission).not.toHaveBeenCalled();
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		await expect(session.prompt(testPrompt())).resolves.toBe("completed");
		expect(f.requestPermission).toHaveBeenCalledTimes(1);
		expect(f.turns).toHaveLength(1);
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

	it("keeps metadata inert and completes workspace denial with guidance before a same-session retry", async () => {
		const f = fixture();
		f.requestPermission.mockResolvedValue(false);
		const session = await f.open();
		session.snapshot!();
		session.getConfig!();
		await session.setConfig!("thought_level", "low");
		expect(f.requestPermission).not.toHaveBeenCalled();
		const prompt = testPrompt();
		await expect(session.prompt(prompt)).resolves.toBe("completed");
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "text",
				text: expect.stringMatching(/workspace permission.*not granted/i),
			}),
		);
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringMatching(/retry/i) }),
		);
		expect(f.requestPermission).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCallId: expect.stringMatching(/^d3r:permission:/),
				title: expect.stringContaining(CWD),
				input: expect.objectContaining({ cwd: CWD }),
			}),
			expect.any(AbortSignal),
		);
		expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
		expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		expect(f.models.streamSimple).not.toHaveBeenCalled();
		expect(f.turns).toHaveLength(0);
		expect(parseNativeCheckpoint(session.snapshot!()).inner).toBeNull();
		f.requestPermission.mockResolvedValue(true);
		await expect(session.prompt(testPrompt())).resolves.toBe("completed");
		expect(f.requestPermission).toHaveBeenCalledTimes(2);
		expect(f.deps.connectMcpTools).toHaveBeenCalledTimes(1);
		expect(f.turns).toHaveLength(1);
	});

	it("completes with workspace permission guidance and stays inert when no client can approve", async () => {
		const f = fixture();
		const session = await f.open({ client: undefined });
		const prompt = testPrompt();
		await expect(session.prompt(prompt)).resolves.toBe("completed");
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "text",
				text: expect.stringMatching(/workspace permission.*not granted/i),
			}),
		);
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringMatching(/retry/i) }),
		);
		expect(f.requestPermission).not.toHaveBeenCalled();
		expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
		expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		expect(f.models.streamSimple).not.toHaveBeenCalled();
		expect(f.turns).toHaveLength(0);
		expect(parseNativeCheckpoint(session.snapshot!()).inner).toBeNull();
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

	it("completes MCP denial with guidance, launching nothing until every connection is approved on retry", async () => {
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
		const prompt = testPrompt();
		await expect(session.prompt(prompt)).resolves.toBe("completed");
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "text",
				text: expect.stringMatching(/MCP connection permission/i),
			}),
		);
		expect(prompt.emit).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringMatching(/retry/i) }),
		);
		expect(f.requestPermission).toHaveBeenCalledTimes(3);
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
		expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
		expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		expect(f.models.streamSimple).not.toHaveBeenCalled();
		expect(f.turns).toHaveLength(0);
		expect(parseNativeCheckpoint(session.snapshot!()).inner).toBeNull();
		await expect(session.prompt(testPrompt())).resolves.toBe("completed");
		expect(f.requestPermission).toHaveBeenCalledTimes(6);
		expect(f.deps.connectMcpTools).toHaveBeenCalledTimes(1);
		expect(
			f.deps.connectMcpTools.mock.calls[0][0].map(({ name }) => name),
		).toEqual(["one", "two"]);
		expect(f.turns).toHaveLength(1);
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
			excludedDirectories: [join(HOME, ".agents", "d3r", "private")],
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

	it("keeps a persistent neutral router with isolated, capability-filtered workers and current selection", async () => {
		const f = fixture();
		const session = await f.open();
		await session.prompt(testPrompt());
		const router = f.turns[0].options;
		[
			"/design",
			"/delegate",
			"/develop",
			"/summarize",
			"Loaded custom system prompt.",
		].forEach((text) => expect(router.systemPrompt).toContain(text));
		expect(router.systemPrompt).not.toContain("LEGACY PERSONA");
		expect(router.tools?.map(({ name }) => name)).toEqual(
			expect.arrayContaining(PHASE_TOOLS),
		);
		expect(router.tools?.map(({ name }) => name)).not.toContain("d3r_report");
		expect(f.deps.createWorkflowRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ orchestrated: true }),
		);
		await session.setConfig!("model", nativeModelKey(MODEL_A));
		await session.setConfig!("thought_level", "high");
		await session.prompt(testPrompt("/design a thing"));
		expect(f.turns.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"routing",
			"designer",
		]);
		expect(f.turns[1].runtime).toBe(f.turns[0].runtime);
		expect(f.turns[1].runtime.getConfig?.()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "model",
					value: nativeModelKey(MODEL_A),
				}),
				expect.objectContaining({ id: "thought_level", value: "high" }),
			]),
		);
		const child = f.turns[2].options;
		expect(child.model.id).toBe("first");
		expect(child.thinkingLevel).toBe("high");
		[
			"Declared designer persona.",
			"Pinned workspace instructions.",
			f.resources.vaultRoot,
			f.resources.skills[0].path,
			"Skill description",
			"MUST call d3r_report exactly once",
		].forEach((text) => expect(child.systemPrompt).toContain(text));
		expect(new Set(child.tools?.map(({ name }) => name))).toEqual(
			new Set([
				"read_file",
				"write_file",
				"list_directory",
				"search",
				"read_skill",
				"vault_read",
				"vault_ls",
				"vault_find",
				"vault_lint",
				"vault_write",
				"vault_mv",
				"vault_rm",
				"d3r_report",
			]),
		);
		expect(
			child.tools?.filter(({ name }) => PHASE_TOOLS.includes(name)),
		).toEqual([]);
		expect(
			child.tools?.find(({ name }) => name === "write_file")?.permission,
		).toBe("ask");
		expect(parseNativeCheckpoint(session.snapshot!()).inner).toMatchObject({
			orchestrated: true,
			engine: { status: "completed" },
		});
		expect(f.deps.createEmbeddedRuntime).toHaveBeenCalledTimes(2);
		expect(f.disposals).toEqual([f.turns[2].runtime]);
		await session.dispose();
		expect(f.disposals).toEqual([f.turns[2].runtime, f.turns[0].runtime]);
	});

	it("hands conversation context to workers without requiring formal vault documents", async () => {
		const f = fixture();
		const session = await f.open();
		const discussion =
			"Search keeps running after cancellation; keep the existing API.";
		await session.prompt(testPrompt(discussion));
		const router = f.turns[0].options;
		const start = vi.spyOn(
			router.tools!.find(({ name }) => name === "d3r_start_phase")!,
			"execute",
		);
		await session.prompt(testPrompt("/design Fix search cancellation"));
		expect(start).toHaveBeenCalledExactlyOnceWith(
			{
				phase: "design",
				brief: {
					goal: "Fix search cancellation",
					context: expect.stringContaining(discussion),
					acceptanceCriteria: [
						"Complete the requested phase and report the outcome.",
					],
					constraints: [],
				},
			},
			expect.objectContaining({ cwd: CWD, roots: [CWD] }),
		);
		expect(router.systemPrompt).toContain(
			"No prior phase or formal vault documents are required",
		);
		expect(router.systemPrompt).toContain("never fabricate citations");
		const child = f.turns.find(
			({ options }) => options.budgetLabel === "designer",
		)!;
		expect(child.options.systemPrompt).toContain(
			"conversation brief intentionally substitutes for schema, design, and plan documents",
		);
		expect(child.options.systemPrompt).toContain(
			"Preserve all project constraints, approval requirements, and your assigned role remit",
		);
		expect(child.request.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: expect.stringContaining(discussion) }),
				expect.objectContaining({
					text: expect.stringContaining("## Goal\nFix search cancellation"),
				}),
				expect.objectContaining({
					text: expect.stringContaining("## Acceptance criteria"),
				}),
			]),
		);
		expect(
			parseNativeCheckpoint(session.snapshot!()).inner?.engine?.status,
		).toBe("completed");
	});

	it("returns the phase response from the same router after its tool finishes, without a summary runtime or replay", async () => {
		const f = fixture();
		const session = await f.open();
		await session.prompt(testPrompt());
		const [router] = f.turns;
		const start = vi.spyOn(
			router.options.tools!.find(({ name }) => name === "d3r_start_phase")!,
			"execute",
		);
		const prompt = testPrompt("/design a thing");
		await session.prompt(prompt);
		expect(f.turns[1].runtime).toBe(router.runtime);
		expect(f.turns[1].request.content).toContainEqual({
			type: "text",
			text: expect.stringMatching(
				/^D3R runtime phase state \(authoritative\):\nNo active workflow/,
			),
		});
		expect(start).toHaveBeenCalledTimes(1);
		await expect(start.mock.results[0].value).resolves.toEqual({
			text: expect.stringMatching(/Status: completed[\s\S]*Role completed/),
		});
		expect(vi.mocked(prompt.emit).mock.calls.map(([chunk]) => chunk)).toEqual([
			expect.objectContaining({
				kind: "text",
				text: "Offline reply",
				parentToolCallId: expect.any(String),
			}),
			{ kind: "text", messageId: "offline-reply", text: "Offline reply" },
		]);
		const checkpoint = parseNativeCheckpoint(session.snapshot!());
		expect(checkpoint.inner).not.toHaveProperty("summary");
		expect(checkpoint.inner?.history.at(-1)).toEqual({
			type: "text",
			text: "Routing response:\nOffline reply",
		});
		await session.prompt(testPrompt("Thanks, what happened?"));
		expect(f.turns.map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"routing",
			"designer",
			"routing",
		]);
		expect(f.turns.at(-1)!.runtime).toBe(router.runtime);
		expect(start).toHaveBeenCalledTimes(1);
		expect(f.deps.createEmbeddedRuntime).toHaveBeenCalledTimes(2);
		expect(f.disposals).toEqual([f.turns[2].runtime]);
	});

	it.each([
		{ failure: "missing report", error: "Missing or invalid d3r_report" },
		{ failure: "execution failure", error: "Role setup or execution failed" },
	])(
		"retains $failure for router discussion without replaying or replacing the worker",
		async ({ failure, error }) => {
			const f = fixture();
			const completeTurn = f.onTurn.getMockImplementation()!;
			f.onTurn.mockImplementation(async (turn) => {
				if (turn.options.budgetLabel !== "designer") {
					await completeTurn(turn);
					return;
				}
				if (failure === "execution failure") {
					throw new Error("private worker failure details");
				}
				await turn.request.emit({
					kind: "text",
					messageId: "prose",
					text: "Prose is not a report",
				});
			});
			const session = await f.open();
			await expect(session.prompt(testPrompt("/design a thing"))).resolves.toBe(
				"completed",
			);
			const blocked = parseNativeCheckpoint(session.snapshot!()).inner!.engine;
			expect(blocked).toMatchObject({
				status: "blocked",
				pause: { kind: "failure", message: expect.stringContaining(error) },
			});
			expect(f.disposals).toEqual([f.turns[1].runtime]);
			await session.prompt(testPrompt("What needs attention?"));
			expect(f.turns.at(-1)!.request.content).toContainEqual({
				type: "text",
				text: expect.stringMatching(
					/^D3R runtime phase state \(authoritative\):[\s\S]*Status: blocked/,
				),
			});
			await session.prompt(testPrompt("/design replacement"));
			expect(parseNativeCheckpoint(session.snapshot!()).inner?.engine).toEqual(
				blocked,
			);
			expect(JSON.stringify(session.snapshot!())).not.toContain(
				"private worker failure details",
			);
			expect(f.turns.map(({ options }) => options.budgetLabel)).toEqual([
				"routing",
				"designer",
				"routing",
				"routing",
			]);
			expect(f.turns.at(-1)!.runtime).toBe(f.turns[0].runtime);
			expect(f.deps.createEmbeddedRuntime).toHaveBeenCalledTimes(2);
			expect(f.disposals).toEqual([f.turns[1].runtime]);
		},
	);

	it("restores resource and model pins synchronously, without granting trust or creating runtime/MCP effects", async () => {
		const f = fixture();
		const first = await f.open();
		await first.setConfig!("thought_level", "high");
		await first.prompt(testPrompt());
		const checkpoint = first.snapshot!();
		expect(parseNativeCheckpoint(checkpoint).inner?.orchestrated).toBe(true);
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
		expect(loaded.getConfig?.()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "model", value: chosenModel }),
				expect.objectContaining({ id: "thought_level", value: "high" }),
			]),
		);
		expect(loaded.getCommands?.()).toEqual([
			{ name: "design", description: "Design" },
		]);
		expect(f.deps.createEmbeddedRuntime).toHaveBeenCalledTimes(before);
		expect(f.deps.connectMcpTools).toHaveBeenCalledTimes(mcp);
		expect(f.requestPermission).toHaveBeenCalledTimes(permissions);
		await loaded.setConfig!("model", nativeModelKey(MODEL_A));
		await loaded.prompt(testPrompt("/design from saved resources"));
		expect(f.requestPermission).toHaveBeenCalledTimes(permissions + 1);
		const child = f.turns.findLast(
			({ options }) => options.budgetLabel === "designer",
		)!.options;
		expect(child.systemPrompt).toContain("Pinned workspace instructions.");
		expect(child.systemPrompt).not.toContain("CHANGED");
		expect(child.model.id).toBe("first");
		expect(child.thinkingLevel).toBe("high");
		expect(parseNativeCheckpoint(loaded.snapshot!()).inner?.orchestrated).toBe(
			true,
		);
		expect(
			parseNativeCheckpoint(loaded.snapshot!()).resources.instructions,
		).toBe("Pinned workspace instructions.");
	});

	// oxlint-disable-next-line max-statements -- Follow a legacy restore through inert setup, direct dispatch, summary, and disposal.
	it("restores an inner checkpoint without an orchestration flag as legacy, including its isolated summary", async () => {
		const f = fixture();
		const first = await f.open();
		await first.prompt(testPrompt());
		const checkpoint = parseNativeCheckpoint(first.snapshot!());
		delete checkpoint.inner!.orchestrated;
		delete checkpoint.inner!.continuations;
		await first.dispose();
		const loaded = await f.open();
		expect(loaded.restore!(checkpoint)).toBeUndefined();
		expect(f.deps.createEmbeddedRuntime).toHaveBeenCalledTimes(1);
		expect(f.deps.connectMcpTools).toHaveBeenCalledTimes(1);
		expect(f.requestPermission).toHaveBeenCalledTimes(1);
		await loaded.prompt(testPrompt());
		expect(f.requestPermission).toHaveBeenCalledTimes(2);
		expect(f.deps.createWorkflowRuntime).toHaveBeenLastCalledWith(
			expect.objectContaining({ orchestrated: false }),
		);
		const [, router] = f.turns;
		expect(
			router.options.tools?.filter(({ name }) => PHASE_TOOLS.includes(name)),
		).toEqual([]);
		expect(router.options.systemPrompt).toContain("native workflow router");
		expect(router.options.systemPrompt).not.toContain("LEGACY PERSONA");
		expect(
			router.request.content.some(
				(item) =>
					item.type === "text" &&
					item.text.startsWith("D3R runtime phase state (authoritative):"),
			),
		).toBe(false);
		await loaded.setConfig!("model", nativeModelKey(MODEL_A));
		await loaded.setConfig!("thought_level", "high");
		await loaded.prompt(testPrompt("/design legacy request"));
		expect(f.turns.slice(1).map(({ options }) => options.budgetLabel)).toEqual([
			"routing",
			"designer",
			"workflow summary",
		]);
		const [child, summary] = f.turns.slice(2);
		expect(child.options.systemPrompt).toContain("Declared designer persona.");
		expect(child.options.systemPrompt).not.toContain(
			"conversation brief intentionally substitutes",
		);
		expect(
			child.options.tools?.filter(({ name }) => PHASE_TOOLS.includes(name)),
		).toEqual([]);
		expect(child.options.model).toEqual(MODEL_A);
		expect(child.options.thinkingLevel).toBe("high");
		expect(summary.options).toMatchObject({
			model: MODEL_A,
			thinkingLevel: "high",
			tools: [],
			maxTurns: 1,
			maxTotalTurns: 1,
		});
		const restored = parseNativeCheckpoint(loaded.snapshot!());
		expect(restored.inner?.engine?.status).toBe("completed");
		expect(restored.inner?.summary).toBe("Offline reply");
		expect(restored.inner).not.toHaveProperty("orchestrated");
		expect(f.disposals).toEqual([
			f.turns[0].runtime,
			child.runtime,
			summary.runtime,
		]);
		await loaded.dispose();
		expect(f.disposals).toEqual([
			f.turns[0].runtime,
			child.runtime,
			summary.runtime,
			router.runtime,
		]);
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
