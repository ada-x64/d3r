import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** The actual compiled binary must negotiate without keys, model requests, or Pi. */
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
/** Bound a broken child even when it does not produce an initial protocol response. */
const CHILD_TIMEOUT_MS = 15_000;
/** Leave time to reap a timed-out process and verify its output. */
const TEST_TIMEOUT_MS = 30_000;

/** Native credential storage deliberately fails closed on Windows pending ACL support. */
describe.skipIf(process.platform === "win32")("native CLI binary", () => {
	const homes: string[] = [];
	afterEach(async () => {
		await Promise.all(
			homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
		);
	});

	it(
		"serves native initialization and exits cleanly on EOF with protocol-only stdout",
		async () => {
			const home = await mkdtemp(join(tmpdir(), "d3r-native-binary-"));
			homes.push(home);
			const child = spawn(process.execPath, [CLI, "acp"], {
				cwd: home,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					USERPROFILE: home,
					PI_TELEMETRY: "0",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "";
			let errors = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
			const closed = new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve(code));
			});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
				if (output.includes("\n")) {
					child.stdin.end();
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				errors += chunk.toString("utf8");
			});
			child.stdin.on("error", () => {});
			child.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: 1,
						clientCapabilities: { auth: { terminal: true } },
					},
				})}\n`,
			);
			try {
				expect(await closed, errors).toBe(0);
				const messages = output
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(messages).toHaveLength(1);
				expect(messages[0]).toMatchObject({
					jsonrpc: "2.0",
					id: 1,
					result: {
						protocolVersion: 1,
						agentInfo: { name: "d3r" },
						agentCapabilities: {
							loadSession: true,
							mcpCapabilities: { http: true, sse: false },
						},
					},
				});
			} finally {
				clearTimeout(timer);
				child.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
