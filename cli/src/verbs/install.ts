import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CommandDef } from "citty";
// oxlint-disable-next-line no-duplicate-imports
import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };

interface AdapterEntry {
	readonly pkg: string;
	readonly target: (piConfigDir: string) => string;
}

export const ADAPTERS: Readonly<Record<string, AdapterEntry>> = {
	pi: {
		pkg: "@d3r/adapter-pi",
		target: (piConfigDir) => path.join(piConfigDir, "extensions", "d3r-tools"),
	},
};

const piConfigDir = (): string =>
	process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");

const resolveNpmCommand = (configDir: string): string => {
	try {
		const raw = readFileSync(path.join(configDir, "settings.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			"npmCommand" in parsed &&
			typeof (parsed as { npmCommand: unknown }).npmCommand === "string"
		) {
			return (parsed as { npmCommand: string }).npmCommand;
		}
	} catch {
		// missing or unparseable → fall through
	}
	return "npm";
};

export const readInstalledVersion = (
	target: string,
	pkgName: string,
): string | null => {
	try {
		const raw = readFileSync(
			path.join(target, "node_modules", pkgName, "package.json"),
			"utf8",
		);
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			"version" in parsed &&
			typeof (parsed as { version: unknown }).version === "string"
		) {
			return (parsed as { version: string }).version;
		}
	} catch {
		// not installed
	}
	return null;
};

const die = (msg: string): never => {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(1);
};

export const runNpm = (cmd: string, args: readonly string[]): Promise<number> =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, [...args], { stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? 1));
	});

export interface PlannedInstall {
	readonly entry: AdapterEntry;
	readonly id: string;
	readonly version: string;
	readonly target: string;
	readonly npmCmd: string;
	readonly npmArgs: readonly string[];
}

export const planInstall = (spec: string): PlannedInstall => {
	const at = spec.indexOf("@");
	const id = at === -1 ? spec : spec.slice(0, at);
	// Empty version override (e.g. `pi@`) is treated as "no override"
	// so the pinned version is used; otherwise the empty string would
	// defeat the `?? pinned` fallback and produce a malformed spec.
	const rawOverride = at === -1 ? undefined : spec.slice(at + 1);
	const versionOverride =
		rawOverride === undefined || rawOverride === "" ? undefined : rawOverride;

	const entry = ADAPTERS[id];
	if (!entry) {
		return die(
			`unknown adapter '${id}' (known: ${Object.keys(ADAPTERS).join(", ")})`,
		);
	}
	const pinned = (pkg as { dependencies?: Record<string, string> })
		.dependencies?.[entry.pkg];
	if (!pinned) {
		return die(`no version pinned for ${entry.pkg} in CLI package.json`);
	}
	const version = versionOverride ?? pinned;
	const configDir = piConfigDir();
	const target = entry.target(configDir);
	const npmCmd = resolveNpmCommand(configDir);
	// Plain `<pkg>@<ver>`: the bare `npm:` alias prefix used in the
	// strawman provided no value (no LHS alias name, on-disk dir matches
	// the registry name) and only obscured npm error output. If a future
	// adapter genuinely needs an alias, this and `readInstalledVersion`'s
	// read path must move together.
	const npmArgs = ["install", "--prefix", target, `${entry.pkg}@${version}`];
	return { entry, id, version, target, npmCmd, npmArgs };
};

export interface InstallOpts {
	readonly force?: boolean;
	readonly dryRun?: boolean;
}

export interface InstallDeps {
	readonly runner?: (cmd: string, args: readonly string[]) => Promise<number>;
	readonly readInstalled?: typeof readInstalledVersion;
}

const isEnoent = (err: unknown): boolean =>
	typeof err === "object" &&
	err !== null &&
	(err as { code?: unknown }).code === "ENOENT";

export const executeInstall = async (
	spec: string,
	opts: InstallOpts,
	deps: InstallDeps = {},
): Promise<void> => {
	const runner = deps.runner ?? runNpm;
	const readInstalled = deps.readInstalled ?? readInstalledVersion;
	const plan = planInstall(spec);
	if (opts.dryRun) {
		console.log(`${plan.npmCmd} ${plan.npmArgs.join(" ")}`);
		return;
	}
	if (plan.version.startsWith("workspace:")) {
		die(
			`dev install detected (${plan.version}); pass an explicit version: d3r install ${plan.id}@<version>`,
		);
	}
	const installed = readInstalled(plan.target, plan.entry.pkg);
	if (installed && installed === plan.version && !opts.force) {
		console.log(`already installed at ${plan.version}`);
		return;
	}
	let code = 1;
	try {
		code = await runner(plan.npmCmd, plan.npmArgs);
	} catch (error) {
		if (isEnoent(error)) {
			die(`npm not found on PATH (tried '${plan.npmCmd}')`);
		}
		die(
			`failed to spawn npm: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	if (code !== 0) {
		process.exit(code);
	}
	if (installed && installed !== plan.version) {
		console.log(`upgraded ${installed} -> ${plan.version}`);
	}
};

const command = defineCommand({
	meta: {
		name: "install",
		description: "Install an adapter package into the harness's user dir",
	},
	args: {
		adapter: {
			type: "positional",
			required: true,
			description:
				"Adapter id, optionally with @<version> suffix (e.g. pi, pi@1.2.3)",
		},
		force: {
			type: "boolean",
			description: "Re-run install even if already at the requested version",
		},
		"dry-run": {
			type: "boolean",
			description: "Print the planned npm command without executing",
		},
	},
	run: async ({ args }) => {
		await executeInstall(String(args.adapter), {
			force: Boolean(args.force),
			dryRun: Boolean(args["dry-run"]),
		});
	},
});

export default command as CommandDef;
