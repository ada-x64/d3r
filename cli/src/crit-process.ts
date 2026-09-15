import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

/** A local review location reported by the owned Crit client. */
export interface CritReady {
	readonly url: string;
	readonly sessionId: string;
}

/** False means not approved, including daemon shutdown; it grants no edit permission. */
export interface CritResult extends CritReady {
	readonly approved: boolean;
	readonly feedback: string;
}

/** Bound machine startup and cleanup, never the human review. */
const LIMITS = { startupMs: 15_000, graceMs: 1000, streamBytes: 1_048_576 };

/** The lexical restriction rejects URL normalization tricks, credentials and non-root paths. */
const localUrl = z
	.string()
	.regex(/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\/?$/)
	.url();

/** Crit v0.20.1 emits these complete stderr lines, independently of its feedback prompt. */
const parseReady = (line: string): CritReady | "invalid" | undefined => {
	const match =
		/^(?:Started|Restarted) crit daemon at (\S+) \(session ([0-9a-f]{12}), PID [0-9]+\)$/.exec(
			line,
		) ??
		/^Connected to crit daemon at (\S+) \(session ([0-9a-f]{12})\)$/.exec(line);
	if (!match) {
		return /^(?:Started|Restarted|Connected)\b/.test(line)
			? "invalid"
			: undefined;
	}
	const [, rawUrl, sessionId] = match;
	const url = localUrl.safeParse(rawUrl);
	return url.success ? { url: url.data, sessionId } : "invalid";
};

/** Run only the supplied client argv; feedback is data, never a command or authorization. */
export const runCritReview = async ({
	executable,
	cwd,
	args,
	signal,
	onReady,
	env,
}: {
	readonly executable: string;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly signal: AbortSignal;
	readonly onReady: (ready: CritReady) => void | Promise<void>;
	readonly env?: NodeJS.ProcessEnv;
}): Promise<CritResult> => {
	if (signal.aborted) {
		throw new Error("Crit review cancelled");
	}
	const client = (() => {
		try {
			return spawn(executable, [...args], {
				cwd,
				env,
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			throw new Error(
				"Could not start Crit client; check executable, cwd and arguments",
			);
		}
	})();
	// oxlint-disable-next-line max-statements -- Keep ownership and cleanup in one invocation-local lifecycle.
	return new Promise<CritResult>((resolve, reject) => {
		let ready: CritReady | undefined = undefined;
		let approved: boolean | undefined = undefined;
		let failure: string | undefined = undefined;
		let cancelled = false;
		let delivered = false;
		let closed = false;
		let settled = false;
		let killer: ReturnType<typeof setTimeout> | undefined = undefined;
		let feedback = "";
		let pending = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdout = new StringDecoder("utf8");
		const stderr = new StringDecoder("utf8");
		const startup = setTimeout(
			() =>
				fail(
					"Crit startup timed out after 15 seconds; check installation, review arguments, and that Crit quiet mode is disabled",
				),
			LIMITS.startupMs,
		);
		const settle = () => {
			if (settled || !closed) {
				return;
			}
			if (
				!failure &&
				!cancelled &&
				(!ready || !delivered || approved === undefined)
			) {
				return;
			}
			settled = true;
			clearTimeout(startup);
			clearTimeout(killer);
			signal.removeEventListener("abort", abort);
			if (cancelled) {
				reject(new Error("Crit review cancelled"));
			} else if (failure) {
				reject(new Error(failure));
			} else if (ready && approved !== undefined) {
				resolve({ ...ready, approved, feedback });
			}
		};
		const fail = (message: string) => {
			if (settled || failure) {
				return;
			}
			failure = message;
			clearTimeout(startup);
			if (!closed) {
				// Crit forwards SIGINT only to a daemon it started. Never signal the reported PID or a group.
				client.kill("SIGINT");
				killer = setTimeout(() => {
					client.kill("SIGKILL");
					client.stdout.destroy();
					client.stderr.destroy();
				}, LIMITS.graceMs);
			}
			settle();
		};
		const abort = () => {
			cancelled = true;
			fail("Crit review cancelled");
		};
		const acceptLine = (line: string) => {
			if (failure) {
				return;
			}
			const next = parseReady(line);
			if (next === "invalid") {
				fail(
					"Crit returned invalid startup metadata or a non-loopback HTTP URL; expected Crit v0.20.1 output",
				);
			} else if (next) {
				if (ready) {
					if (ready.url !== next.url || ready.sessionId !== next.sessionId) {
						fail("Crit returned conflicting startup metadata");
					}
					return;
				}
				ready = next;
				clearTimeout(startup);
				void Promise.resolve()
					.then(() => {
						if (!failure && !cancelled) {
							return onReady({ ...next });
						}
					})
					.then(
						() => {
							delivered = true;
							settle();
						},
						() => fail("Crit ready notification failed; review cancelled"),
					);
			} else if (line.startsWith("approved:")) {
				if (
					!/^approved: (?:true|false)$/.test(line) ||
					approved !== undefined
				) {
					fail("Crit must return exactly one valid approval marker");
				} else {
					approved = line === "approved: true";
				}
			}
		};
		client.stdout.on("data", (chunk: Buffer) => {
			if (failure) {
				return;
			}
			stdoutBytes += chunk.length;
			if (stdoutBytes > LIMITS.streamBytes) {
				fail("Crit stdout exceeded the 1 MiB output limit");
			} else {
				feedback += stdout.write(chunk);
			}
		});
		client.stderr.on("data", (chunk: Buffer) => {
			if (failure) {
				return;
			}
			stderrBytes += chunk.length;
			if (stderrBytes > LIMITS.streamBytes) {
				fail("Crit stderr exceeded the 1 MiB output limit");
				return;
			}
			pending += stderr.write(chunk);
			const lines = pending.split("\n");
			pending = lines.pop()!;
			for (const line of lines) {
				acceptLine(line.replace(/\r$/, ""));
			}
		});
		client.stdout.on("error", () => fail("Could not read Crit stdout"));
		client.stderr.on("error", () => fail("Could not read Crit stderr"));
		client.on("error", (error: NodeJS.ErrnoException) =>
			fail(
				error.code === "ENOENT"
					? "Crit executable or working directory not found; check installation and cwd"
					: "Crit client process failed; check executable and cwd",
			),
		);
		client.once("close", (code) => {
			closed = true;
			clearTimeout(startup);
			clearTimeout(killer);
			feedback += stdout.end();
			pending += stderr.end();
			if (code !== 0) {
				fail(
					`Crit client exited ${code === null ? "by signal" : `with code ${code}`}`,
				);
			} else if (!ready) {
				fail(
					"Crit exited without complete startup metadata; output may be truncated",
				);
			} else if (/^(?:Started|Restarted|Connected|approved:)/.test(pending)) {
				fail(
					"Crit returned truncated metadata; expected newline-terminated stderr markers",
				);
			} else if (approved === undefined) {
				fail("Crit exited without an approval marker; output may be truncated");
			}
			settle();
		});
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			abort();
		}
	});
};
