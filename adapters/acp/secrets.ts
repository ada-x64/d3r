import { type SessionParams } from "./params.ts";

/** One mutable collection follows setup and all turns; callers register only resolved credentials. */
export const createSecretCollection = (initial: readonly string[] = []) => {
	const values: string[] = [];
	const registerSecrets = (secrets: readonly string[]): void => {
		for (const secret of secrets) {
			if (secret && !values.includes(secret)) {
				values.push(secret);
			}
		}
	};
	registerSecrets(initial);
	return { values, registerSecrets };
};

/** Credential suffixes exclude settings such as TOKEN_LIMIT, PASSWORD_FILE, and AUTH_ENABLED. */
const credentialName =
	/(?:^|_)(?:authorization|cookie|password|passwd|secret|token|credentials?|signature|sig|apikey|key|auth)$/i;
/** Scrub recognized credentials and bearer tokens, not arbitrary environment/header values. */
const namedSecrets = (
	entries: readonly { name: string; value: string }[],
): string[] =>
	entries.flatMap(({ name, value }) => {
		const normalized = name
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.replaceAll("-", "_");
		if (!credentialName.test(normalized) || !value) {
			return [];
		}
		const bearer = /^(?:Bearer|Token)\s+(.+)$/i.exec(value);
		return bearer ? [value, bearer[1]] : [value];
	});
/** Keep both encoded and decoded secret values for URLs echoed into model/tool text. */
const urlSecrets = (address: string): string[] => {
	const url = new URL(address);
	const values = namedSecrets(
		[...url.searchParams].map(([name, value]) => ({ name, value })),
	);
	if (url.password) {
		values.push(decodeURIComponent(url.password));
	}
	return values.flatMap((value) => [value, encodeURIComponent(value)]);
};
/** Launch configurations are never persisted; argv and nonsecret settings must not rewrite model state. */
export const mcpSecrets = (params: SessionParams): string[] => [
	...new Set(
		params.mcpServers.flatMap((server) => {
			if (!("type" in server) || !server.type) {
				return namedSecrets(server.env);
			}
			return [...namedSecrets(server.headers), ...urlSecrets(server.url)];
		}),
	),
];
