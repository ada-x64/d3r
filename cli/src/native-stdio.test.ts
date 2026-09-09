/* oxlint-disable no-magic-numbers -- Wire protocol versions, counters and split positions are test data. */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runNativeStdio, type NativeServerDeps } from "@d3r/adapter-acp/server";
import { describe, expect, it, vi } from "vitest";
import {
	CWD,
	MODEL_A,
	MODEL_B,
	chosenModel,
	nativeFixture,
} from "./native-test-support.ts";
import { loadMcpConfig } from "./mcp.ts";
import { parseNativeCheckpoint } from "./native-resources.ts";

/** Minimal raw JSON-RPC frames keep this test independent of a direct CLI SDK dependency. */
interface Frame {
	id?: string | number;
	method?: string;
	params?: {
		sessionId?: string;
		toolCall?: { title?: string };
		options?: { kind: string; optionId: string }[];
	};
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}
/** Real adapter and NDJSON framing over memory streams; no process or network listener is started. */
const stdioPeer = (deps: NativeServerDeps) => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const signals = new EventEmitter();
	const frames: Frame[] = [];
	let buffer = "";
	let sequence = 0;
	let allow: boolean | ((frame: Frame) => boolean) = true;
	const knownSessions = new Set<string>();
	stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const frame = JSON.parse(buffer.slice(0, newline)) as Frame;
			buffer = buffer.slice(newline + 1);
			frames.push(frame);
			if (frame.method === "session/request_permission") {
				const kind =
					(typeof allow === "boolean" ? allow : allow(frame)) &&
					knownSessions.has(frame.params?.sessionId ?? "")
						? "allow_once"
						: "reject_once";
				const option = frame.params?.options?.find(
					(entry) => entry.kind === kind,
				);
				stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "selected", optionId: option?.optionId } } })}\n`,
				);
			}
			newline = buffer.indexOf("\n");
		}
	});
	const running = runNativeStdio({ ...deps, stdin, stdout, signals });
	const send = (method: string, params: unknown, id?: string) => {
		const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		stdin.write(frame.slice(0, 7));
		stdin.write(frame.slice(7));
	};
	const request = async (method: string, params: unknown): Promise<Frame> => {
		const id = `native-client-${++sequence}`;
		send(method, params, id);
		await vi.waitFor(() =>
			expect(
				frames.some(
					(frame) => frame.id === id && (frame.result || frame.error),
				),
			).toBe(true),
		);
		return frames.find((frame) => frame.id === id)!;
	};
	return {
		frames,
		knownSessions,
		running,
		send,
		request,
		setAllowed: (value: boolean | ((frame: Frame) => boolean)) => {
			allow = value;
		},
		close: async () => {
			stdin.end();
			return running;
		},
		stop: async () => {
			signals.emit("SIGTERM");
			await running;
		},
	};
};

/** Setup guidance must reach visible assistant text, not just an error or a tool update. */
const expectAgentGuidance = (
	frames: readonly Frame[],
	sessionId: string,
	text: RegExp,
) => {
	expect(frames).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				method: "session/update",
				params: expect.objectContaining({
					sessionId,
					update: expect.objectContaining({
						sessionUpdate: "agent_message_chunk",
						content: expect.objectContaining({
							type: "text",
							text: expect.stringMatching(text),
						}),
					}),
				}),
			}),
		]),
	);
};

/** Native composition is exercised through actual ACP request dispatch and persistence. */
describe("native deps through ACP stdio", () => {
	// oxlint-disable-next-line max-statements -- Keep the end-to-end open/select/prompt/reload protocol sequence together.
	it("initializes, opens inertly, selects a model, prompts after trust, reloads without saved trust, and closes", async () => {
		const f = nativeFixture();
		f.deps.loadModelConfig.mockResolvedValue({
			ok: true,
			value: { config: { presets: [], defaultPreset: null }, sources: [] },
		});
		const peer = stdioPeer(await f.server());
		try {
			const initialized = await peer.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { auth: { terminal: true } },
			});
			expect(initialized.result).toMatchObject({
				agentInfo: { name: "d3r", version: "native-test" },
				authMethods: [
					{ id: "d3r-login", type: "terminal", args: ["--terminal-login"] },
				],
			});
			const opened = await peer.request("session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			expect(opened.error).toBeUndefined();
			const sessionId = String(opened.result?.sessionId);
			peer.knownSessions.add(sessionId);
			expect(opened.result?.configOptions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "model",
						currentValue: "select-model",
					}),
				]),
			);
			expect(
				peer.frames.filter(
					(frame) => frame.method === "session/request_permission",
				),
			).toHaveLength(0);
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
			const unselected = await peer.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Hi! tell me about yourself." }],
			});
			expect(unselected.result).toEqual({ stopReason: "end_turn" });
			expectAgentGuidance(
				peer.frames,
				sessionId,
				/Select a model in Zed's Model picker/,
			);
			expectAgentGuidance(peer.frames, sessionId, /No model request/);
			expectAgentGuidance(peer.frames, sessionId, /MCP connection/);
			expect(
				peer.frames.filter(
					(frame) => frame.method === "session/request_permission",
				),
			).toHaveLength(0);
			expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
			expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
			expect(f.models.streamSimple).not.toHaveBeenCalled();
			expect(f.turns).toHaveLength(0);
			const configured = await peer.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: chosenModel,
			});
			expect(configured.error).toBeUndefined();
			const prompt = await peer.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Hi! tell me about yourself." }],
			});
			expect(prompt.result).toEqual({ stopReason: "end_turn" });
			expect(f.turns).toHaveLength(1);
			expect(f.turns[0].options.model.id).toBe("second");
			expect(f.models.getAvailable.mock.calls[0][1]?.signal).toBeInstanceOf(
				AbortSignal,
			);
			expect(
				peer.frames.filter(
					(frame) => frame.method === "session/request_permission",
				),
			).toHaveLength(1);
			await expect(
				peer.request("session/close", { sessionId }),
			).resolves.not.toHaveProperty("error");
			const restored = await peer.request("session/load", {
				sessionId,
				cwd: CWD,
				mcpServers: [],
			});
			expect(restored.error).toBeUndefined();
			expect(f.turns).toHaveLength(1);
			expect(
				peer.frames.filter(
					(frame) => frame.method === "session/request_permission",
				),
			).toHaveLength(1);
			await expect(
				peer.request("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "hello again" }],
				}),
			).resolves.toMatchObject({ result: { stopReason: "end_turn" } });
			expect(
				peer.frames.filter(
					(frame) => frame.method === "session/request_permission",
				),
			).toHaveLength(2);
			expect(f.models.streamSimple).not.toHaveBeenCalled();
			await expect(peer.close()).resolves.toBe(0);
			expect(f.disposals).toHaveLength(2);
		} finally {
			await peer.stop();
		}
	});

	// oxlint-disable-next-line max-statements -- Exercise real MCP env-reference loading through ACP persistence and reload.
	it("preserves checkpoint identity and roots with benign short headers and HOME/settings env references", async () => {
		const root = await mkdtemp(join(tmpdir(), "native-settings-"));
		const home = join(root, "home");
		const cwd = join(root, "workspace");
		const f = nativeFixture();
		const observedSecrets: string[] = [];
		try {
			await Promise.all([
				mkdir(join(home, ".agents"), { recursive: true }),
				mkdir(cwd),
			]);
			await writeFile(
				join(home, ".agents", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						configured: {
							command: "node",
							args: ["server.js", "--", "--token", { env: "HOME" }],
							env: {
								HOME: { env: "HOME" },
								TOKEN_LIMIT: { env: "TOKEN_LIMIT" },
								PASSWORD_FILE: { env: "PASSWORD_FILE" },
								API_TOKEN: { env: "API_TOKEN" },
							},
						},
						configuredHttp: {
							type: "http",
							url: "https://mcp.invalid",
							headers: { "X-Mode": { env: "MODE" } },
						},
					},
				}),
			);
			f.deps.loadAgentResources.mockImplementation(async (roots) => ({
				...f.resources,
				skills: [],
				vaultRoot: join(roots.cwd, ".agents", "vault"),
			}));
			const deps = await f.server(
				{ home },
				{
					loadMcpConfig: (roots, options) =>
						loadMcpConfig(roots, {
							...options,
							environment: {
								HOME: home,
								TOKEN_LIMIT: "1",
								PASSWORD_FILE: "a",
								MODE: "a",
								API_TOKEN: "actual-credential",
							},
							onSecrets: (values) => {
								observedSecrets.push(...values);
								options?.onSecrets?.(values);
							},
						}),
				},
			);
			const peer = stdioPeer(deps);
			try {
				await peer.request("initialize", { protocolVersion: 1 });
				const opened = await peer.request("session/new", {
					cwd,
					mcpServers: [
						{
							name: "positional",
							command: process.execPath,
							args: ["server.js", "--", "--token", home, "--token=a"],
							env: [],
						},
						{
							name: "suppliedHttp",
							type: "http",
							url: "https://mcp.invalid",
							headers: [{ name: "X-Mode", value: "a" }],
						},
					],
				});
				expect(opened.error).toBeUndefined();
				const sessionId = String(opened.result?.sessionId);
				peer.knownSessions.add(sessionId);
				await expect(
					peer.request("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text: "a benign setting" }],
					}),
				).resolves.toMatchObject({ result: { stopReason: "end_turn" } });
				expect(observedSecrets).toContain("actual-credential");
				[home, "a", "1"].forEach((value) =>
					expect(observedSecrets).not.toContain(value),
				);
				const stored = await f.store.get(sessionId);
				const last = stored?.records.at(-1);
				if (last?.kind !== "checkpoint") {
					throw new Error("Missing persisted checkpoint");
				}
				const checkpoint = parseNativeCheckpoint(
					(last.state as { runtime: unknown }).runtime,
				);
				expect(checkpoint.format).toBe("d3r.native");
				expect(checkpoint.sources.home).toBe(home);
				expect(checkpoint.sources.cwd).toBe(cwd);
				await peer.request("session/close", { sessionId });
				await expect(
					peer.request("session/load", { sessionId, cwd, mcpServers: [] }),
				).resolves.not.toHaveProperty("error");
				await expect(
					peer.request("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text: "continue" }],
					}),
				).resolves.toMatchObject({ result: { stopReason: "end_turn" } });
			} finally {
				await peer.stop();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails unavailable-model restore preflight without appending an intent or poisoning the saved session", async () => {
		const f = nativeFixture();
		const peer = stdioPeer(await f.server());
		try {
			await peer.request("initialize", { protocolVersion: 1 });
			const opened = await peer.request("session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			const sessionId = String(opened.result?.sessionId);
			await peer.request("session/close", { sessionId });
			const before = await f.store.get(sessionId);
			f.models.getAvailable.mockResolvedValue([MODEL_A]);
			f.deps.loadModelConfig.mockResolvedValue({
				ok: true,
				value: { config: { presets: [], defaultPreset: null }, sources: [] },
			});
			const failed = await peer.request("session/load", {
				sessionId,
				cwd: CWD,
				mcpServers: [],
			});
			expect(failed.error).toBeDefined();
			await expect(f.store.get(sessionId)).resolves.toEqual(before);
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
			f.models.getAvailable.mockResolvedValue([MODEL_A, MODEL_B]);
			await expect(
				peer.request("session/load", { sessionId, cwd: CWD, mcpServers: [] }),
			).resolves.not.toHaveProperty("error");
		} finally {
			await peer.stop();
		}
	});

	it("registers configured MCP secrets before echoed content reaches persisted checkpoints or replay", async () => {
		const f = nativeFixture();
		const secret = "configured-mcp-echo-credential";
		f.deps.loadMcpConfig.mockImplementation(async (_roots, options) => {
			options?.onSecrets?.([secret]);
			return [
				{
					name: "configured",
					command: "node",
					args: ["--token", secret],
					env: [],
				},
			];
		});
		f.onTurn.mockImplementation(async ({ request, runtime }) => {
			const checkpoint = runtime.snapshot!() as Record<string, unknown>;
			runtime.restore!({
				...checkpoint,
				messages: [{ role: "user", content: secret, timestamp: 0 }],
			});
			await request.emit({ kind: "text", messageId: "echo", text: secret });
			await request.activity?.({
				kind: "tool",
				toolCallId: "echo-tool",
				title: "Echo MCP",
				toolKind: "other",
				status: "completed",
				rawOutput: { text: secret },
			});
		});
		const peer = stdioPeer(await f.server());
		try {
			await peer.request("initialize", { protocolVersion: 1 });
			const opened = await peer.request("session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			const sessionId = String(opened.result?.sessionId);
			peer.knownSessions.add(sessionId);
			await expect(
				peer.request("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "echo" }],
				}),
			).resolves.toMatchObject({ result: { stopReason: "end_turn" } });
			const stored = await f.store.get(sessionId);
			expect(stored).not.toBeNull();
			expect(JSON.stringify(stored)).not.toContain(secret);
			await peer.request("session/close", { sessionId });
			const replayStart = peer.frames.length;
			await expect(
				peer.request("session/load", { sessionId, cwd: CWD, mcpServers: [] }),
			).resolves.not.toHaveProperty("error");
			expect(JSON.stringify(peer.frames.slice(replayStart))).not.toContain(
				secret,
			);
		} finally {
			await peer.stop();
		}
	});

	it("advertises logout, disposes sessions and prevents ambient credentials reopening one on the same connection", async () => {
		const f = nativeFixture();
		const peer = stdioPeer(await f.server());
		try {
			const initialized = await peer.request("initialize", {
				protocolVersion: 1,
			});
			expect(initialized.result).toMatchObject({
				agentCapabilities: { auth: { logout: {} } },
			});
			const opened = await peer.request("session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			const sessionId = String(opened.result?.sessionId);
			peer.knownSessions.add(sessionId);
			await peer.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "hello" }],
			});
			await expect(peer.request("logout", {})).resolves.not.toHaveProperty(
				"error",
			);
			expect(f.disposals).toHaveLength(1);
			expect(f.models.logout.mock.calls).toEqual([
				["offline"],
				["other-offline"],
			]);
			const afterLogout = await peer.request("session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			expect(afterLogout.error?.code).toBe(-32_000);
			expect(f.models.getAvailable).toHaveBeenCalledTimes(1);
		} finally {
			await peer.stop();
		}
	});

	it("maps an empty usable catalog to ACP auth-required, without login or model setup", async () => {
		const f = nativeFixture();
		f.models.getAvailable.mockResolvedValue([]);
		const peer = stdioPeer(await f.server());
		try {
			await peer.request("initialize", { protocolVersion: 1 });
			const opened = await peer.request("session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			expect(opened.error?.code).toBe(-32_000);
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
			expect(
				peer.frames.filter(
					(frame) => frame.method === "session/request_permission",
				),
			).toHaveLength(0);
		} finally {
			await peer.stop();
		}
	});

	it.each([
		{ permission: "workspace", guidance: /workspace permission.*not granted/i },
		{ permission: "MCP connection", guidance: /MCP connection permission/i },
	])(
		"completes $permission denial with visible guidance and connects only after approval on a same-session retry",
		async ({ permission, guidance }) => {
			const f = nativeFixture();
			const peer = stdioPeer(await f.server());
			peer.setAllowed(
				permission === "workspace"
					? false
					: (frame) =>
							!frame.params?.toolCall?.title?.startsWith("Connect MCP "),
			);
			try {
				await peer.request("initialize", { protocolVersion: 1 });
				const opened = await peer.request("session/new", {
					cwd: CWD,
					mcpServers: [
						{ name: "danger", command: `${CWD}/executable`, args: [], env: [] },
					],
				});
				expect(opened.error).toBeUndefined();
				const sessionId = String(opened.result?.sessionId);
				peer.knownSessions.add(sessionId);
				await expect(
					peer.request("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text: "Hi! tell me about yourself." }],
					}),
				).resolves.toMatchObject({ result: { stopReason: "end_turn" } });
				expectAgentGuidance(peer.frames, sessionId, guidance);
				expectAgentGuidance(peer.frames, sessionId, /retry/i);
				expectAgentGuidance(peer.frames, sessionId, /No model request/i);
				expect(
					peer.frames.filter(
						(frame) => frame.method === "session/request_permission",
					),
				).toHaveLength(permission === "workspace" ? 1 : 2);
				if (permission === "workspace") {
					expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
				}
				expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
				expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
				expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
				expect(f.models.streamSimple).not.toHaveBeenCalled();
				expect(f.turns).toHaveLength(0);
				peer.setAllowed(true);
				await expect(
					peer.request("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text: "Hi! tell me about yourself." }],
					}),
				).resolves.toMatchObject({ result: { stopReason: "end_turn" } });
				expect(
					peer.frames.filter(
						(frame) => frame.method === "session/request_permission",
					),
				).toHaveLength(permission === "workspace" ? 3 : 4);
				expect(f.deps.connectMcpTools).toHaveBeenCalledTimes(1);
				expect(f.deps.connectMcpTools).toHaveBeenCalledWith(
					[{ name: "danger", command: `${CWD}/executable`, args: [], env: [] }],
					expect.objectContaining({ cwd: CWD }),
				);
				expect(f.turns).toHaveLength(1);
			} finally {
				await peer.stop();
			}
		},
	);

	it("cancels a native prompt through ACP and disposes its runtime on transport shutdown", async () => {
		const f = nativeFixture();
		f.onTurn.mockImplementation(async ({ request }) => {
			await new Promise<void>((done) =>
				request.signal.addEventListener("abort", () => done(), { once: true }),
			);
		});
		const peer = stdioPeer(await f.server());
		try {
			await peer.request("initialize", { protocolVersion: 1 });
			const opened = await peer.request("session/new", {
				cwd: CWD,
				mcpServers: [],
			});
			const sessionId = String(opened.result?.sessionId);
			peer.knownSessions.add(sessionId);
			const pending = peer.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "wait" }],
			});
			await vi.waitFor(() => expect(f.turns).toHaveLength(1));
			peer.send("session/cancel", { sessionId });
			await expect(pending).resolves.toMatchObject({
				result: { stopReason: "cancelled" },
			});
			await expect(peer.close()).resolves.toBe(0);
			expect(f.disposals).toHaveLength(1);
		} finally {
			await peer.stop();
		}
	});
});
