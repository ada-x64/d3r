import { planAcpLaunch, runAcp } from "@d3r/adapter-acp";
import { defineCommand, type CommandDef } from "citty";
import { errMessage } from "../_lib.ts";

/** Dependencies injected at the ACP command boundary. */
export interface AcpCommandDeps {
	readonly runner?: (argv: readonly string[]) => Promise<number>;
}

/** Run the ACP transport without writing non-protocol data to stdout. */
export const executeAcp = async (
	argv: readonly string[] = [],
	deps: AcpCommandDeps = {},
): Promise<void> => {
	const runner =
		deps.runner ?? ((args: readonly string[]) => runAcp(planAcpLaunch(args)));
	const code = await runner(argv).catch((error: unknown): never => {
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
		"terminal-login": {
			type: "boolean",
			description: "Open Pi in a terminal for provider authentication",
		},
	},
	run: ({ args }) =>
		executeAcp(args["terminal-login"] ? ["--terminal-login"] : []),
});

export default command as CommandDef;
