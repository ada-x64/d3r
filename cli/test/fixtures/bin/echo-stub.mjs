#!/usr/bin/env node
// Fixture for the spawn-runner smoke test. Echoes argv[2] to
// stdout and exits with the numeric code in argv[3] (default 0).
const ARGV_OFFSET = 2;
const [msg = "", code = "0"] = process.argv.slice(ARGV_OFFSET);
process.stdout.write(msg);
process.exit(Number(code));
