/* oxlint-disable init-declarations -- Each test owns temporary workspace roots initialized in beforeEach. */
/* oxlint-disable no-template-curly-in-string -- Expansion syntax is deliberately literal security test input. */
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "./resource-mcp.ts";

/** Config fixtures never start a transport or expose real process credentials. */
describe("MCP file configuration", () => {
	let base: string;
	let home: string;
	let cwd: string;
	const put = async (root: string, config: unknown) => {
		const path = join(root, ".agents", "mcp.json");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(config));
	};
	const load = (
		environment: Readonly<Record<string, string | undefined>> = {},
	) => loadMcpConfig({ home, cwd }, { environment });
	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), "d3r-mcp-config-"));
		home = join(base, "home");
		cwd = join(base, "parent", "workspace");
		await Promise.all([mkdir(home), mkdir(cwd, { recursive: true })]);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(base, { recursive: true, force: true });
	});

	it("registers credential references, including argv, before validation errors escape", async () => {
		await put(cwd, {
			mcpServers: {
				a: {
					command: "node",
					args: [{ env: "ARG_SECRET" }],
					env: { TOKEN: { env: "TOKEN_SECRET" }, MISSING: { env: "MISSING" } },
				},
				b: {
					url: "https://example.invalid",
					headers: { Authorization: { env: "HEADER_SECRET" } },
				},
			},
		});
		const environment = {
			ARG_SECRET: "argv-secret",
			TOKEN_SECRET: "env-secret",
			HEADER_SECRET: "header-secret\r\ninvalid",
		};
		const onSecrets = vi.fn();
		await expect(
			loadMcpConfig({ home, cwd }, { environment, onSecrets }),
		).rejects.toThrow(/Missing environment variable/);
		expect(onSecrets).toHaveBeenCalledTimes(1);
		expect(onSecrets).toHaveBeenCalledWith(
			expect.arrayContaining(Object.values(environment)),
		);
		expect(
			await readFile(join(cwd, ".agents", "mcp.json"), "utf8"),
		).not.toContain("argv-secret");
	});

	it("registers references from the other layer before reporting a malformed layer", async () => {
		await put(home, { unknown: true });
		await put(cwd, {
			mcpServers: {
				local: { command: "node", args: ["--token", { env: "VALUE" }] },
			},
		});
		const onSecrets = vi.fn();
		await expect(
			loadMcpConfig(
				{ home, cwd },
				{ environment: { VALUE: "registered-first" }, onSecrets },
			),
		).rejects.toThrow(/Invalid MCP configuration/);
		expect(onSecrets).toHaveBeenCalledWith(["registered-first"]);
	});

	it("uses exactly the registered values even if environment changes in the callback", async () => {
		await put(cwd, {
			mcpServers: {
				local: { command: "node", env: { TOKEN: { env: "VALUE" } } },
			},
		});
		const environment = { VALUE: "registered" };
		const onSecrets = vi.fn(() => {
			environment.VALUE = "changed-later";
		});
		const result = await loadMcpConfig(
			{ home, cwd },
			{ environment, onSecrets },
		);
		expect(onSecrets).toHaveBeenCalledWith(["registered"]);
		expect(result[0]).toMatchObject({
			env: [{ name: "TOKEN", value: "registered" }],
		});
	});

	it.each([
		"HOME",
		"PATH",
		"PASSWORD_FILE",
		"MAX_TOKENS",
		"TOKEN_LIMIT",
		"AUTH_ENABLED",
		"tokenLimit",
		"passwordFile",
	])(
		"does not register ordinary %s references as substring secrets",
		async (name) => {
			await put(cwd, {
				mcpServers: {
					local: {
						command: "node",
						env: { [name]: { env: name } },
						args: [{ env: name }],
					},
				},
			});
			const value = /HOME|PATH|FILE|File/.test(name) ? home : "1";
			const onSecrets = vi.fn();
			const result = await loadMcpConfig(
				{ home, cwd },
				{ environment: { [name]: value }, onSecrets },
			);
			expect(onSecrets).toHaveBeenCalledWith([]);
			expect(result[0]).toMatchObject({
				env: [{ name, value }],
				args: [value],
			});
		},
	);

	it("registers TOKEN and APIkey destinations before errors without registering HOME or short settings", async () => {
		await put(cwd, {
			mcpServers: {
				local: {
					command: "node",
					env: {
						HOME: { env: "HOME" },
						TOKEN_LIMIT: { env: "LIMIT" },
						MAX_TOKENS: { env: "LIMIT" },
						PASSWORD_FILE: { env: "HOME" },
						TOKEN: { env: "FIRST_VALUE" },
						APIkey: { env: "SECOND_VALUE" },
						MISSING: { env: "ABSENT" },
					},
				},
			},
		});
		const environment = {
			HOME: home,
			LIMIT: "1",
			FIRST_VALUE: "token-credential",
			SECOND_VALUE: "api-credential",
		};
		const onSecrets = vi.fn();
		await expect(
			loadMcpConfig({ home, cwd }, { environment, onSecrets }),
		).rejects.toThrow(/Missing environment variable/);
		expect(onSecrets).toHaveBeenCalledWith(
			expect.arrayContaining(["token-credential", "api-credential"]),
		);
		const [[registered]] = onSecrets.mock.calls;
		expect(registered.toSorted()).toEqual([
			"api-credential",
			"token-credential",
		]);
		expect(registered).not.toContain(home);
		expect(registered).not.toContain("1");
	});

	it("classifies argv using credential reference names or known credential flags", async () => {
		await put(cwd, {
			mcpServers: {
				local: {
					command: "node",
					args: [
						{ env: "SERVICE_TOKEN" },
						"--token",
						{ env: "VALUE" },
						"--api-key",
						{ env: "API_VALUE" },
						"--password-file",
						{ env: "HOME" },
						"--max-tokens",
						{ env: "MAX_TOKENS" },
						{ env: "ORDINARY" },
						"--",
						"--token",
						{ env: "HOME" },
					],
				},
			},
		});
		const onSecrets = vi.fn();
		await loadMcpConfig(
			{ home, cwd },
			{
				environment: {
					SERVICE_TOKEN: "named-credential",
					VALUE: "flag-credential",
					API_VALUE: "api-credential",
					HOME: home,
					MAX_TOKENS: "1",
					ORDINARY: "x",
				},
				onSecrets,
			},
		);
		const [[registered]] = onSecrets.mock.calls;
		expect(registered.toSorted()).toEqual([
			"api-credential",
			"flag-credential",
			"named-credential",
		]);
	});

	it("registers a cached ordinary reference when another use has a credential destination", async () => {
		await put(cwd, {
			mcpServers: {
				local: {
					command: "node",
					env: { TOKEN: { env: "SHARED" }, MODE: { env: "SHARED" } },
				},
			},
		});
		const onSecrets = vi.fn();
		await loadMcpConfig(
			{ home, cwd },
			{ environment: { SHARED: "shared-credential" }, onSecrets },
		);
		expect(onSecrets).toHaveBeenCalledWith(["shared-credential"]);
	});

	it("registers header and URL credentials without masking ordinary headers or entire endpoints", async () => {
		await put(cwd, {
			mcpServers: {
				remote: {
					url: { env: "ENDPOINT" },
					headers: {
						Authorization: { env: "HEADER_VALUE" },
						"X-Request-Limit": { env: "LIMIT" },
					},
				},
			},
		});
		const endpoint =
			"https://example.invalid/mcp?api_key=query%20credential&token_limit=1";
		const onSecrets = vi.fn();
		await loadMcpConfig(
			{ home, cwd },
			{
				environment: {
					ENDPOINT: endpoint,
					HEADER_VALUE: "Bearer header-credential",
					LIMIT: "1",
				},
				onSecrets,
			},
		);
		const [[registered]] = onSecrets.mock.calls;
		expect(registered.toSorted()).toEqual([
			"Bearer header-credential",
			"header-credential",
			"query credential",
			"query%20credential",
		]);
		expect(registered).not.toContain(endpoint);
		expect(registered).not.toContain("1");
	});

	it("returns no servers for absent files and does not discover parents", async () => {
		await put(dirname(cwd), {
			mcpServers: { ignored: { command: "never-run" } },
		});
		expect(await load()).toEqual([]);
	});

	it("merges whole definitions by server name with stable workspace precedence", async () => {
		await Promise.all([
			put(home, {
				mcpServers: {
					zebra: { command: "global" },
					shared: {
						type: "http",
						url: "https://example.invalid/mcp",
						headers: { Authorization: { env: "UNSET_SHADOWED_CREDENTIAL" } },
					},
				},
			}),
			put(cwd, {
				mcpServers: {
					shared: { command: "workspace" },
					alpha: {
						command: "node",
						args: ["server.js"],
						env: { NODE_ENV: "production" },
					},
				},
			}),
		]);
		expect(await load()).toEqual([
			{
				name: "alpha",
				command: "node",
				args: ["server.js"],
				env: [{ name: "NODE_ENV", value: "production" }],
			},
			{ name: "shared", command: "workspace", args: [], env: [] },
			{ name: "zebra", command: "global", args: [], env: [] },
		]);
	});

	it("reads coincident home/workspace once and supports explicit stdio type", async () => {
		await put(cwd, {
			mcpServers: { local: { type: "stdio", command: "node" } },
		});
		expect(await loadMcpConfig({ home: cwd, cwd })).toEqual([
			{ name: "local", command: "node", args: [], env: [] },
		]);
	});

	it("resolves environment references for argv, env, endpoint and headers only in memory", async () => {
		await put(cwd, {
			mcpServers: {
				local: {
					command: "node",
					args: ["server.js", "--api-key", { env: "TEST_TOKEN" }],
					env: { TOKEN: { env: "TEST_TOKEN" }, NODE_ENV: "test" },
				},
				remote: {
					url: { env: "TEST_ENDPOINT" },
					headers: {
						Authorization: { env: "TEST_AUTHORIZATION" },
						Accept: "application/json",
					},
				},
			},
		});
		const environment = {
			TEST_TOKEN: "fixture-secret",
			TEST_ENDPOINT: "https://example.invalid/mcp?token=fixture-secret",
			TEST_AUTHORIZATION: "Bearer fixture-secret",
		};
		const servers = await load(environment);
		expect(servers).toEqual([
			{
				name: "local",
				command: "node",
				args: ["server.js", "--api-key", "fixture-secret"],
				env: [
					{ name: "NODE_ENV", value: "test" },
					{ name: "TOKEN", value: "fixture-secret" },
				],
			},
			{
				name: "remote",
				type: "http",
				url: environment.TEST_ENDPOINT,
				headers: [
					{ name: "Accept", value: "application/json" },
					{ name: "Authorization", value: environment.TEST_AUTHORIZATION },
				],
			},
		]);
		expect(
			await readFile(join(cwd, ".agents", "mcp.json"), "utf8"),
		).not.toContain("fixture-secret");
	});

	it("uses process.env by default but never performs a second expansion", async () => {
		const literal = "$(do-not-execute) ${DO_NOT_EXPAND} %ALSO_LITERAL%";
		vi.stubEnv("D3R_MCP_TEST_VALUE", literal);
		await put(cwd, {
			mcpServers: {
				local: {
					command: "node",
					env: { TOKEN: { env: "D3R_MCP_TEST_VALUE" } },
				},
			},
		});
		expect(await loadMcpConfig({ home, cwd })).toEqual([
			{
				name: "local",
				command: "node",
				args: [],
				env: [{ name: "TOKEN", value: literal }],
			},
		]);
	});

	it("fails for missing or inherited references without falling back to an empty credential", async () => {
		await put(cwd, {
			mcpServers: {
				local: { command: "node", env: { TOKEN: { env: "MISSING_TOKEN" } } },
			},
		});
		await expect(load()).rejects.toThrow(
			"Missing environment variable MISSING_TOKEN",
		);
		const inherited = Object.create({
			MISSING_TOKEN: "must-not-use",
		}) as Record<string, string>;
		await expect(load(inherited)).rejects.toThrow(
			"Missing environment variable MISSING_TOKEN",
		);
	});

	it.each([
		{ command: "node", env: { TOKEN: "fixture-secret" } },
		{ command: "node", env: { client_secret: "fixture-secret" } },
		{ command: "node", env: { API_KEY: "fixture-secret" } },
		{ command: "node", env: { APP_CONFIG: "Bearer fixture-secret" } },
		{ command: "node", args: ["--password", "fixture-secret"] },
		{ command: "node", args: ["--api-key=fixture-secret"] },
		{ command: "node", args: ["Authorization: fixture-secret"] },
		{ command: "node", args: ["https://user:fixture-secret@example.invalid"] },
		{ command: "node", apiKey: "fixture-secret" },
		{
			url: "https://example.invalid",
			headers: { Authorization: "Bearer fixture-secret" },
		},
		{
			url: "https://example.invalid",
			headers: { "X-API-Key": "fixture-secret" },
		},
		{ url: "https://example.invalid?access_token=fixture-secret" },
		{ url: "https://user:fixture-secret@example.invalid/mcp" },
	])(
		"rejects inline credential configuration without echoing values: %j",
		async (server) => {
			await mkdir(join(cwd, ".git"));
			await put(cwd, { mcpServers: { local: server } });
			const failure = await load().catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).not.toContain("fixture-secret");
			expect((failure as Error).cause).toBeUndefined();
		},
	);

	it("does not ignore plaintext credentials in a shadowed global definition", async () => {
		await Promise.all([
			put(home, {
				mcpServers: {
					local: { command: "node", env: { TOKEN: "fixture-secret" } },
				},
			}),
			put(cwd, { mcpServers: { local: { command: "workspace" } } }),
		]);
		await expect(load()).rejects.toThrow(/Plaintext credential/);
	});

	it.each([
		{
			mcpServers: {
				local: {
					command: "node",
					env: { TOKEN: { env: "TEST", value: "inline" } },
				},
			},
		},
		{
			mcpServers: { local: { command: "node", env: { "BAD=NAME": "value" } } },
		},
		{ mcpServers: { local: { command: "node", env: [] } } },
		{ mcpServers: { local: { command: "node", args: "not-an-array" } } },
		{ mcpServers: { local: { command: "node", unknown: true } } },
		{
			mcpServers: {
				local: { command: "node", url: "https://example.invalid" },
			},
		},
		{ mcpServers: { local: { type: "sse", url: "https://example.invalid" } } },
		{ mcpServers: { local: { url: "file:///tmp/server" } } },
		{ mcpServers: { local: { url: "https://example.invalid#fragment" } } },
		{
			mcpServers: {
				local: {
					url: "https://example.invalid",
					headers: { "X-Value": "first", "x-value": "second" },
				},
			},
		},
		{
			mcpServers: {
				local: {
					url: "https://example.invalid",
					headers: { "X-Value": "bad\r\nInjected: value" },
				},
			},
		},
		{ servers: {} },
	])("rejects malformed or unsupported configuration: %j", async (config) => {
		await put(cwd, config);
		await expect(load()).rejects.toThrow();
	});

	it.each([
		"$(do-not-execute)",
		"`do-not-execute`",
		"${TOKEN}",
		"%TOKEN%",
		"${env:TOKEN}",
	])("rejects implicit string expansion: %s", async (value) => {
		await put(cwd, {
			mcpServers: { local: { command: "node", env: { VALUE: value } } },
		});
		await expect(load()).rejects.toThrow(/Expansion syntax/);
	});

	it("rejects malformed, duplicate-key and prototype JSON without leaking parser payloads", async () => {
		await mkdir(join(cwd, ".agents"));
		const fixtures = [
			'{"mcpServers":{"local":{"command":"fixture-secret",',
			'{"mcpServers":{"local":{"command":"node"},"local":{"command":"fixture-secret"}}}',
			'{"mcpServers":{"local":{"command":"node","env":{"MODE":"first","MODE":"fixture-secret"}}}}',
			'{"mcpServers":{"__proto__":{"command":"fixture-secret"}}}',
		];
		// Each write must settle before validating the next version of the same file.
		for (const text of fixtures) {
			// oxlint-disable-next-line no-await-in-loop -- Sequential versions of one configuration file.
			await writeFile(join(cwd, ".agents", "mcp.json"), text);
			// oxlint-disable-next-line no-await-in-loop -- Sequential versions of one configuration file.
			const failure = await load().catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).not.toContain("fixture-secret");
		}
	});

	it("rejects symlink escapes and pre-aborted loads", async () => {
		await put(home, { mcpServers: {} });
		await mkdir(join(cwd, ".agents"));
		await symlink(
			join(home, ".agents", "mcp.json"),
			join(cwd, ".agents", "mcp.json"),
			"file",
		);
		await expect(load()).rejects.toThrow(/Symlink/);
		await expect(
			loadMcpConfig(
				{ home, cwd },
				{ signal: AbortSignal.abort(new Error("cancelled")) },
			),
		).rejects.toThrow("cancelled");
	});

	it("validates referenced URL/header values without printing resolved secrets", async () => {
		await put(cwd, {
			mcpServers: {
				remote: {
					url: "https://example.invalid",
					headers: { Authorization: { env: "AUTH_HEADER" } },
				},
			},
		});
		await expect(
			load({ AUTH_HEADER: "fixture-secret\r\nInjected: true" }),
		).rejects.toThrow(/Invalid resolved MCP header/);
		await put(cwd, { mcpServers: { remote: { url: { env: "ENDPOINT" } } } });
		const failure = await load({
			ENDPOINT: "https://user:fixture-secret@example.invalid",
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain("fixture-secret");
	});

	it("only returns definitions, without executing configured programs", async () => {
		const marker = join(cwd, "must-not-exist");
		await put(cwd, {
			mcpServers: {
				inert: {
					command: process.execPath,
					args: [
						"-e",
						`require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
					],
				},
			},
		});
		expect(await load()).toHaveLength(1);
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
