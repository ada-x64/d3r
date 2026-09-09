import { join, resolve } from "node:path";
import { type RuntimeMcpServer } from "@d3r/core/runtime";
import { parseDocument } from "yaml";
import { z } from "zod";
import { isMissing, readWorkspaceText } from "./resource-paths.ts";

/** File configuration is inert; only the CLI shell resolves explicit environment references. */
export interface McpConfigOptions {
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly signal?: AbortSignal;
	/** Only resolved credentials, never arbitrary path or setting references. */
	readonly onSecrets?: (values: readonly string[]) => void;
}

/** Configuration limits are independent of remote MCP discovery limits. */
const CONFIG_LIMITS = {
	servers: 1000,
	entries: 5000,
	name: 256,
	value: 65_536,
};

/** Values never request interpolation, command substitution or a credential store lookup. */
const envReference = z
	.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) })
	.strict();

/** Harmless literals are allowed; credential-bearing fields require envReference. */
const configValue = z.union([
	z
		.string()
		.max(CONFIG_LIMITS.value)
		.refine((value) => !value.includes("\0")),
	envReference,
]);

/** Persisted transports have a different boundary from resolved RuntimeMcpServer values. */
const configServer = z.union([
	z
		.object({
			type: z.literal("stdio").optional(),
			command: z
				.string()
				.min(1)
				.max(CONFIG_LIMITS.value)
				.refine((value) => !/[\r\n]/.test(value) && !value.includes("\0")),
			args: z.array(configValue).max(CONFIG_LIMITS.entries).default([]),
			env: z
				.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), configValue)
				.default({}),
		})
		.strict(),
	z
		.object({
			type: z.enum(["http", "sse"]).default("http"),
			url: configValue,
			headers: z
				.record(z.string().regex(/^[!#$%&'*+.^_`|~\w-]+$/), configValue)
				.default({}),
		})
		.strict(),
]);

/** IDs are stable map keys, not filenames or executable names. */
const configSchema = z
	.object({
		mcpServers: z.record(
			z
				.string()
				.min(1)
				.max(CONFIG_LIMITS.name)
				.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
			configServer,
		),
	})
	.strict();

/** Keep the originating file for actionable errors without including credential values. */
interface ConfigEntry {
	readonly name: string;
	readonly server: z.infer<typeof configServer>;
	readonly path: string;
}

/** Credential-bearing names cannot hide a literal behind a punctuation/case variation. */
const isCredentialName = (name: string): boolean =>
	/token|secret|password|passwd|passphrase|credential|auth|cookie|apikey|accesskey|privatekey|clientkey|connectionstring|signature|^(?:key|dsn|bearer|pat|sig)$/.test(
		name.replace(/[^a-z0-9]/gi, "").toLowerCase(),
	);

/** Match ACP's credential suffixes; broader literal rejection must not drive substring redaction. */
const isCredentialReferenceName = (name: string): boolean => {
	const normalized = name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replaceAll("-", "_");
	return /(?:^|_)(?:authorization|cookie|password|passwd|secret|token|credentials?|signature|sig|apikey|key|auth)$/i.test(
		normalized,
	);
};

/** Retain bare bearer credentials without treating ordinary short values as secrets. */
const credentialValues = (value: string): string[] => {
	if (!value) {
		return [];
	}
	const bearer = /^(?:Bearer|Token)\s+(.+)$/i.exec(value);
	return bearer ? [value, bearer[1]] : [value];
};

/** Endpoint references register credential components, not the URL's public structure. */
const endpointCredentials = (value: string): string[] => {
	if (!URL.canParse(value)) {
		return [];
	}
	const url = new URL(value);
	const values = [...url.searchParams].flatMap(([name, part]) =>
		isCredentialReferenceName(name) ? credentialValues(part) : [],
	);
	if (url.password) {
		try {
			values.push(decodeURIComponent(url.password));
		} catch {
			values.push(url.password);
		}
	}
	return values.flatMap((part) => [part, encodeURIComponent(part)]);
};

/** URLs are endpoints, not a way to commit userinfo or credential query parameters. */
const endpointUrl = (
	value: string,
	location: string,
	persisted: boolean,
): URL => {
	if (!URL.canParse(value)) {
		throw new Error(`Invalid MCP URL at ${location}`);
	}
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.hash ||
		/[\r\n]/.test(value)
	) {
		throw new Error(
			`MCP URL must be HTTP(S) without userinfo or fragment at ${location}`,
		);
	}
	if (persisted && [...url.searchParams.keys()].some(isCredentialName)) {
		throw new Error(
			`Plaintext credential URL at ${location}; use an environment reference`,
		);
	}
	return url;
};

/** Literal strings are never expanded, and recognizable credential payloads fail closed. */
const checkLiteral = (value: string, location: string): void => {
	if (/\$\{|\$\(|`|%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) {
		throw new Error(
			`Expansion syntax is not supported at ${location}; use {env: "VARIABLE_NAME"}`,
		);
	}
	if (
		/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:Bearer|Basic)\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/i.test(
			value,
		)
	) {
		throw new Error(
			`Plaintext credential at ${location}; use an environment reference`,
		);
	}
	const assignment = /^[-/]*([^\s=:]+)\s*[=:]/.exec(value);
	if (assignment && isCredentialName(assignment[1])) {
		throw new Error(
			`Plaintext credential assignment at ${location}; use an environment reference`,
		);
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		endpointUrl(value, location, true);
	}
};

/** Reject duplicate normalized keys rather than relying on platform-specific overwrites. */
const checkValues = (
	values: Record<string, z.infer<typeof configValue>>,
	location: string,
	ignoreCase: boolean,
): void => {
	const entries = Object.entries(values);
	if (entries.length > CONFIG_LIMITS.entries) {
		throw new Error(`Too many MCP config entries at ${location}`);
	}
	const names = entries.map(([name]) =>
		ignoreCase ? name.toLowerCase() : name,
	);
	if (new Set(names).size !== names.length) {
		throw new Error(`Duplicate MCP configuration key at ${location}`);
	}
	for (const [name, value] of entries) {
		if (typeof value === "string") {
			if (isCredentialName(name)) {
				throw new Error(
					`Plaintext credential at ${location}.${name}; use an environment reference`,
				);
			}
			checkLiteral(value, `${location}.${name}`);
		}
	}
};

/** Validate even shadowed layers, but resolve only the winning server's references. */
const checkEntry = ({ name, server, path }: ConfigEntry): void => {
	const location = `${path} (server ${name})`;
	if ("command" in server) {
		checkLiteral(server.command, `${location}.command`);
		checkValues(server.env, `${location}.env`, process.platform === "win32");
		server.args.forEach((arg, index) => {
			if (typeof arg === "string") {
				checkLiteral(arg, `${location}.args[${index}]`);
				if (
					/^[-/]/.test(arg) &&
					isCredentialName(arg) &&
					(typeof server.args[index + 1] !== "object" ||
						arg.includes("=") ||
						arg.includes(":"))
				) {
					throw new Error(
						`Credential argument at ${location}.args[${index}] requires a following environment reference`,
					);
				}
			}
		});
	} else {
		if (server.type === "sse") {
			throw new Error(
				`MCP SSE transport is not supported at ${location}; use streamable HTTP`,
			);
		}
		if (typeof server.url === "string") {
			checkLiteral(server.url, `${location}.url`);
			endpointUrl(server.url, `${location}.url`, true);
		}
		checkValues(server.headers, `${location}.headers`, true);
		if (
			Object.values(server.headers).some(
				(value) => typeof value === "string" && /[\r\n]/.test(value),
			)
		) {
			throw new Error(`Invalid MCP header at ${location}`);
		}
	}
};

/** Parse strictly as JSON and use YAML's JSON parser only to detect duplicate keys. */
const parseConfig = (
	text: string,
	path: string,
	observe: (raw: unknown) => void,
): ConfigEntry[] => {
	let raw: unknown = undefined;
	try {
		raw = JSON.parse(text);
		observe(raw);
		JSON.stringify(raw, (key, value: unknown) => {
			if (["__proto__", "constructor", "prototype"].includes(key)) {
				throw new Error("Reserved JSON key");
			}
			return value;
		});
		const document = parseDocument(text, {
			schema: "json",
			uniqueKeys: true,
			prettyErrors: false,
		});
		if (document.errors.length) {
			throw new Error("Duplicate or invalid JSON keys");
		}
	} catch {
		// Parser errors can quote credential values; never attach or echo their payload.
		throw new Error(`Invalid or duplicate-key MCP JSON in ${path}`);
	}
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid MCP configuration shape in ${path}; expected {mcpServers: {name: {command, args?, env?} | {type: "http", url, headers?}}} with values as strings or {env: "VARIABLE_NAME"}`,
		);
	}
	const entries = Object.entries(parsed.data.mcpServers).map(
		([name, server]) => ({ name, server, path }),
	);
	if (entries.length > CONFIG_LIMITS.servers) {
		throw new Error(`Too many MCP servers in ${path}`);
	}
	entries.forEach(checkEntry);
	return entries;
};

/** Read only the supplied root, applying the workspace symlink/private-path policy. */
const readConfig = async (
	root: string,
	signal: AbortSignal,
	observe: (raw: unknown) => void,
): Promise<ConfigEntry[]> => {
	const path = join(root, ".agents", "mcp.json");
	let text = "";
	try {
		({ text } = await readWorkspaceText(path, {
			cwd: root,
			roots: [root],
			signal,
		}));
	} catch (error) {
		if (isMissing(error)) {
			return [];
		}
		throw error;
	}
	return parseConfig(text, path, observe);
};

/** Resolve exact environment names only; missing references never become empty strings. */
const resolveEntry = (
	{ name, server, path }: ConfigEntry,
	environment: Readonly<Record<string, string | undefined>>,
): RuntimeMcpServer => {
	const location = `${path} (server ${name})`;
	const valueOf = (value: z.infer<typeof configValue>): string => {
		if (typeof value === "string") {
			return value;
		}
		const resolved = Object.hasOwn(environment, value.env)
			? environment[value.env]
			: undefined;
		if (resolved === undefined) {
			throw new Error(
				`Missing environment variable ${value.env} for ${location}`,
			);
		}
		if (
			Buffer.byteLength(resolved) > CONFIG_LIMITS.value ||
			resolved.includes("\0")
		) {
			throw new Error(
				`Invalid environment value for ${value.env} at ${location}`,
			);
		}
		return resolved;
	};
	const pairs = (values: Record<string, z.infer<typeof configValue>>) =>
		Object.entries(values)
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => ({ name: key, value: valueOf(value) }));
	if ("command" in server) {
		return {
			name,
			command: server.command,
			args: server.args.map(valueOf),
			env: pairs(server.env),
		};
	}
	const url = valueOf(server.url);
	endpointUrl(url, location, false);
	const headers = pairs(server.headers);
	if (headers.some(({ value }) => /[\r\n]/.test(value))) {
		throw new Error(`Invalid resolved MCP header at ${location}`);
	}
	return { name, type: server.type, url, headers };
};

/** Inspect references before validation so even a later failure is safe to report. */
const visitReferences = (
	raw: unknown,
	visit: (name: string, destination: string) => void,
): void => {
	const pending: { value: unknown; destination: string }[] = [
		{ value: raw, destination: "" },
	];
	while (pending.length) {
		const { value, destination } = pending.pop()!;
		if (Array.isArray(value)) {
			let options = destination === "args";
			value.forEach((child: unknown, index) => {
				if (child === "--") {
					options = false;
				}
				const previous: unknown = value[index - 1];
				const flag =
					options &&
					typeof previous === "string" &&
					/^(?:--?|\/)[A-Za-z][A-Za-z0-9_-]*$/.test(previous)
						? previous.replace(/^[-/]+/, "")
						: "";
				pending.push({ value: child, destination: flag });
			});
		} else if (value && typeof value === "object") {
			if (
				Object.hasOwn(value, "env") &&
				"env" in value &&
				typeof value.env === "string" &&
				/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.env)
			) {
				visit(value.env, destination);
			}
			for (const [field, child] of Object.entries(value)) {
				pending.push({ value: child, destination: field });
			}
		}
	}
};

/** Workspace replaces complete server definitions by name; this function never connects. */
export const loadMcpConfig = async (
	{ home, cwd }: { home: string; cwd: string },
	{
		environment = process.env,
		signal = new AbortController().signal,
		onSecrets,
	}: McpConfigOptions = {},
): Promise<RuntimeMcpServer[]> => {
	signal.throwIfAborted();
	const resolvedEnvironment: Record<string, string | undefined> =
		Object.create(null);
	const secrets = new Set<string>();
	const observe = (raw: unknown) =>
		visitReferences(raw, (name, destination) => {
			if (!Object.hasOwn(resolvedEnvironment, name)) {
				resolvedEnvironment[name] = Object.hasOwn(environment, name)
					? environment[name]
					: undefined;
			}
			const value = resolvedEnvironment[name];
			if (value !== undefined) {
				const named =
					isCredentialReferenceName(name) ||
					isCredentialReferenceName(destination);
				const credentials = named ? credentialValues(value) : [];
				if (destination === "url") {
					credentials.push(...endpointCredentials(value));
				}
				credentials.forEach((credential) => secrets.add(credential));
			}
		});
	// Wait for both layers before surfacing any error: the other layer may contain
	// references whose values must already be registered with the client's redactor.
	const layers = await Promise.allSettled(
		[...new Set([resolve(home), resolve(cwd)])].map((root) =>
			readConfig(root, signal, observe),
		),
	);
	onSecrets?.([...secrets]);
	const entries = layers.flatMap((layer) => {
		if (layer.status === "rejected") {
			throw layer.reason;
		}
		return layer.value;
	});
	const servers = new Map(entries.map((entry) => [entry.name, entry]));
	if (servers.size > CONFIG_LIMITS.servers) {
		throw new Error("Too many merged MCP servers");
	}
	signal.throwIfAborted();
	return [...servers.values()]
		.toSorted((a, b) => a.name.localeCompare(b.name))
		.map((entry) => resolveEntry(entry, resolvedEnvironment));
};
