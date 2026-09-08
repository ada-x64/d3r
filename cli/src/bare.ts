import { planPiLaunch } from "@d3r/adapter-pi/runtime";
import { spawn } from "node:child_process";
import { errMessage } from "./_lib.ts";
import { requireRegisteredVault } from "./vault-gate.ts";

/**
 * Bare-launch handler: forwards the user's argv to `pi` in routing mode
 * (`pi --d3r <...argv>`). v1 hardcodes `pi` as the harness; alternative
 * harnesses are deferred until concretely needed.
 */

const EXIT_USAGE = 1;
const EXIT_NOT_FOUND = 127;
const EXIT_SIGNAL_BASE = 128;
const ARGV_USER_OFFSET = 2;

const bare = async (argv: string[]): Promise<never> => {
	requireRegisteredVault(process.cwd());
	const plan = planPiLaunch(argv);
	const child = spawn(plan.command, [...plan.args], {
		stdio: "inherit",
		shell: plan.shell,
	});
	child.on("error", (err: NodeJS.ErrnoException) => {
		const msg =
			err.code === "ENOENT" ? "pi binary not found on PATH" : errMessage(err);
		process.stderr.write(`error: ${msg}\n`);
		process.exit(EXIT_NOT_FOUND);
	});
	child.on("exit", (code, signal) => {
		process.exit(code ?? (signal ? EXIT_SIGNAL_BASE : EXIT_USAGE));
	});

	return new Promise<never>(() => {});
};

export { ARGV_USER_OFFSET };
export default bare;
