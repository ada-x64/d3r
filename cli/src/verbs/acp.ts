import { planAcpLaunch, runAcp } from "@d3r/adapter-acp";
import { defineCommand, type CommandDef } from "citty";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { errMessage } from "../_lib.ts";

/** Dependencies injected at the ACP command boundary. */
export interface AcpCommandDeps {
	readonly runner?: (argv: readonly string[]) => Promise<number>;
	readonly native?: (preset: string | undefined) => Promise<number>;
	readonly login?: () => Promise<void>;
	readonly legacy?: (argv: readonly string[]) => Promise<number>;
}

/** Keep native dependencies lazy so the legacy fallback remains independently usable. */
const nativeLaunch = async (preset: string | undefined): Promise<number> => {
	const [{ createNativeDeps }, { runNativeStdio }] = await Promise.all([
		import("../native.ts"),
		import("@d3r/adapter-acp/server"),
	]);
	return runNativeStdio(
		await createNativeDeps({ home: homedir(), version: pkg.version, preset }),
	);
};

/** Terminal authentication runs outside the protocol connection and exits when done. */
const terminalLogin = async (): Promise<void> => {
	const { runTerminalLogin } = await import("./auth.ts");
	await runTerminalLogin();
};

/** Native is the default; the old proxy is an explicit compatibility escape hatch. */
export const launchAcp = async (
	argv: readonly string[],
	deps: AcpCommandDeps = {},
): Promise<number> => {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			native: { type: "boolean" },
			legacy: { type: "boolean" },
			"terminal-login": { type: "boolean" },
			preset: { type: "string" },
		},
	});
	if (values.native && values.legacy) {
		throw new Error("Choose either --native or --legacy");
	}
	if (values.legacy) {
		if (values.preset !== undefined) {
			throw new Error("--preset is only available with the native runtime");
		}
		const legacy =
			deps.legacy ?? ((args: readonly string[]) => runAcp(planAcpLaunch(args)));
		return legacy(values["terminal-login"] ? ["--terminal-login"] : []);
	}
	if (values["terminal-login"]) {
		await (deps.login ?? terminalLogin)();
		return 0;
	}
	return (deps.native ?? nativeLaunch)(values.preset);
};

/** Run the ACP transport without writing non-protocol data to stdout. */
export const executeAcp = async (
	argv: readonly string[] = [],
	deps: AcpCommandDeps = {},
): Promise<void> => {
	const runner =
		deps.runner ?? ((args: readonly string[]) => launchAcp(args, deps));
	const code = await Promise.resolve()
		.then(() => runner(argv))
		.catch((error: unknown): never => {
			process.stderr.write(
				`error: failed to start ACP adapter: ${errMessage(error)}\n`,
			);
			process.exit(1);
		});
	if (code !== 0) {
		process.exit(code);
	}
};

const command = defineCommand({
	meta: {
		name: "acp",
		description: "Run D3R as an ACP agent over stdio",
	},
	args: {
		native: {
			type: "boolean",
			description: "Use the native runtime (default)",
		},
		legacy: { type: "boolean", description: "Use the previous Pi ACP proxy" },
		preset: {
			type: "string",
			description: "Select a named .agents/models.json preset",
		},
		"terminal-login": {
			type: "boolean",
			description: "Log in to a provider in an interactive terminal",
		},
	},
	run: ({ args }) =>
		executeAcp([
			...(args.native ? ["--native"] : []),
			...(args.legacy ? ["--legacy"] : []),
			...(args["terminal-login"] ? ["--terminal-login"] : []),
			...(args.preset === undefined ? [] : ["--preset", String(args.preset)]),
		]),
});

export default command as CommandDef;
