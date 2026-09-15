/* oxlint-disable no-magic-numbers -- Fixture byte counts, exit codes and delays are test data. */
import { existsSync, writeFileSync } from "node:fs";

/** Stand in for the Crit client only: no daemon, HTTP, credentials or browser. */
const [mode, json, ...args] = process.argv.slice(2);
/** Test-controlled wire output and filesystem rendezvous points. */
const config = JSON.parse(json);
/** A failed test must not leave a fixture alive indefinitely. */
const watchdog = setTimeout(() => process.exit(91), 40_000);

/** Deliberate fragmentation exercises UTF-8 and line boundaries across pipe reads. */
const write = async (stream, text) => {
	if (!config.fragment) {
		await new Promise((resolve) => stream.write(text, resolve));
		return;
	}
	await new Promise((resolve) => {
		const bytes = Buffer.from(text);
		let offset = 0;
		const timer = setInterval(() => {
			stream.write(bytes.subarray(offset, offset + 1));
			offset += 1;
			if (offset >= bytes.length) {
				clearInterval(timer);
				resolve();
			}
		}, 2);
	});
};

/** Flush the chosen feedback independently from the machine-readable stderr marker. */
const finish = async () => {
	const feedback =
		mode === "echo"
			? JSON.stringify({
					args,
					cwd: process.cwd(),
					env: process.env.CRIT_PROCESS_FIXTURE,
				})
			: (config.feedback ?? "Reviewer feedback\n");
	await write(process.stdout, feedback);
	if (config.repeat) {
		await write(
			process[config.repeat.pipe],
			config.repeat.text.repeat(config.repeat.count),
		);
	}
	await write(process.stderr, config.finish ?? "approved: true\n");
	clearTimeout(watchdog);
	process.exitCode = config.exitCode ?? 0;
};

if (config.pidFile) {
	writeFileSync(config.pidFile, String(process.pid));
}
if (mode === "interrupt" || mode === "stubborn") {
	process.on("SIGINT", () => {
		writeFileSync(config.signalFile, "SIGINT");
		if (mode === "interrupt") {
			void finish();
		}
	});
}
if (mode !== "silent") {
	await write(
		process.stderr,
		config.startup ??
			"Started crit daemon at http://127.0.0.1:4321 (session abcdef123456, PID 99999999)\n",
	);
}
if (mode === "gated") {
	await new Promise((resolve) => {
		const timer = setInterval(() => {
			if (existsSync(config.finishFile)) {
				clearInterval(timer);
				resolve();
			}
		}, 5);
	});
}
if (mode === "output" || mode === "echo" || mode === "gated") {
	await finish();
}
