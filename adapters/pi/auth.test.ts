import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	type AuthInteraction,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "./auth-store.ts";
import {
	createModelRuntime,
	getAuthStatus,
	listProviders,
	loginProvider,
	logoutProvider,
} from "./auth.ts";

/** Keep the real factories but permit one test to insert a deliberately failing provider. */
vi.mock(
	import("@earendil-works/pi-ai/providers/all"),
	async (importOriginal) => ({
		...(await importOriginal()),
	}),
);

/** Longer than Pi's minimum token-validity window, with no dependence on wall-clock expiry. */
const TOKEN_LIFETIME_MS = 3_600_000;
/** Deliberately fake data; never import host credentials in tests. */
const expired = {
	type: "oauth" as const,
	access: "fake-old-access",
	refresh: "fake-old-refresh",
	expires: 0,
};
/** Custom providers are installed only in isolated test collections. */
const oauthProvider = (
	refresh: (
		credential: OAuthCredential,
		signal: AbortSignal,
	) => Promise<OAuthCredential>,
): Provider => ({
	id: "fake",
	name: "Fake provider",
	getModels: () => [],
	auth: {
		oauth: {
			name: "Fake OAuth",
			isSubscription: true,
			login: async () => expired,
			refresh,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		},
	},
	stream: () => {
		throw new Error("Tests must not stream");
	},
	streamSimple: () => {
		throw new Error("Tests must not stream");
	},
});
/** No browser, real secret, or provider endpoint is involved in this interaction. */
const interaction = (): AuthInteraction => ({
	prompt: vi.fn(async () => "fake-api-key"),
	notify: vi.fn(),
	signal: new AbortController().signal,
});

describe.skipIf(process.platform === "win32")(
	"native provider authentication",
	() => {
		let stateDir = "";
		beforeEach(async () => {
			stateDir = await mkdtemp(
				join(await realpath(tmpdir()), "d3r-model-auth-"),
			);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("Provider network is forbidden in auth tests");
				}),
			);
		});
		afterEach(async () => {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(stateDir, { recursive: true, force: true });
		});

		it("composes actual installed built-ins without discovery, login or network", async () => {
			const models = await createModelRuntime({ stateDir });
			expect(
				models.getModel("anthropic", models.getModels("anthropic")[0].id),
			).toBeDefined();
			expect(models.getModels("openai").length).toBeGreaterThan(0);
			expect(typeof models.setProvider).toBe("function");
			const metadata = listProviders(models);
			expect(
				metadata.find((provider) => provider.id === "openai")?.methods,
			).toEqual([expect.objectContaining({ type: "api_key" })]);
			expect(
				metadata.find((provider) => provider.id === "openai-codex")?.methods,
			).toContainEqual(expect.objectContaining({ type: "oauth" }));
			expect(fetch).not.toHaveBeenCalled();
		});

		it("logs in through Models.login, discards its return and persists only D3R state", async () => {
			const models = await createModelRuntime({ stateDir });
			const login = vi.spyOn(models, "login");
			const callbacks = interaction();
			expect(
				await loginProvider(models, "openai", "api_key", callbacks),
			).toBeUndefined();
			expect(login).toHaveBeenCalledWith("openai", "api_key", callbacks);
			expect(callbacks.prompt).toHaveBeenCalledWith(
				expect.objectContaining({ type: "secret" }),
			);
			const fresh = await createModelRuntime({ stateDir });
			expect(await fresh.getAuth("openai")).toMatchObject({
				auth: { apiKey: "fake-api-key" },
			});
			expect(fetch).not.toHaveBeenCalled();
		});

		it("getAvailable observes login and logout between sessions without caching credentials", async () => {
			vi.stubEnv("OPENAI_API_KEY", "");
			const models = await createModelRuntime({ stateDir });
			const store = await createCredentialStore({ stateDir });
			expect(await models.getAvailable("openai")).toEqual([]);
			await store.modify("openai", async () => ({
				type: "api_key",
				key: "fake-session-key",
			}));
			expect(await models.getAvailable("openai")).toEqual(
				models.getModels("openai"),
			);
			await store.delete("openai");
			expect(await models.getAvailable("openai")).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		});

		it("returns metadata-only status without checking ambient auth or refreshing expired OAuth", async () => {
			const models = await createModelRuntime({ stateDir });
			const store = await createCredentialStore({ stateDir });
			await store.modify("openai-codex", async () => expired);
			const getAuth = vi.spyOn(models, "getAuth");
			const checkAuth = vi.spyOn(models, "checkAuth");
			const status = await getAuthStatus({
				models,
				stateDir,
				provider: "openai-codex",
			});
			expect(status).toEqual([
				expect.objectContaining({
					id: "openai-codex",
					stored: true,
					storedType: "oauth",
				}),
			]);
			expect(JSON.stringify(status)).not.toContain("fake-old");
			expect(getAuth).not.toHaveBeenCalled();
			expect(checkAuth).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		});

		it("removes only the chosen provider without revocation requests", async () => {
			const models = await createModelRuntime({ stateDir });
			const store = await createCredentialStore({ stateDir });
			await store.modify("openai", async () => ({
				type: "api_key",
				key: "fake-key",
			}));
			await store.modify("anthropic", async () => ({
				type: "api_key",
				key: "another-fake-key",
			}));
			await logoutProvider(models, "openai");
			expect(await store.list()).toEqual([
				{ providerId: "anthropic", type: "api_key" },
			]);
			expect(fetch).not.toHaveBeenCalled();
		});

		it("lets Pi double-check OAuth expiry under the shared store lock", async () => {
			const store = await createCredentialStore({ stateDir });
			await store.modify("fake", async () => expired);
			const refreshed = {
				...expired,
				access: "fake-new-access",
				refresh: "fake-rotated-refresh",
				expires: Date.now() + TOKEN_LIFETIME_MS,
			};
			const refresh = vi.fn(async () => refreshed);
			const first = await createModelRuntime({ stateDir });
			const second = await createModelRuntime({ stateDir });
			first.setProvider(oauthProvider(refresh));
			second.setProvider(oauthProvider(refresh));
			const auth = await Promise.all([
				first.getAuth("fake"),
				second.getAuth("fake"),
			]);
			expect(refresh).toHaveBeenCalledOnce();
			expect(auth).toEqual(
				Array.from({ length: 2 }, () => ({
					auth: { apiKey: "fake-new-access" },
					source: "OAuth",
				})),
			);
			expect(await store.read("fake")).toEqual(refreshed);
			expect(fetch).not.toHaveBeenCalled();
		});

		it("redacts provider errors before Pi builds nested auth exceptions", async () => {
			const provider = oauthProvider(async () => {
				throw new Error("fake-secret-provider-response");
			});
			const builtins = await import("@earendil-works/pi-ai/providers/all");
			vi.spyOn(builtins, "builtinModels").mockImplementationOnce((options) => {
				const models = createModels(options);
				models.setProvider(provider);
				return models;
			});
			const models = await createModelRuntime({ stateDir });
			const store = await createCredentialStore({ stateDir });
			await store.modify("fake", async () => expired);
			const failure = await models.getAuth("fake").catch((error) => error);
			expect(String(failure)).not.toContain("fake-secret");
			expect(JSON.stringify(failure)).not.toContain("fake-secret");
			expect(await store.read("fake")).toEqual(expired);
		});

		it("redacts login, logout and untrusted provider errors", async () => {
			const models = await createModelRuntime({ stateDir });
			vi.spyOn(models, "login").mockRejectedValue(
				new Error("fake-token-response"),
			);
			const failure = await loginProvider(
				models,
				"openai",
				"api_key",
				interaction(),
			).catch((error) => error);
			expect(String(failure)).toBe("Error: Provider login failed");
			expect(failure.cause).toBeUndefined();
			vi.spyOn(models, "logout").mockRejectedValue(
				new Error("fake-token-response"),
			);
			await expect(logoutProvider(models, "openai")).rejects.toThrow(
				"Provider logout failed",
			);
			await expect(
				loginProvider(
					models,
					"fake-secret-in-provider",
					"api_key",
					interaction(),
				),
			).rejects.not.toThrow("fake-secret");
			await expect(
				getAuthStatus({
					models,
					stateDir,
					provider: "fake-secret-in-provider",
				}),
			).rejects.not.toThrow("fake-secret");
		});

		it("does not enter unsupported or cancelled login flows", async () => {
			const models = await createModelRuntime({ stateDir });
			const login = vi.spyOn(models, "login");
			await expect(
				loginProvider(models, "openai", "oauth", interaction()),
			).rejects.toThrow("does not support");
			expect(login).not.toHaveBeenCalled();
			const controller = new AbortController();
			controller.abort(new Error("fake-secret-reason"));
			await expect(
				loginProvider(models, "openai", "api_key", {
					...interaction(),
					signal: controller.signal,
				}),
			).rejects.toThrow("Authentication cancelled");
			expect(fetch).not.toHaveBeenCalled();
		});
	},
);
