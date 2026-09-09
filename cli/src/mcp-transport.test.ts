/* oxlint-disable no-magic-numbers -- Protocol IDs, status codes and synthetic PIDs are test fixtures. */
import {
	type ChildProcessWithoutNullStreams,
	type spawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type RuntimeMcpServer } from "@d3r/core/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMcpHttpTransport,
	createMcpStdioTransport,
	noRedirectFetch,
	type McpProcessIo,
} from "./mcp-transport.ts";
import { connectMcpTools, createMcpConnection } from "./mcp.ts";

/** Synthetic streams exercise the real SDK handshake without launching an MCP server. */
const peer = ({
	pid = 4321,
	respond = true,
	badTools = false,
	exitOnKill = true,
	signal = new AbortController().signal,
} = {}) => {
	const child = Object.assign(new EventEmitter(), {
		pid,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		unref: vi.fn(),
	}) as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough };
	const spawnProcess = vi.fn(() => {
		queueMicrotask(() => child.emit("spawn"));
		return child;
	});
	const kill = vi.fn(() => {
		if (exitOnKill) {
			queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
		}
		return true as const;
	});
	const io: McpProcessIo = {
		spawn: spawnProcess as unknown as typeof spawn,
		kill,
		platform: "linux",
	};
	const server = {
		name: "fixture",
		command: "node",
		args: ["fixture.js", "literal;not-a-shell"],
		env: [],
	};
	const transport = createMcpStdioTransport(
		server,
		{ cwd: process.cwd(), signal },
		io,
	);
	// oxlint-disable-next-line unicorn/prefer-add-event-listener -- SDK Transport uses callback properties, not EventTarget.
	transport.onerror = vi.fn();
	child.stdin.on("data", (chunk: Buffer) => {
		if (!respond) {
			return;
		}
		const request = JSON.parse(chunk.toString("utf8")) as {
			id?: number;
			method: string;
		};
		if (request.id === undefined) {
			return;
		}
		const result =
			request.method === "initialize"
				? {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					}
				: {
						tools: badTools
							? [{ name: "invalid", inputSchema: { type: "array" } }]
							: [],
					};
		queueMicrotask(() =>
			child.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
			),
		);
	});
	return { child, io, transport, server, kill, spawnProcess };
};

/** All HTTP and process effects below are injected; no network listeners or servers exist. */
describe("owned MCP transports", () => {
	afterEach(() => vi.useRealTimers());

	it("forces redirect:error for SDK POST and streaming GET requests", async () => {
		const fetchImpl = vi.fn(
			async (_url, init) =>
				new Response(null, { status: init?.method === "GET" ? 405 : 202 }),
		);
		const transport = createMcpHttpTransport(
			{
				type: "http",
				name: "remote",
				url: "https://first.invalid/mcp",
				headers: [{ name: "X-Api-Key", value: "fixture-secret" }],
			},
			fetchImpl,
		);
		await transport.start();
		try {
			await transport.send({
				jsonrpc: "2.0",
				method: "notifications/initialized",
			});
			await transport.resumeStream("cursor");
			expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual([
				"POST",
				"GET",
				"GET",
			]);
			for (const [, init] of fetchImpl.mock.calls) {
				expect(init.redirect).toBe("error");
				expect(new Headers(init.headers).get("X-Api-Key")).toBe(
					"fixture-secret",
				);
			}
		} finally {
			await transport.close();
		}
	});

	it.each(["POST", "GET"])(
		"rejects %s redirects without forwarding custom credentials",
		async (method) => {
			const fetchImpl = vi.fn(
				async () =>
					new Response(null, {
						status: 302,
						headers: { Location: "https://other.invalid/steal" },
					}),
			);
			const transport = createMcpHttpTransport(
				{
					type: "http",
					name: "remote",
					url: "https://first.invalid/mcp",
					headers: [{ name: "X-Api-Key", value: "fixture-secret" }],
				},
				fetchImpl,
			);
			// oxlint-disable-next-line unicorn/prefer-add-event-listener -- SDK Transport uses callback properties, not EventTarget.
			transport.onerror = vi.fn();
			await transport.start();
			try {
				await expect(
					method === "GET"
						? transport.resumeStream("cursor")
						: transport.send({
								jsonrpc: "2.0",
								method: "notifications/initialized",
							}),
				).rejects.toThrow(/redirect/);
				expect(fetchImpl).toHaveBeenCalledTimes(1);
				expect(fetchImpl).toHaveBeenCalledWith(
					expect.any(URL),
					expect.objectContaining({ redirect: "error", method }),
				);
			} finally {
				await transport.close();
			}
		},
	);

	it("overrides a caller attempting to enable redirect following", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		await noRedirectFetch(fetchImpl)("https://first.invalid", {
			redirect: "follow",
		});
		expect(fetchImpl).toHaveBeenCalledWith("https://first.invalid", {
			redirect: "error",
		});
	});

	it("spawns literal argv without a shell and kills its entire group once", async () => {
		const fixture = peer();
		await fixture.transport.start();
		expect(fixture.spawnProcess).toHaveBeenCalledWith(
			"node",
			fixture.server.args,
			expect.objectContaining({ detached: true, shell: false, stdio: "pipe" }),
		);
		await Promise.all([fixture.transport.close(), fixture.transport.close()]);
		expect(fixture.kill).toHaveBeenCalledTimes(1);
		expect(fixture.kill).toHaveBeenCalledWith(-4321, "SIGKILL");
		expect(fixture.child.stdin.destroyed).toBe(true);
	});

	it("kills remaining group members even after the leader exits", async () => {
		const fixture = peer();
		await fixture.transport.start();
		fixture.child.emit("exit", 0, null);
		await fixture.transport.close();
		expect(fixture.kill).toHaveBeenCalledWith(-4321, "SIGKILL");
	});

	it("cleans the group on cancellation during SDK initialization", async () => {
		const controller = new AbortController();
		const fixture = peer({ respond: false, signal: controller.signal });
		const pending = createMcpConnection(
			fixture.server,
			{ cwd: process.cwd(), signal: controller.signal, timeoutMs: 1000 },
			fixture.transport,
		);
		const rejected = expect(pending).rejects.toThrow(/cancelled/);
		await vi.waitFor(() =>
			expect(fixture.spawnProcess).toHaveBeenCalledTimes(1),
		);
		controller.abort(new Error("cancelled"));
		await rejected;
		await fixture.transport.close();
		expect(fixture.kill).toHaveBeenCalledWith(-4321, "SIGKILL");
	});

	it("rolls back all owned groups when later discovery fails", async () => {
		const first = peer({ pid: 4321 });
		const second = peer({ pid: 4322, badTools: true });
		const servers: RuntimeMcpServer[] = [
			first.server,
			{ ...second.server, name: "second" },
		];
		await expect(
			connectMcpTools(servers, {
				createConnection: (server, options) =>
					createMcpConnection(
						server,
						options,
						server.name === "second" ? second.transport : first.transport,
					),
			}),
		).rejects.toThrow();
		expect(first.kill).toHaveBeenCalledWith(-4321, "SIGKILL");
		expect(second.kill).toHaveBeenCalledWith(-4322, "SIGKILL");
	});

	it("bounds cleanup when a killed leader never reports exit", async () => {
		const fixture = peer({ exitOnKill: false });
		await fixture.transport.start();
		vi.useFakeTimers();
		const pending = fixture.transport.close();
		const rejected = expect(pending).rejects.toThrow(/cleanup timed out/);
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect(fixture.child.stdout.destroyed).toBe(true);
		expect(fixture.child.unref).toHaveBeenCalled();
	});

	it("fails closed on Windows rather than claiming process-tree isolation", async () => {
		const fixture = peer();
		const transport = createMcpStdioTransport(
			fixture.server,
			{ cwd: process.cwd(), signal: new AbortController().signal },
			{ ...fixture.io, platform: "win32" },
		);
		await expect(transport.start()).rejects.toThrow(/requires POSIX/);
		expect(fixture.spawnProcess).not.toHaveBeenCalled();
	});
});
