/* oxlint-disable no-magic-numbers -- Protocol examples, output bounds and test deadlines are acceptance data. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCritReview, type CritReady } from "./crit-process.ts";

/** Real subprocesses exercise argv, pipe decoding, exit and signal behavior together. */
const fixture = fileURLToPath(
	new URL("../test/fixtures/bin/crit-client.mjs", import.meta.url),
);
/** Independently specified Crit v0.20.1 wire metadata. */
const startup =
	"Started crit daemon at http://127.0.0.1:4321 (session abcdef123456, PID 99999999)\n";
/** Expected data is independent of the parser's regular expressions. */
const ready = { url: "http://127.0.0.1:4321", sessionId: "abcdef123456" };
/** A rendezvous lets assertions stay outside callbacks handled by production code. */
const deferred = <T>() => {
	const rendezvous: { resolve?: (value: T) => void } = {};
	const promise = new Promise<T>((fulfill) => {
		rendezvous.resolve = fulfill;
	});
	return { promise, resolve: rendezvous.resolve! };
};
/** Check actual termination rather than trusting a resolved bridge promise. */
const exited = async (pidFile: string) => {
	const pid = Number(await readFile(pidFile, "utf8"));
	await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
		timeout: 3000,
	});
};

/** The fixture substitutes only Crit, not the bridge's process or stream machinery. */
describe("runCritReview", () => {
	let cwd = "";
	const clients: { controller: AbortController; running: Promise<unknown> }[] =
		[];
	const sentinels: ChildProcess[] = [];
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "d3r-crit-process-"));
	});
	afterEach(async () => {
		vi.useRealTimers();
		for (const client of clients) {
			client.controller.abort();
		}
		await Promise.allSettled(clients.map(({ running }) => running));
		await Promise.all(
			sentinels.map(async (child) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					return;
				}
				const closed = once(child, "close");
				child.kill("SIGKILL");
				await closed;
			}),
		);
		clients.length = 0;
		sentinels.length = 0;
		await rm(cwd, { recursive: true, force: true });
	}, 10_000);

	const launch = (
		mode = "output",
		config: Record<string, unknown> = {},
		overrides: Partial<Parameters<typeof runCritReview>[0]> = {},
	) => {
		const controller = new AbortController();
		const notification = deferred<CritReady>();
		const notifications: CritReady[] = [];
		const pidFile = join(cwd, `client-${clients.length}.pid`);
		const running = runCritReview({
			executable: process.execPath,
			cwd,
			args: [fixture, mode, JSON.stringify({ ...config, pidFile })],
			signal: controller.signal,
			...overrides,
			onReady: (value) => {
				notifications.push(value);
				notification.resolve(value);
				return overrides.onReady?.(value);
			},
		});
		clients.push({ controller, running });
		void running.catch(() => {});
		return {
			running,
			controller,
			notification: notification.promise,
			notifications,
			pidFile,
		};
	};

	it("streams startup before human completion, preserves feedback and awaits ready delivery", async () => {
		const delivery = deferred<void>();
		const finishFile = join(cwd, "finish");
		const feedback =
			"Custom prompt: do not run `rm -rf anything`.\napproved: false\n";
		const f = launch(
			"gated",
			{ finishFile, feedback },
			{ onReady: () => delivery.promise },
		);
		let settled = false;
		void f.running.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		expect(await f.notification).toEqual(ready);
		expect(settled).toBe(false);
		await writeFile(finishFile, "finish");
		await exited(f.pidFile);
		expect(settled).toBe(false);
		delivery.resolve();
		expect(await f.running).toEqual({ ...ready, approved: true, feedback });
		expect(f.notifications).toEqual([ready]);
	});

	it("passes literal argv, cwd and the supplied environment without a shell", async () => {
		const args = [
			"--",
			"file with spaces.md",
			"; echo unsafe",
			"$HOME",
			"--flag=value",
		];
		const f = launch(
			"echo",
			{},
			{
				args: [fixture, "echo", "{}", ...args],
				env: { CRIT_PROCESS_FIXTURE: "explicit-value" },
			},
		);
		const result = await f.running;
		expect(JSON.parse(result.feedback)).toEqual({
			args,
			cwd,
			env: "explicit-value",
		});
	});

	it.each([
		[
			"Restarted crit daemon at http://localhost:80 (session 012345abcdef, PID 42)\n",
			"http://localhost:80",
			"012345abcdef",
		],
		[
			"Connected to crit daemon at http://127.0.0.1:65535/ (session 012345abcdef)\r\n",
			"http://127.0.0.1:65535/",
			"012345abcdef",
		],
	])(
		"accepts the verified startup variant %s",
		async (line, url, sessionId) => {
			const f = launch("output", { startup: line });
			expect(await f.running).toMatchObject({ url, sessionId, approved: true });
			expect(f.notifications).toEqual([{ url, sessionId }]);
		},
	);

	it("decodes split UTF-8 and metadata on separate pipes without interpreting stdout", async () => {
		const feedback = `Review \u00e9\u4e2d\ud83d\ude00\n${startup}approved: false\n`;
		const f = launch("output", {
			startup: `Diagnostic \u00e9\n${startup}`,
			fragment: true,
			feedback,
		});
		expect(await f.running).toEqual({ ...ready, approved: true, feedback });
		expect(f.notifications).toEqual([ready]);
	}, 10_000);

	it("returns false unchanged for not-approved, including possible daemon shutdown", async () => {
		const f = launch("output", { finish: "approved: false\n", feedback: "" });
		expect(await f.running).toEqual({
			...ready,
			approved: false,
			feedback: "",
		});
	});

	it("notifies once for repeated identical startup metadata", async () => {
		const f = launch("output", { startup: startup + startup });
		await f.running;
		expect(f.notifications).toEqual([ready]);
	});

	it.each([
		"https://127.0.0.1:4321",
		"http://example.com:4321",
		"http://localhost.evil:4321",
		"http://user:secret@localhost:4321",
		"http://localhost:4321@evil.example",
		"http://127.1:4321",
		"http://2130706433:4321",
		"http://0x7f000001:4321",
		"http://[::1]:4321",
		"http://0.0.0.0:4321",
		"http://localhost",
		"http://localhost:0",
		"http://localhost:65536",
		"http://localhost:4321/path",
		"http://localhost:4321?token=secret",
		"http://localhost:4321#fragment",
		"http://localhost:4321/../",
		String.raw`http://localhost:4321\@evil.example`,
	])("rejects unsafe startup URLs without disclosing them: %s", async (url) => {
		const f = launch("output", { startup: startup.replace(ready.url, url) });
		await expect(f.running).rejects.toThrow(
			/invalid startup metadata or a non-loopback HTTP URL/,
		);
		expect(f.notifications).toEqual([]);
	});

	it.each([
		startup.replace("abcdef123456", "ABCDEF123456"),
		startup.replace("abcdef123456", "abcdef12345"),
		startup.replace(", PID 99999999", ""),
		"Connected to crit daemon at http://localhost:4321 (session abcdef123456, PID 42)\n",
	])("rejects malformed startup/session metadata: %s", async (line) => {
		const f = launch("output", { startup: line });
		await expect(f.running).rejects.toThrow(/invalid startup metadata/);
		expect(f.notifications).toEqual([]);
	});

	it.each([
		startup.replace("4321", "4322"),
		startup.replace("abcdef123456", "012345abcdef"),
	])(
		"rejects conflicting metadata even after ready was delivered",
		async (conflict) => {
			const finishFile = join(cwd, "finish");
			const f = launch("gated", {
				finishFile,
				finish: `${conflict}approved: true\n`,
			});
			await f.notification;
			await writeFile(finishFile, "finish");
			await expect(f.running).rejects.toThrow("conflicting startup metadata");
			expect(f.notifications).toEqual([ready]);
		},
	);

	it.each([
		["", "without an approval marker"],
		["approved: true\napproved: true\n", "exactly one valid approval marker"],
		["approved: false\napproved: true\n", "exactly one valid approval marker"],
		["approved: True\n", "exactly one valid approval marker"],
		["approved: true extra\n", "exactly one valid approval marker"],
		["approved: true", "truncated metadata"],
		["approved: true\napproved: fal", "truncated metadata"],
		["prefix approved: true\n", "without an approval marker"],
	])(
		"requires exactly one complete, exact stderr approval marker: %s",
		async (finish, error) => {
			const f = launch("output", { finish, feedback: "approved: true\n" });
			await expect(f.running).rejects.toThrow(error);
		},
	);

	it.each(["", startup.trimEnd(), "Started crit daemon at http://127.0.0.1:"])(
		"rejects early exit with missing or truncated startup: %s",
		async (line) => {
			const f = launch("output", {
				startup: line,
				finish: "",
				feedback: "approved: true\n",
			});
			await expect(f.running).rejects.toThrow(
				"without complete startup metadata",
			);
			expect(f.notifications).toEqual([]);
		},
	);

	it("rejects nonzero exit even with approval, without leaking stderr or a cause", async () => {
		const f = launch("output", {
			finish: "approved: true\nPRIVATE_STDERR_TOKEN\n",
			exitCode: 7,
		});
		const actualError = await f.running.catch((error: unknown) => error);
		expect(actualError).toBeInstanceOf(Error);
		expect(actualError).toMatchObject({
			message: "Crit client exited with code 7",
		});
		expect(actualError).not.toHaveProperty("cause");
		expect(String(actualError)).not.toContain("PRIVATE_STDERR_TOKEN");
	});

	it("reports a missing executable without exposing its path", async () => {
		const f = launch(
			"output",
			{},
			{ executable: join(cwd, "PRIVATE_MISSING_EXECUTABLE") },
		);
		await expect(f.running).rejects.toThrow(
			"executable or working directory not found",
		);
	});

	it("sanitizes synchronous spawn failures", async () => {
		const f = launch("output", {}, { args: ["PRIVATE_ARG\0"] });
		await expect(f.running).rejects.toThrow(
			"Could not start Crit client; check executable, cwd and arguments",
		);
	});

	it.each(["stdout", "stderr"])(
		"rejects oversized %s by bytes, not Unicode characters",
		async (pipe) => {
			const f = launch("output", {
				repeat: { pipe, text: "\u00e9", count: 600_000 },
			});
			await expect(f.running).rejects.toThrow(
				`Crit ${pipe} exceeded the 1 MiB output limit`,
			);
			await exited(f.pidFile);
		},
	);

	it("preserves feedback exactly at the output byte limit", async () => {
		const f = launch("output", {
			feedback: "",
			repeat: { pipe: "stdout", text: "x", count: 1_048_576 },
		});
		const result = await f.running;
		expect(result.feedback).toBe("x".repeat(1_048_576));
	});

	it("rejects a pre-aborted signal without spawning or exposing its reason", async () => {
		const controller = new AbortController();
		controller.abort(new Error("PRIVATE_ABORT_REASON"));
		const f = launch("output", {}, { signal: controller.signal });
		await expect(f.running).rejects.toThrow(/^Crit review cancelled$/);
		await expect(readFile(f.pidFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("cancels a running client before any startup metadata", async () => {
		const f = launch("silent");
		await vi.waitFor(async () =>
			expect(await readFile(f.pidFile, "utf8")).toMatch(/^\d+$/),
		);
		f.controller.abort();
		await expect(f.running).rejects.toThrow(/^Crit review cancelled$/);
		await exited(f.pidFile);
		expect(f.notifications).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"sends SIGINT to its client; cancellation wins over a subsequent approval and exit zero",
		async () => {
			const signalFile = join(cwd, "signal");
			const f = launch("interrupt", { signalFile });
			await f.notification;
			f.controller.abort(new Error("PRIVATE_ABORT_REASON"));
			await expect(f.running).rejects.toThrow(/^Crit review cancelled$/);
			expect(await readFile(signalFile, "utf8")).toBe("SIGINT");
			await exited(f.pidFile);
		},
	);

	it.skipIf(process.platform === "win32")(
		"escalates after grace only against the owned client, not a reported daemon PID",
		async () => {
			const sentinel = spawn(process.execPath, [fixture, "silent", "{}"], {
				stdio: "ignore",
			});
			sentinels.push(sentinel);
			await once(sentinel, "spawn");
			const signalFile = join(cwd, "signal");
			const f = launch("stubborn", {
				signalFile,
				startup: startup.replace("99999999", String(sentinel.pid)),
			});
			await f.notification;
			f.controller.abort();
			await expect(f.running).rejects.toThrow(/^Crit review cancelled$/);
			expect(await readFile(signalFile, "utf8")).toBe("SIGINT");
			await exited(f.pidFile);
			expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
		},
		10_000,
	);

	it.each([false, true])(
		"ready delivery failure cancels without leaking its cause (async=%s)",
		async (asyncFailure) => {
			const f = launch(
				"gated",
				{ finishFile: join(cwd, "never-finish") },
				{
					onReady: () => {
						if (asyncFailure) {
							return Promise.reject(new Error("PRIVATE_CALLBACK_REASON"));
						}
						throw new Error("PRIVATE_CALLBACK_REASON");
					},
				},
			);
			await expect(f.running).rejects.toThrow(
				/^Crit ready notification failed; review cancelled$/,
			);
			expect(f.notifications).toEqual([ready]);
			await exited(f.pidFile);
		},
	);

	it("cancels while ready delivery is pending even after the client exits successfully", async () => {
		const delivery = deferred<void>();
		const f = launch("output", {}, { onReady: () => delivery.promise });
		await f.notification;
		await exited(f.pidFile);
		f.controller.abort();
		await expect(f.running).rejects.toThrow(/^Crit review cancelled$/);
		delivery.resolve();
	});

	it("does not time out human review after startup", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const finishFile = join(cwd, "finish");
		const f = launch("gated", { finishFile });
		await f.notification;
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		await writeFile(finishFile, "finish");
		expect(await f.running).toMatchObject({ approved: true });
	});

	it("bounds missing startup to about 15 seconds and terminates the client", async () => {
		const f = launch("silent");
		await expect(f.running).rejects.toThrow(
			"Crit startup timed out after 15 seconds",
		);
		await exited(f.pidFile);
		expect(f.notifications).toEqual([]);
	}, 25_000);
});
