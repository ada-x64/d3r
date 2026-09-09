import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { password, select } from "@clack/prompts";
import { createModelRuntime } from "../../adapters/pi/auth.ts";
import { createCredentialStore } from "../../adapters/pi/auth-store.ts";
import command, {
	defaultAuthStateDir,
	executeAuth,
	runTerminalLogin,
} from "../src/verbs/auth.ts";

/** No terminal input or live provider flow is allowed in command tests. */
vi.mock("@clack/prompts", () => ({
	password: vi.fn(),
	select: vi.fn(),
	isCancel: (value: unknown) => typeof value === "symbol",
}));

/** Fake OAuth responses need not be valid with any real provider. */
const fakeOAuth = {
	type: "oauth" as const,
	access: "fake-access",
	refresh: "fake-refresh",
	expires: 0,
};

describe.skipIf(process.platform === "win32")("auth CLI", () => {
	let stateDir = "";
	beforeEach(async () => {
		stateDir = await mkdtemp(join(await realpath(tmpdir()), "d3r-auth-cli-"));
		vi.mocked(password).mockReset().mockResolvedValue("fake-api-key");
		vi.mocked(select).mockReset();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("No provider network permitted");
			}),
		);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		await rm(stateDir, { recursive: true, force: true });
	});

	it("exports a command and defaults to private homedir state, not the workspace", () => {
		expect(command.meta).toMatchObject({ name: "auth" });
		expect(defaultAuthStateDir()).toBe(
			join(homedir(), ".agents", "d3r", "private"),
		);
	});

	it("fails noninteractive login before creating a runtime or prompting", async () => {
		const createRuntime = vi.fn();
		await expect(
			runTerminalLogin({}, { createRuntime, interactive: () => false }),
		).rejects.toThrow("interactive terminal");
		expect(createRuntime).not.toHaveBeenCalled();
		expect(password).not.toHaveBeenCalled();
		expect(select).not.toHaveBeenCalled();
	});

	it("rejects redirected stdout even when stdin is a terminal", async () => {
		const streams = [process.stdin, process.stdout];
		const descriptors = streams.map((stream) =>
			Object.getOwnPropertyDescriptor(stream, "isTTY"),
		);
		try {
			streams.forEach((stream) =>
				Object.defineProperty(stream, "isTTY", {
					configurable: true,
					value: stream === process.stdin,
				}),
			);
			await expect(runTerminalLogin()).rejects.toThrow("interactive terminal");
		} finally {
			streams.forEach((stream, index) => {
				const descriptor = descriptors[index];
				if (descriptor) {
					Object.defineProperty(stream, "isTTY", descriptor);
				} else {
					Reflect.deleteProperty(stream, "isTTY");
				}
			});
		}
	});

	it("lists installed capabilities and reports only local metadata", async () => {
		const models = await createModelRuntime({ stateDir });
		const store = await createCredentialStore({ stateDir });
		await store.modify("openai-codex", async () => fakeOAuth);
		const write = vi.fn();
		const getAuth = vi.spyOn(models, "getAuth");
		const checkAuth = vi.spyOn(models, "checkAuth");
		await executeAuth("list", "openai-codex", { models, stateDir, write });
		expect(write).toHaveBeenCalledWith("openai-codex\toauth\n");
		await executeAuth("status", "openai-codex", { models, stateDir, write });
		expect(write).toHaveBeenCalledWith("openai-codex\tstored oauth\n");
		expect(JSON.stringify(write.mock.calls)).not.toContain("fake-access");
		expect(getAuth).not.toHaveBeenCalled();
		expect(checkAuth).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses masked Clack input and Models.login without printing the entered key", async () => {
		const models = await createModelRuntime({ stateDir });
		const write = vi.fn();
		const login = vi.spyOn(models, "login");
		await runTerminalLogin(
			{ provider: "openai", type: "api_key" },
			{ models, stateDir, write, interactive: () => true },
		);
		expect(password).toHaveBeenCalledWith(
			expect.objectContaining({ mask: "*" }),
		);
		const [[keyPrompt]] = vi.mocked(password).mock.calls;
		expect(keyPrompt.validate?.("")).toBe("A value is required");
		expect(keyPrompt.validate?.("   ")).toBe("A value is required");
		expect(login).toHaveBeenCalledWith(
			"openai",
			"api_key",
			expect.objectContaining({ prompt: expect.any(Function) }),
		);
		expect(JSON.stringify(write.mock.calls)).not.toContain("fake-api-key");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("passes a blank optional GitHub host through to the provider", async () => {
		const models = await createModelRuntime({ stateDir });
		const provider = models.getProvider("github-copilot")!;
		const host = vi.fn();
		models.setProvider({
			...provider,
			auth: {
				oauth: {
					...provider.auth.oauth!,
					login: async (interaction) => {
						host(
							await interaction.prompt({
								type: "text",
								message: "GitHub Enterprise URL/domain (blank for github.com)",
								placeholder: "company.ghe.com",
							}),
						);
						return fakeOAuth;
					},
				},
			},
		});
		vi.mocked(password).mockImplementationOnce(async (options) => {
			expect(options.validate?.("")).toBeUndefined();
			expect(options.validate?.("   ")).toBeUndefined();
			return "";
		});
		await runTerminalLogin(
			{ provider: "github-copilot", type: "oauth" },
			{ models, stateDir, write: vi.fn(), interactive: () => true },
		);
		expect(host).toHaveBeenCalledWith("");
		const store = await createCredentialStore({ stateDir });
		expect(await store.read("github-copilot")).toEqual(fakeOAuth);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("selects a provider when omitted", async () => {
		const models = await createModelRuntime({ stateDir });
		vi.mocked(select).mockResolvedValueOnce("openai");
		await executeAuth("login", undefined, {
			models,
			stateDir,
			interactive: () => true,
			write: vi.fn(),
		});
		expect(select).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Provider" }),
		);
		expect(password).toHaveBeenCalledOnce();
	});

	it("notifies URL/device codes and masks OAuth text/manual-code responses", async () => {
		const models = await createModelRuntime({ stateDir });
		const provider = models.getProvider("openai-codex")!;
		models.setProvider({
			...provider,
			auth: {
				oauth: {
					...provider.auth.oauth!,
					isSubscription: true,
					login: async (interaction) => {
						interaction.notify({
							type: "auth_url",
							url: "https://example.invalid/login",
							instructions: "Open the link",
						});
						interaction.notify({
							type: "device_code",
							userCode: "TEST-CODE",
							verificationUri: "https://example.invalid/device",
						});
						await interaction.prompt({
							type: "manual_code",
							message: "Callback code",
						});
						await interaction.prompt({
							type: "text",
							message: "Provider setting",
						});
						return fakeOAuth;
					},
				},
			},
		});
		const write = vi.fn();
		await runTerminalLogin(
			{ provider: "openai-codex" },
			{ models, stateDir, write, interactive: () => true },
		);
		expect(write).toHaveBeenCalledWith("Open: https://example.invalid/login\n");
		expect(write).toHaveBeenCalledWith(
			"Open: https://example.invalid/device\nDevice code: TEST-CODE\n",
		);
		expect(write).toHaveBeenCalledWith(
			expect.stringContaining("not a guarantee"),
		);
		const freeFormPrompts = 2;
		expect(password).toHaveBeenCalledTimes(freeFormPrompts);
		const [[manualPrompt]] = vi.mocked(password).mock.calls;
		expect(manualPrompt.validate?.("")).toBe("A value is required");
		expect(JSON.stringify(write.mock.calls)).not.toContain("fake-api-key");
		expect(JSON.stringify(write.mock.calls)).not.toContain("fake-access");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("cancels without persisting or leaking signal handlers", async () => {
		const models = await createModelRuntime({ stateDir });
		const before = process.listenerCount("SIGINT");
		vi.mocked(password).mockResolvedValueOnce(Symbol("cancel"));
		await expect(
			runTerminalLogin(
				{ provider: "openai" },
				{ models, stateDir, interactive: () => true, write: vi.fn() },
			),
		).rejects.toThrow("Authentication cancelled");
		expect(process.listenerCount("SIGINT")).toBe(before);
		const store = await createCredentialStore({ stateDir });
		expect(await store.list()).toEqual([]);
	});

	it("aborts a pending Clack prompt through its normal escape cleanup path", async () => {
		const models = await createModelRuntime({ stateDir });
		const controller = new AbortController();
		const escape = vi.fn();
		vi.mocked(password).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					process.stdin.once("keypress", (_value, key) => {
						escape(key);
						resolve(Symbol("cancel"));
					});
					controller.abort(new Error("fake-secret-reason"));
				}),
		);
		await expect(
			runTerminalLogin(
				{ provider: "openai", signal: controller.signal },
				{ models, stateDir, interactive: () => true, write: vi.fn() },
			),
		).rejects.toThrow("Authentication cancelled");
		expect(escape).toHaveBeenCalledWith({ name: "escape" });
	});

	it("allows an OAuth callback to cancel only its manual-code prompt", async () => {
		const models = await createModelRuntime({ stateDir });
		const provider = models.getProvider("openai-codex")!;
		const step = new AbortController();
		vi.mocked(password).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					process.stdin.once("keypress", () => resolve(Symbol("cancel")));
					step.abort();
				}),
		);
		models.setProvider({
			...provider,
			auth: {
				oauth: {
					...provider.auth.oauth!,
					login: async (interaction) => {
						await interaction
							.prompt({
								type: "manual_code",
								message: "Manual code",
								signal: step.signal,
							})
							.catch(() => undefined);
						expect(interaction.signal.aborted).toBe(false);
						return fakeOAuth;
					},
				},
			},
		});
		await runTerminalLogin(
			{ provider: "openai-codex" },
			{ models, stateDir, interactive: () => true, write: vi.fn() },
		);
		const store = await createCredentialStore({ stateDir });
		expect(await store.read("openai-codex")).toEqual(fakeOAuth);
	});

	it("redacts failed login and never echoes credentials as error causes", async () => {
		const models = await createModelRuntime({ stateDir });
		vi.spyOn(models, "login").mockRejectedValue(new Error("fake-access-token"));
		const failure = await runTerminalLogin(
			{ provider: "openai" },
			{ models, stateDir, interactive: () => true, write: vi.fn() },
		).catch((error) => error);
		expect(String(failure)).not.toContain("fake-access-token");
		expect(failure.cause).toBeUndefined();
	});

	it("validates actions/provider selection and logs out only explicit providers", async () => {
		const models = await createModelRuntime({ stateDir });
		const store = await createCredentialStore({ stateDir });
		await store.modify("openai", async () => ({
			type: "api_key",
			key: "fake-key",
		}));
		const deps = { models, stateDir, write: vi.fn() };
		await expect(executeAuth("invalid", undefined, deps)).rejects.toThrow(
			"Usage:",
		);
		await expect(executeAuth("logout", undefined, deps)).rejects.toThrow(
			"Specify a provider",
		);
		await expect(
			executeAuth("list", "fake-secret-provider", deps),
		).rejects.not.toThrow("fake-secret-provider");
		await executeAuth("logout", "openai", deps);
		expect(await store.list()).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});
});
