import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { defineCommand } from "citty";

const HARNESS_FLAGS: Record<string, string[]> = {
	pi: ["--d3r"],
};

const SUPPORTED = new Set(Object.keys(HARNESS_FLAGS));

const resolveHarness = (): string => {
	const value = process.env.D3R_HARNESS ?? "pi";
	if (!SUPPORTED.has(value)) {
		throw new Error(
			`d3r: unsupported D3R_HARNESS=${value}; v1 only supports "pi"`,
		);
	}
	return value;
};

// POSIX convention: a process killed by signal N exits with 128 + N.
const SIGNAL_EXIT_BASE = 128;
// POSIX "command not found" exit code, reused for spawn ENOENT.
const EXIT_COMMAND_NOT_FOUND = 127;

type Signal = "SIGINT" | "SIGTERM";
const FORWARDED_SIGNALS: readonly Signal[] = ["SIGINT", "SIGTERM"];

export default defineCommand({
	meta: {
		name: "bare",
		description: "Launch the configured harness in routing mode.",
	},
	run: async (ctx) => {
		const harness = resolveHarness();
		const args = [...HARNESS_FLAGS[harness], ...ctx.rawArgs];
		const child = spawn(harness, args, { stdio: "inherit" });

		const forwarders = new Map<Signal, () => void>();
		for (const sig of FORWARDED_SIGNALS) {
			const fn = () => {
				child.kill(sig);
			};
			forwarders.set(sig, fn);
			process.on(sig, fn);
		}

		try {
			await new Promise<void>((resolve) => {
				child.on("error", (err) => {
					process.stderr.write(
						`d3r: failed to spawn ${harness}: ${err.message}; is it installed and on $PATH?\n`,
					);
					process.exitCode = EXIT_COMMAND_NOT_FOUND;
					resolve();
				});
				child.on("close", (code, signal) => {
					if (code !== null) {
						process.exitCode = code;
					} else if (signal) {
						const signo = osConstants.signals[signal];
						process.exitCode =
							typeof signo === "number" ? SIGNAL_EXIT_BASE + signo : 1;
					} else {
						process.exitCode = 1;
					}
					resolve();
				});
			});
		} finally {
			for (const [sig, fn] of forwarders) {
				process.removeListener(sig, fn);
			}
		}
	},
});
