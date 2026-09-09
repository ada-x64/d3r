import {
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthType,
	type Models,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createCredentialStore } from "./auth-store.ts";

/** CLI consumers need only these interaction types, not credential values. */
export type {
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
	AuthType,
	Models,
} from "@earendil-works/pi-ai";

/** Provider-owned login capabilities, separated from credential data. */
export interface ProviderAuthMetadata {
	readonly id: string;
	readonly name: string;
	readonly methods: readonly {
		readonly type: AuthType;
		readonly name: string;
		readonly subscription: boolean;
	}[];
}

/** Local storage status is not a provider-side validity or subscription check. */
export interface ProviderAuthStatus extends ProviderAuthMetadata {
	readonly stored: boolean;
	readonly storedType?: AuthType;
}

/** Provider exceptions can contain response bodies, API keys and token URLs. */
const safeAuthCall = async <T>(call: () => Promise<T>): Promise<T> => {
	try {
		return await call();
	} catch {
		throw new Error("Provider authentication failed");
	}
};

/** Redact at the provider boundary before Pi incorporates causes into ModelsError. */
const privateProvider = (provider: Provider): Provider => {
	const { apiKey, oauth } = provider.auth;
	return {
		...provider,
		auth: {
			apiKey: apiKey && {
				...apiKey,
				login:
					apiKey.login &&
					((interaction) => safeAuthCall(() => apiKey.login!(interaction))),
				check:
					apiKey.check && ((input) => safeAuthCall(() => apiKey.check!(input))),
				resolve: (input) => safeAuthCall(() => apiKey.resolve(input)),
			},
			oauth: oauth && {
				...oauth,
				login: (interaction) => safeAuthCall(() => oauth.login(interaction)),
				refresh: (credential, signal) =>
					safeAuthCall(() => oauth.refresh(credential, signal)),
				toAuth: (credential) => safeAuthCall(() => oauth.toAuth(credential)),
			},
		},
	};
};

/**
 * Compose the installed Pi 0.85.1 built-ins with D3R-only private persistence.
 * Returns MutableModels so composition can register explicit custom providers.
 * This does not refresh catalogs, log in, import credentials or contact providers.
 * No models/config file is loaded. Native ambient provider env/SDK auth remains
 * available at request time; Pi's global auth/config is never consulted.
 * Custom providers added later are responsible for redacting their own failures.
 * Windows rejects before filesystem access until user-only ACL verification is
 * implemented; there is no fallback to library credential defaults.
 * See auth-store.ts for supported POSIX permissions.
 */
export const createModelRuntime = async ({
	stateDir,
}: {
	readonly stateDir: string;
}): Promise<MutableModels> => {
	const credentials = await createCredentialStore({ stateDir });
	const models = builtinModels({ credentials });
	models
		.getProviders()
		.forEach((provider) => models.setProvider(privateProvider(provider)));
	return models;
};

/** Enumerate installed provider capabilities without resolving auth or making requests. */
export const listProviders = (
	models: Models,
): readonly ProviderAuthMetadata[] =>
	models
		.getProviders()
		.map((provider) => ({
			id: provider.id,
			name: provider.name,
			methods: [
				...(provider.auth.apiKey?.login
					? [
							{
								type: "api_key" as const,
								name: provider.auth.apiKey.name,
								subscription: false,
							},
						]
					: []),
				...(provider.auth.oauth
					? [
							{
								type: "oauth" as const,
								name:
									provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
								subscription: provider.auth.oauth.isSubscription ?? false,
							},
						]
					: []),
			],
		}))
		.sort((a, b) => a.id.localeCompare(b.id));

/** Do not echo an untrusted provider argument in exceptions. */
const requireProvider = (models: Models, providerId: string): Provider => {
	const provider = models.getProvider(providerId);
	if (!provider) {
		throw new Error("Unknown authentication provider; use d3r auth list");
	}
	return provider;
};

/**
 * Metadata-only local status. Does not call getAuth/checkAuth, refresh OAuth,
 * execute API-key commands, or test a subscription. Ambient auth is not reported.
 */
export const getAuthStatus = async ({
	models,
	stateDir,
	provider,
	signal,
}: {
	readonly models: Models;
	readonly stateDir: string;
	readonly provider?: string;
	readonly signal?: AbortSignal;
}): Promise<readonly ProviderAuthStatus[]> => {
	if (provider !== undefined) {
		requireProvider(models, provider);
	}
	try {
		signal?.throwIfAborted();
		const store = await createCredentialStore({ stateDir });
		const credentials = await store.list({ signal });
		return listProviders(models)
			.filter((entry) => provider === undefined || entry.id === provider)
			.map((entry) => {
				const stored = credentials.find(
					(credential) => credential.providerId === entry.id,
				);
				return {
					...entry,
					stored: stored !== undefined,
					storedType: stored?.type,
				};
			});
	} catch {
		throw new Error("Unable to read private authentication status");
	}
};

/** Discard Models.login's secret return value; only the store retains credentials. */
// oxlint-disable-next-line max-params -- Preserve Pi's login arguments alongside the explicitly injected runtime.
export const loginProvider = async (
	models: Models,
	providerId: string,
	type: AuthType,
	interaction: AuthInteraction,
): Promise<void> => {
	const provider = requireProvider(models, providerId);
	const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
	if (!method?.login) {
		throw new Error("This provider does not support the selected login method");
	}
	try {
		await models.login(providerId, type, interaction);
	} catch {
		throw new Error(
			interaction.signal?.aborted
				? "Authentication cancelled"
				: "Provider login failed",
		);
	}
};

/** Logout only deletes D3R's local credential; it does not revoke remote tokens or env auth. */
export const logoutProvider = async (
	models: Models,
	providerId: string,
	options?: AuthOperationOptions,
): Promise<void> => {
	requireProvider(models, providerId);
	try {
		await models.logout(providerId, options);
	} catch {
		throw new Error("Provider logout failed");
	}
};
