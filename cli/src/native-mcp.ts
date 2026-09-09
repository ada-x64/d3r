import { isAbsolute, join } from "node:path";
import {
	type RuntimeClientServices,
	type RuntimeMcpServer,
} from "@d3r/core/runtime";

/** Optional during composition rollout; ACP owns durable replay redaction, not the MCP transport. */
type SecretClient = RuntimeClientServices & {
	readonly registerSecrets?: (values: readonly string[]) => void;
};
/** Match ACP's credential suffix semantics, not settings such as MAX_TOKENS or PASSWORD_FILE. */
const credentialName = (name: string): boolean =>
	/(?:^|_)(?:authorization|cookie|password|passwd|secret|token|credentials?|signature|sig|apikey|key|auth)$/i.test(
		name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_"),
	);
/** Register URL credentials separately so a server cannot leak them by echoing only the query value. */
const urlSecrets = (value: string): string[] => {
	if (!URL.canParse(value)) {
		return [];
	}
	const url = new URL(value);
	return [
		decodeURIComponent(url.password),
		...[...url.searchParams]
			.filter(([name]) => credentialName(name))
			.map(([, secret]) => secret),
	]
		.filter(Boolean)
		.flatMap((secret) => [secret, encodeURIComponent(secret)]);
};
/** Credential arguments may be separate argv entries or an explicit key=value assignment. */
const argumentSecrets = (args: readonly string[]): string[] => {
	const separator = args.indexOf("--");
	const flags = separator === -1 ? args : args.slice(0, separator);
	return [
		...flags.flatMap((arg, index) => {
			const [, key, value] = /^[-/]*([^\s=:]+)[=:](.*)$/s.exec(arg) ?? [];
			const assigned = key && credentialName(key) ? [value] : [];
			const following =
				/^[-/]/.test(arg) &&
				!/[=:]/.test(arg) &&
				credentialName(arg) &&
				flags[index + 1] !== undefined
					? [flags[index + 1]]
					: [];
			return [...assigned, ...following];
		}),
		...args.flatMap(urlSecrets),
	];
};
/** Only the presentation is redacted; these server objects are the exact connection inputs. */
export interface NativeMcpPlan {
	readonly server: RuntimeMcpServer;
	readonly title: string;
	readonly summary: Record<string, unknown>;
}
/** Permission masking is separate from persistent substring redaction, which accepts credentials only. */
export const createNativeMcpSecurity = (client?: SecretClient) => {
	const permissionMasks = new Set<string>();
	const registeredCredentials = new Set<string>();
	/** Withholding a display value must never silently turn it into a global transcript replacement. */
	const maskPermissionValues = (values: readonly string[]): void => {
		values.filter(Boolean).forEach((value) => permissionMasks.add(value));
	};
	/** Values from onSecrets must already be classified by the config loader as credentials. */
	const registerSecrets = (values: readonly string[]): void => {
		const candidates = values.flatMap((value) => {
			const bearer = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(value)?.[1];
			return bearer ? [value, bearer] : [value];
		});
		maskPermissionValues(candidates);
		const fresh = [...new Set(candidates)].filter(
			(value) => value.length > 0 && !registeredCredentials.has(value),
		);
		fresh.forEach((value) => registeredCredentials.add(value));
		if (fresh.length) {
			client?.registerSecrets?.(fresh);
		}
	};
	const collect = (servers: readonly RuntimeMcpServer[]): void => {
		registerSecrets(
			servers.flatMap((server) =>
				"command" in server
					? [
							...server.env
								.filter(({ name }) => credentialName(name))
								.map(({ value }) => value),
							...argumentSecrets(server.args),
						]
					: [
							...server.headers
								.filter(({ name }) => credentialName(name))
								.map(({ value }) => value),
							...urlSecrets(server.url),
						],
			),
		);
	};
	const redact = (value: string): string =>
		[...permissionMasks]
			.toSorted((a, b) => b.length - a.length)
			.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
	/** Cloning and materializing inherited environment prevents approval-time callbacks changing the launch plan. */
	const plan = (
		configured: readonly RuntimeMcpServer[],
		supplied: readonly RuntimeMcpServer[],
		context: {
			readonly home: string;
			readonly cwd: string;
			readonly environment: Readonly<Record<string, string>>;
		},
	): NativeMcpPlan[] => {
		if (new Set(supplied.map(({ name }) => name)).size !== supplied.length) {
			throw new Error("Duplicate session MCP server names");
		}
		const suppliedNames = new Set(supplied.map(({ name }) => name));
		const servers = structuredClone([
			...new Map(
				[...configured, ...supplied].map((server) => [server.name, server]),
			).values(),
		]);
		collect(servers);
		registerSecrets(
			Object.entries(context.environment)
				.filter(([key]) => credentialName(key))
				.map(([, value]) => value),
		);
		return servers.map((server) => {
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(server.name)) {
				throw new Error("Invalid MCP server name");
			}
			const name = redact(server.name);
			const provenance = suppliedNames.has(server.name)
				? { source: "Zed session MCP configuration" }
				: {
						source: "Merged global/workspace .agents/mcp.json configuration",
						configurationPaths: [
							join(context.home, ".agents", "mcp.json"),
							join(context.cwd, ".agents", "mcp.json"),
						].map(redact),
					};
			if (!("command" in server)) {
				if (!URL.canParse(server.url)) {
					throw new Error("Invalid MCP endpoint");
				}
				const url = new URL(server.url);
				if (
					!["http:", "https:"].includes(url.protocol) ||
					url.username ||
					url.password
				) {
					throw new Error("Invalid MCP endpoint");
				}
				const target = redact(url.origin);
				return {
					server,
					title: `Connect MCP ${name}: ${target}`,
					summary: {
						name,
						target,
						...provenance,
						headerNames: server.headers.map((header) => redact(header.name)),
						warning:
							"Connect to a remote MCP service. Header values and endpoint path/query are withheld; remote tool calls still require approval.",
					},
				};
			}
			// oxlint-disable-next-line no-control-regex -- Permission titles must never interpret terminal control sequences.
			if (!server.command || /[\x00-\x1f\x7f]/.test(server.command)) {
				throw new Error("Invalid MCP executable");
			}
			const keys = server.env.map(({ name: key }) =>
				process.platform === "win32" ? key.toLowerCase() : key,
			);
			if (new Set(keys).size !== keys.length) {
				throw new Error("Duplicate MCP environment keys");
			}
			const overrides = new Map(
				server.env.map(({ name: key, value }) => [key, value]),
			);
			const inherited = new Map(Object.entries(context.environment));
			// Windows environment keys are case-insensitive; retain the winning spelling and value.
			if (process.platform === "win32") {
				const overrideKeys = new Set(keys);
				[...inherited.keys()]
					.filter((key) => overrideKeys.has(key.toLowerCase()))
					.forEach((key) => inherited.delete(key));
			}
			const env = [...new Map([...inherited, ...overrides])].map(
				([key, value]) => ({ name: key, value }),
			);
			const effective = { ...server, env };
			collect([effective]);
			const command = redact(server.command);
			const args = server.args.map(redact);
			return {
				server: effective,
				title: `Connect MCP ${name} - UNSANDBOXED host execution: ${JSON.stringify([command, ...args])}`,
				summary: {
					name,
					command,
					args,
					cwd: redact(context.cwd),
					...provenance,
					executableLookup: isAbsolute(server.command)
						? "Absolute executable path"
						: "Executable resolved against the effective PATH shown below",
					environment: env.map(({ name: key, value }) => ({
						name: redact(key),
						value: redact(value),
						source: overrides.has(key)
							? "Server override"
							: "MCP SDK host default",
					})),
					warning:
						"UNSANDBOXED host execution: this command can execute arbitrary code with your user permissions, access host files and the network, and spawn other processes. node -e runs inline code; npx may download and execute packages. PATH, NODE_OPTIONS and other environment overrides can change what executes. Secret values are redacted, not removed from the launch configuration. Tool-call approval does not sandbox this connection.",
				},
			};
		});
	};
	return { maskPermissionValues, registerSecrets, collect, plan };
};
