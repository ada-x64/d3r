/* oxlint-disable no-magic-numbers -- Selector transitions and callback counts are explicit regression expectations. */
import { describe, expect, it, vi } from "vitest";
import { type RuntimePermission } from "@d3r/core/runtime";
import {
	CWD,
	MODEL_A,
	MODEL_B,
	chosenModel,
	nativeFixture,
	testPrompt,
} from "./native-test-support.ts";
import { nativeModelKey } from "./native-models.ts";
import { parseNativeCheckpoint } from "./native-resources.ts";

/** Controllable completion keeps cancellation tests sensitive to settlement rather than only abort notification. */
const gate = () => {
	let release: (() => void) | undefined = undefined;
	const promise = new Promise<void>((done) => {
		release = done;
	});
	return { promise, release: () => release!() };
};

/** Regression cases from independent review exercise real selector validation and injected shell effects. */
describe("native review regressions", () => {
	it.each(["off", "low"])(
		"restores old A/high before applying desired B/%s without an invalid intermediate model",
		async (thinking) => {
			const f = nativeFixture();
			const transitions: string[][] = [];
			const implementation =
				f.deps.createEmbeddedRuntime.getMockImplementation()!;
			f.deps.createEmbeddedRuntime.mockImplementation((options) => (input) => {
				const runtime = implementation(options)(input);
				return {
					...runtime,
					setConfig: async (id, value) => {
						transitions.push([id, value]);
						return runtime.setConfig!(id, value);
					},
				};
			});
			f.models.getAvailable.mockResolvedValue([
				MODEL_A,
				{ ...MODEL_B, thinkingLevelMap: { high: null } },
			]);
			try {
				const first = await f.open();
				await first.setConfig!("model", nativeModelKey(MODEL_A));
				await first.setConfig!("thought_level", "high");
				await first.prompt(testPrompt());
				const checkpoint = first.snapshot!();
				const loaded = await f.open();
				loaded.restore!(checkpoint);
				await loaded.setConfig!("thought_level", thinking);
				await loaded.setConfig!("model", chosenModel);
				transitions.length = 0;
				const wanted = parseNativeCheckpoint(loaded.snapshot!()).selection;
				await expect(
					loaded.prompt(testPrompt("/design resumed")),
				).resolves.toBe("completed");
				expect(transitions).toEqual([
					["thought_level", "off"],
					["model", chosenModel],
					...(thinking === "off" ? [] : [["thought_level", thinking]]),
				]);
				expect(parseNativeCheckpoint(loaded.snapshot!()).selection).toEqual(
					wanted,
				);
				expect(f.turns.at(-1)!.options.model.id).toBe("second");
				expect(f.turns.at(-1)!.options.thinkingLevel).toBe(thinking);
			} finally {
				await f.close();
			}
		},
	);

	it("passes setup cancellation to both resource readers and waits for every started sibling on failure", async () => {
		const f = nativeFixture();
		const modelRead = gate();
		const agentRead = gate();
		const controller = new AbortController();
		const failure = new Error("catalog failed");
		f.models.getAvailable.mockRejectedValue(failure);
		f.deps.loadModelConfig.mockImplementation(async (_roots, options) => {
			expect(options?.signal).toBe(controller.signal);
			await modelRead.promise;
			return { ok: true, value: f.config };
		});
		f.deps.loadAgentResources.mockImplementation(async (_roots, options) => {
			expect(options?.signal).toBe(controller.signal);
			await agentRead.promise;
			return f.resources;
		});
		let settled = false;
		const opening = f
			.open({ signal: controller.signal })
			.catch((error: unknown) => {
				settled = true;
				return error;
			});
		try {
			await vi.waitFor(() =>
				expect(f.deps.loadAgentResources).toHaveBeenCalled(),
			);
			controller.abort();
			expect(settled).toBe(false);
			modelRead.release();
			await Promise.resolve();
			expect(settled).toBe(false);
			agentRead.release();
			await expect(opening).resolves.toBe(failure);
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		} finally {
			modelRead.release();
			agentRead.release();
			await opening;
			await f.close();
		}
	});

	it("settles even a reader started alongside a synchronous discovery throw", async () => {
		const f = nativeFixture();
		const completion = gate();
		f.models.getAvailable.mockImplementation(() => {
			throw new Error("sync catalog failure");
		});
		f.deps.loadAgentResources.mockImplementation(async () => {
			await completion.promise;
			return f.resources;
		});
		let settled = false;
		const opening = f.open().catch(() => {
			settled = true;
		});
		try {
			await vi.waitFor(() =>
				expect(f.deps.loadAgentResources).toHaveBeenCalled(),
			);
			expect(f.deps.loadModelConfig).toHaveBeenCalled();
			expect(settled).toBe(false);
			completion.release();
			await opening;
			expect(settled).toBe(true);
		} finally {
			completion.release();
			await opening;
			await f.close();
		}
	});

	it("shows inline code, packages and executable-affecting environment while binding the unredacted launch config", async () => {
		const f = nativeFixture();
		const secrets: string[] = [];
		const permissions: RuntimePermission[] = [];
		const environment = { PATH: "/host/bin", HOME: "/host/home" };
		const configured = {
			name: "inline",
			command: "node",
			args: [
				"-e",
				"require('fs').writeFileSync('effect', 'data')",
				"--token",
				"resolved-token",
			],
			env: [
				{ name: "NODE_OPTIONS", value: "--require=/workspace/hook.js" },
				{ name: "PATH", value: "/workspace/bin" },
				{ name: "API_KEY", value: "env-credential" },
			],
		};
		f.deps.getMcpEnvironment.mockImplementation(() => environment);
		f.deps.loadMcpConfig.mockImplementation(async (_roots, options) => {
			options?.onSecrets?.(["resolved-token"]);
			return [configured];
		});
		const client = {
			registerSecrets: (values: readonly string[]) => {
				secrets.push(...values);
			},
			requestPermission: async (request: RuntimePermission) => {
				permissions.push(request);
				if (request.title.includes("Connect MCP")) {
					configured.args[1] = "MUTATED CODE";
					configured.env[0].value = "MUTATED ENVIRONMENT";
					environment.PATH = "MUTATED HOST PATH";
				}
				return true;
			},
		};
		const original = structuredClone(configured);
		const session = await f.open({
			client,
			mcpServers: [
				{
					name: "package",
					command: "npx",
					args: ["--yes", "untrusted-package@1"],
					env: [],
				},
			],
		});
		try {
			await session.prompt(testPrompt());
			const shown = JSON.stringify(permissions);
			for (const value of [
				"node",
				"-e",
				"writeFileSync",
				"untrusted-package@1",
				"NODE_OPTIONS",
				"/workspace/hook.js",
				"/workspace/bin",
				"/host/bin",
				"Server override",
				"MCP SDK host default",
				"Zed session",
				"global/workspace",
				"UNSANDBOXED host execution",
			]) {
				expect(shown).toContain(value);
			}
			expect(shown).not.toContain("resolved-token");
			expect(shown).not.toContain("env-credential");
			expect(shown).not.toContain("MUTATED");
			expect(secrets).toEqual(
				expect.arrayContaining(["resolved-token", "env-credential"]),
			);
			const [[servers]] = f.deps.connectMcpTools.mock.calls;
			expect(servers[0]).toEqual({
				...original,
				env: expect.arrayContaining([
					...original.env,
					{ name: "HOME", value: "/host/home" },
				]),
			});
			expect(servers[1]).toMatchObject({
				args: ["--yes", "untrusted-package@1"],
				env: expect.arrayContaining([{ name: "PATH", value: "/host/bin" }]),
			});
		} finally {
			await f.close();
		}
	});

	it("registers configured references and supplied credentials before their values can be emitted or persisted", async () => {
		const f = nativeFixture();
		const registered = new Set<string>();
		const client = {
			requestPermission: f.requestPermission,
			registerSecrets: vi.fn((values: readonly string[]) =>
				values.forEach((value) => registered.add(value)),
			),
		};
		f.deps.loadMcpConfig.mockImplementation(async (_roots, options) => {
			options?.onSecrets?.(["config-secret"]);
			return [
				{ name: "config", command: "node", args: ["config-secret"], env: [] },
			];
		});
		f.deps.connectMcpTools.mockImplementation(async () => {
			expect([...registered]).toEqual(
				expect.arrayContaining([
					"config-secret",
					"env-secret",
					"header-secret",
					"query-secret",
					"argument-secret",
				]),
			);
			return { tools: [], dispose: async () => {} };
		});
		const session = await f.open({
			client,
			mcpServers: [
				{
					name: "local",
					command: "node",
					args: ["--api-key=argument-secret"],
					env: [{ name: "API_TOKEN", value: "env-secret" }],
				},
				{
					name: "remote",
					type: "http",
					url: "https://remote.invalid/path?token=query-secret",
					headers: [{ name: "Authorization", value: "header-secret" }],
				},
			],
		});
		try {
			expect(registered.has("env-secret")).toBe(true);
			await session.prompt(testPrompt());
			const permissions = JSON.stringify(f.requestPermission.mock.calls);
			for (const value of registered) {
				expect(permissions).not.toContain(value);
			}
			expect(permissions).toContain("[REDACTED]");
		} finally {
			await f.close();
		}
	});

	it("clears every registered provider and refuses same-connection ambient auth reuse until reconnect", async () => {
		const f = nativeFixture();
		const deps = await f.server();
		await expect(deps.authenticate!()).resolves.toBeUndefined();
		await deps.logout!();
		expect(f.models.logout.mock.calls).toEqual([
			["offline"],
			["other-offline"],
		]);
		await expect(deps.authenticate!()).rejects.toEqual({
			tag: "native_auth_required",
		});
		await expect(
			deps.createSession({ sessionId: "after-logout", cwd: CWD }),
		).rejects.toEqual({ tag: "native_auth_required" });
		expect(f.models.getAvailable).not.toHaveBeenCalled();
		await deps.logout!();
		expect(f.models.logout).toHaveBeenCalledTimes(2);
		const reconnect = await f.server();
		const session = await reconnect.createSession({
			sessionId: "reconnected",
			cwd: CWD,
		});
		await session.dispose();
		await expect(reconnect.authenticate!()).resolves.toBeUndefined();
	});

	it("attempts and awaits every credential deletion, remaining logged out if a deletion fails", async () => {
		const f = nativeFixture();
		const completion = gate();
		f.models.logout.mockImplementation(async (id) => {
			if (id === "offline") {
				throw new Error("private-provider-error");
			}
			await completion.promise;
		});
		const deps = await f.server();
		let settled = false;
		const logout = deps.logout!().catch((error: unknown) => {
			settled = true;
			return error;
		});
		try {
			await vi.waitFor(() => expect(f.models.logout).toHaveBeenCalledTimes(2));
			expect(settled).toBe(false);
			await expect(deps.authenticate!()).rejects.toEqual({
				tag: "native_auth_required",
			});
			completion.release();
			await expect(logout).resolves.toEqual(
				new Error(
					"Could not clear all D3R provider credentials; this connection remains logged out",
				),
			);
		} finally {
			completion.release();
			await logout;
		}
	});
});
