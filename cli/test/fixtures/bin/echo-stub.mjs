#!/usr/bin/env node
// Fixture for the spawn-runner smoke test. Echoes argv[2] to
// stdout, then either exits with the numeric code in argv[3]
// (default 0) or, if argv[3] starts with "SIG", self-delivers
// that signal so the parent observes a signal-killed close.
const ARGV_OFFSET = 2;
const [msg = "", code = "0"] = process.argv.slice(ARGV_OFFSET);
process.stdout.write(msg);
if (code.startsWith("SIG")) {
	process.kill(process.pid, code);
} else {
	process.exit(Number(code));
}
