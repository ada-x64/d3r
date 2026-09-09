import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { type RuntimeMcpServer } from "@d3r/core/runtime";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	deserializeMessage,
	serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import {
	type FetchLike,
	type Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";

/** Force the policy at the fetch boundary, including SDK streaming GET/reconnect requests. */
export const noRedirectFetch =
	(fetchImpl: FetchLike = globalThis.fetch): FetchLike =>
	async (url, init) => {
		const response = await fetchImpl(url, { ...init, redirect: "error" });
		const redirectStart = 300;
		const redirectEnd = 400;
		if (
			response.redirected ||
			(response.status >= redirectStart && response.status < redirectEnd)
		) {
			await response.body?.cancel();
			throw new Error("MCP HTTP redirects are forbidden");
		}
		return response;
	};

/** All HTTP methods share one redirect-rejecting fetch; credentials never follow a Location. */
export const createMcpHttpTransport = (
	server: Extract<RuntimeMcpServer, { url: string }>,
	fetchImpl?: FetchLike,
): StreamableHTTPClientTransport =>
	new StreamableHTTPClientTransport(new URL(server.url), {
		fetch: noRedirectFetch(fetchImpl),
		requestInit: {
			redirect: "error",
			headers: Object.fromEntries(
				server.headers.map(({ name, value }) => [name, value]),
			),
		},
	});

/** A low-level seam allows tree-lifecycle tests without launching any MCP servers. */
export interface McpProcessIo {
	readonly spawn: typeof spawn;
	readonly kill: typeof process.kill;
	readonly platform: NodeJS.Platform;
}

/** Process groups bound cleanup; framed input also has a strict per-message byte ceiling. */
const PROCESS_LIMITS = { closeMs: 1000, messageBytes: 2_097_152, newline: 10 };

/** Own the POSIX group directly; SDK stdio owns only its immediate child. */
export const createMcpStdioTransport = (
	server: Extract<RuntimeMcpServer, { command: string }>,
	{ cwd, signal }: { cwd: string; signal: AbortSignal },
	io: McpProcessIo = { spawn, kill: process.kill, platform: process.platform },
): Transport => {
	let child: ChildProcessWithoutNullStreams | undefined = undefined;
	let started = false;
	let closed = false;
	let closing: Promise<void> | undefined = undefined;
	let pending = Buffer.alloc(0);
	const lifecycle: { markExited?: () => void } = {};
	const exited = new Promise<void>((resolve) => {
		lifecycle.markExited = resolve;
	});
	const report = (error: unknown) =>
		transport.onerror?.(
			error instanceof Error ? error : new Error("MCP stdio failure"),
		);
	const abort = () => {
		void transport.close().catch(report);
	};
	const transport: Transport = {
		start: async () => {
			if (started || closed) {
				throw new Error("MCP stdio transport already started or closed");
			}
			if (io.platform === "win32") {
				throw new Error(
					"Native MCP stdio process-tree ownership requires POSIX; use streamable HTTP on Windows",
				);
			}
			signal.throwIfAborted();
			started = true;
			child = io.spawn(server.command, [...server.args], {
				cwd,
				shell: false,
				detached: true,
				stdio: "pipe",
				env: {
					...getDefaultEnvironment(),
					...Object.fromEntries(
						server.env.map(({ name, value }) => [name, value]),
					),
				},
			});
			const running = child;
			running.stderr.resume();
			running.stdin.on("error", report);
			running.stdout.on("error", report);
			running.stdout.on("data", (chunk: Buffer) => {
				try {
					pending = Buffer.concat([pending, chunk]);
					for (
						let end = pending.indexOf(PROCESS_LIMITS.newline);
						end !== -1;
						end = pending.indexOf(PROCESS_LIMITS.newline)
					) {
						if (end > PROCESS_LIMITS.messageBytes) {
							throw new Error("MCP stdio message limit exceeded");
						}
						const line = pending.subarray(0, end).toString("utf8");
						pending = pending.subarray(end + 1);
						transport.onmessage?.(deserializeMessage(line));
					}
					if (pending.length > PROCESS_LIMITS.messageBytes) {
						throw new Error("MCP stdio message limit exceeded");
					}
				} catch (error) {
					report(error);
					abort();
				}
			});
			running.once("exit", () => {
				lifecycle.markExited?.();
				abort();
			});
			running.once("error", (error) => {
				lifecycle.markExited?.();
				report(error);
				abort();
			});
			signal.addEventListener("abort", abort, { once: true });
			const spawned = new Promise<void>((resolve, reject) => {
				running.once("spawn", () => {
					if (closed) {
						reject(new Error("MCP stdio cancelled during startup"));
					} else {
						resolve();
					}
				});
				running.once("error", reject);
				running.once("exit", () =>
					reject(new Error("MCP stdio exited during startup")),
				);
			});
			if (signal.aborted) {
				abort();
			}
			await spawned;
		},
		send: async (message) => {
			if (!child || closed) {
				throw new Error("MCP stdio transport is not running");
			}
			const input = child.stdin;
			await new Promise<void>((resolve, reject) => {
				input.write(serializeMessage(message), (error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		},
		close: () => {
			if (closing) {
				return closing;
			}
			closed = true;
			signal.removeEventListener("abort", abort);
			closing = Promise.resolve().then(async () => {
				let timer: ReturnType<typeof setTimeout> | undefined = undefined;
				try {
					if (child) {
						// Kill even after the leader exits: grandchildren may retain the group and pipes.
						if (child.pid) {
							try {
								io.kill(-child.pid, "SIGKILL");
							} catch (error) {
								if (
									!(
										error &&
										typeof error === "object" &&
										"code" in error &&
										error.code === "ESRCH"
									)
								) {
									throw error;
								}
							}
						}
						await Promise.race([
							exited,
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(new Error("MCP process-tree cleanup timed out")),
									PROCESS_LIMITS.closeMs,
								);
							}),
						]);
					}
				} finally {
					if (timer) {
						clearTimeout(timer);
					}
					child?.stdin.destroy();
					child?.stdout.destroy();
					child?.stderr.destroy();
					child?.unref();
					pending = Buffer.alloc(0);
					transport.onclose?.();
				}
			});
			return closing;
		},
	};
	return transport;
};
