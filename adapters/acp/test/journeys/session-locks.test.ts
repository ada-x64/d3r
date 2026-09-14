import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type StoredSession } from "../../store.ts";

/** Both src and dist runners exercise the built native process, not the in-process harness.
 * Requires pnpm build and Node's registerHooks support (22.15+/24+).
 */
const OWNER = fileURLToPath(
	new URL("../fixtures/session-owner.mjs", import.meta.url),
);
/** Leave room for the fixture watchdog and cleanup, without wall-clock recovery sleeps. */
const TIMEOUT = { test: 40_000, observation: 10_000 };
/** Raw disk inspection must not bypass store.get's refusal of durable intents. */
const text = (path: string) => fs.readFile(path, "utf8");
const lastRecord = async (path: string) => {
	const saved = JSON.parse(await text(path)) as StoredSession;
	return saved.records.at(-1);
};
/** A small transport wrapper only: no duplicate native feature harness. */
const sessionOwner = (home: string, cwd: string, mode: string) => {
	const child = spawn(process.execPath, [OWNER, home, mode], {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			USERPROFILE: home,
			PI_TELEMETRY: "0",
		},
		stdio: ["pipe", "pipe", "pipe", "ipc"],
	});
	const observations: unknown[] = [];
	const updates: unknown[] = [];
	const permissions: unknown[] = [];
	let errors = "";
	child.on("message", (message) => observations.push(message));
	child.on("error", (error) => {
		errors += String(error);
	});
	child.stderr!.on("data", (chunk: Buffer) => {
		errors += chunk.toString();
	});
	child.stdin!.on("error", () => {});
	const closed = new Promise((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	const peer = client()
		.onRequest("session/request_permission", ({ params }) => {
			permissions.push(params);
			return {
				outcome: {
					outcome: "selected",
					optionId: params.options.find(({ kind }) => kind === "allow_once")!
						.optionId,
				},
			};
		})
		.onNotification("session/update", ({ params }) => {
			updates.push(params.update);
		})
		.connect(
			ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!)),
		);
	return {
		child,
		peer,
		observations,
		updates,
		permissions,
		initialize: async () => {
			try {
				await peer.agent.request("initialize", { protocolVersion: 1 });
			} catch (error) {
				throw new Error(`Owner startup failed: ${errors}`, { cause: error });
			}
		},
		load: (sessionId: string) =>
			peer.agent.request("session/load", { sessionId, cwd, mcpServers: [] }),
		prompt: (sessionId: string) =>
			peer.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Write marker.txt exactly once." }],
			}),
		observe: async (calls: {
			runtime: number;
			model: number;
			tools: string[];
		}) => {
			const offset = observations.length;
			child.send("observe");
			await expect
				.poll(() => observations.slice(offset), {
					timeout: TIMEOUT.observation,
				})
				.toContainEqual({ event: "observed", calls });
		},
		stop: async () => {
			child.kill("SIGKILL");
			peer.close();
			return closed;
		},
	};
};

/** Linux/WSL procfs identifies an owner by boot, PID namespace and process start ticks. */
describe.skipIf(process.platform !== "linux")(
	"session lock subprocess journeys",
	() => {
		const children: ReturnType<typeof sessionOwner>[] = [];
		const roots: string[] = [];
		const start = async (home: string, cwd: string, mode: string) => {
			const owner = sessionOwner(home, cwd, mode);
			children.push(owner);
			await owner.initialize();
			return owner;
		};
		afterEach(async () => {
			await Promise.all(children.splice(0).map((owner) => owner.stop()));
			await Promise.all(
				roots
					.splice(0)
					.map((root) => fs.rm(root, { recursive: true, force: true })),
			);
		});

		it.each(["idle", "inflight"])(
			"reclaims a killed %s owner without replaying work or rolling back intent",
			// oxlint-disable-next-line max-statements -- One lifecycle proves contention, crash recovery and no replay together.
			async (mode) => {
				const root = await fs.mkdtemp(
					join(await fs.realpath(tmpdir()), "d3r-lock-"),
				);
				roots.push(root);
				const home = join(root, "home");
				const cwd = join(root, "workspace");
				const marker = join(cwd, "marker.txt");
				await Promise.all([
					fs.mkdir(home),
					fs.mkdir(join(cwd, ".agents", "vault"), { recursive: true }),
				]);
				const a = await start(home, cwd, mode);
				const { sessionId } = await a.peer.agent.request("session/new", {
					cwd,
					mcpServers: [],
				});
				await a.peer.agent.request("session/set_config_option", {
					sessionId,
					configId: "model",
					value: "fixture/offline",
				});
				const sessions = join(home, ".agents/d3r/private/sessions");
				const sessionFile = join(sessions, `${sessionId}.json`);
				const lock = sessionFile.replace(/\.json$/, ".lock");
				const claims = () => fs.readdir(lock);
				const [claim] = await claims();
				const claimText = await text(join(lock, claim));
				expect(await claims()).toEqual([claim]);
				expect(JSON.parse(claimText)).toMatchObject({
					id: claim.replace(/\.json$/, ""),
					owner: { pid: a.child.pid, platform: "linux" },
				});
				const identity = await fs.stat(lock);
				expect(identity.isDirectory()).toBe(true);

				const contender = await start(home, cwd, "restore-only");
				await expect(contender.load(sessionId)).rejects.toThrow(
					/live D3R process/,
				);
				await contender.observe({ runtime: 0, model: 0, tools: [] });
				expect(await claims()).toEqual([claim]);
				expect(await text(join(lock, claim))).toBe(claimText);
				await contender.stop();

				expect(await a.prompt(sessionId)).toEqual({ stopReason: "end_turn" });
				expect(await text(marker)).toBe("written once\n");
				await expect(lastRecord(sessionFile)).resolves.toMatchObject({
					kind: "checkpoint",
					state: {
						runtime: { format: "d3r.native", inner: { orchestrated: true } },
					},
				});
				await a.observe({ runtime: 1, model: 2, tools: ["write_file"] });
				let pending: Promise<unknown> = Promise.resolve();
				if (mode === "inflight") {
					pending = a.prompt(sessionId).catch(() => {});
					await expect
						.poll(() => a.observations, { timeout: TIMEOUT.observation })
						.toContainEqual({ event: "gate" });
					await expect(lastRecord(sessionFile)).resolves.toEqual({
						kind: "intent",
						operation: "prompt",
					});
				}
				const durable = await text(sessionFile);
				expect(await a.stop()).toEqual({ code: null, signal: "SIGKILL" });
				await pending;
				expect(await claims()).toEqual([claim]);
				expect(await text(join(lock, claim))).toBe(claimText);
				await fs.writeFile(marker, "external edit after crash\n");

				const b = await start(home, cwd, "restore-only");
				if (mode === "inflight") {
					await expect(b.load(sessionId)).rejects.toThrow(
						/incomplete mutation; automatic recovery is unsafe/,
					);
					expect(await text(sessionFile)).toBe(durable);
					expect(b.updates).toEqual([]);
				} else {
					await b.load(sessionId);
					const [replacement] = await claims();
					expect(await claims()).toEqual([replacement]);
					expect(replacement).not.toBe(claim);
					expect(JSON.parse(await text(join(lock, replacement)))).toMatchObject(
						{ owner: { pid: b.child.pid } },
					);
					expect(b.updates).toContainEqual(
						expect.objectContaining({
							sessionUpdate: "tool_call_update",
							status: "completed",
						}),
					);
					await b.peer.agent.request("session/close", { sessionId });
				}
				await b.observe({ runtime: 0, model: 0, tools: [] });
				expect(b.permissions).toEqual([]);
				expect(await text(marker)).toBe("external edit after crash\n");
				expect(await claims()).toEqual([]);
				expect(await fs.stat(lock)).toMatchObject({
					ino: identity.ino,
					dev: identity.dev,
				});
			},
			TIMEOUT.test,
		);
	},
);
