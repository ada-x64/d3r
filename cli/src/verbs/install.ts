import { copyFile, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { defineCommand, type CommandDef } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { errMessage } from "../_lib.ts";
import { ADAPTERS, type AdapterEntry } from "../utils/data.ts";
import {
	die,
	isEnoent,
	piConfigDir,
	readInstalledVersion,
	resolveNpmCommand,
	runNpm,
} from "../utils/helpers.ts";

// Layout convention shared with `adapters/pi/scripts/build.ts`: agents
// are emitted under `<adapter>/dist/agents/*.md`. pi's subagent
// extension only ever discovers from `<piConfigDir>/agents/`, so the
// install verb mirrors them across after npm finishes. Adapters that
// ship no agents simply omit the directory; we treat ENOENT as a
// no-op rather than an error.
const ADAPTER_AGENTS_SUBDIR = path.join("dist", "agents");

// Workspace specs (e.g. `workspace:*`) are a pnpm protocol; npm refuses
// them with EUNSUPPORTEDPROTOCOL. For dev installs we resolve the
// workspace package on disk (pnpm symlinks it into our node_modules)
// and hand npm the absolute directory, which it installs as a local
// dependency. Resolution failure means the workspace isn't linked --
// caller must `pnpm install` first.
const resolveWorkspaceDir = (pkgName: string): string => {
	const req = createRequire(import.meta.url);
	const manifest = req.resolve(`${pkgName}/package.json`);
	return path.dirname(manifest);
};

export interface PlannedInstall {
	readonly entry: AdapterEntry;
	readonly id: string;
	readonly version: string;
	readonly target: string;
	readonly configDir: string;
	readonly npmCmd: string;
	readonly npmArgs: readonly string[];
	// True when the spec resolved to a workspace dev install (local
	// path handed to npm); materialization uses symlinks so live edits
	// in the source tree propagate without a reinstall. Published
	// versions copy instead.
	readonly isDev: boolean;
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
	//
	// `workspace:` specs come from a pnpm workspace pin and are not
	// understood by npm. Translate to the resolved on-disk directory so
	// `npm install <dir>` performs a local-path install of the dev copy.
	const installSpec = ((): string => {
		if (!version.startsWith("workspace:")) {
			return `${entry.pkg}@${version}`;
		}
		try {
			return resolveWorkspaceDir(entry.pkg);
		} catch {
			return die(
				`could not resolve workspace package ${entry.pkg}; run \`pnpm install\` at the repo root first`,
			);
		}
	})();
	const npmArgs = ["install", "--prefix", target, installSpec];
	const isDev = version.startsWith("workspace:");
	return { entry, id, version, target, configDir, npmCmd, npmArgs, isDev };
};

// Mirror the freshly-installed adapter's agents into
// `<piConfigDir>/agents/` so pi's vendored subagent loader finds
// them. Symlink for dev installs (live source edits visible without
// reinstall); copy for published versions (so the user dir doesn't
// hold a hard reference into a node_modules tree that may later be
// pruned). Replaces any pre-existing entry with the same basename to
// keep idempotent across upgrades; absent dist/agents/ is a no-op so
// future agent-less adapters are not penalised.
export const materializeAgents = async (
	plan: PlannedInstall,
): Promise<number> => {
	const srcDir = path.join(
		plan.target,
		"node_modules",
		plan.entry.pkg,
		ADAPTER_AGENTS_SUBDIR,
	);
	const dstDir = path.join(plan.configDir, "agents");
	const entries = await (async (): Promise<readonly string[]> => {
		try {
			const all = await readdir(srcDir);
			return all.filter((n) => n.endsWith(".md"));
		} catch (error) {
			if (isEnoent(error)) {
				return [];
			}
			throw error;
		}
	})();
	if (entries.length === 0) {
		return 0;
	}
	await mkdir(dstDir, { recursive: true });
	await Promise.all(
		entries.map(async (name) => {
			const src = path.join(srcDir, name);
			const dst = path.join(dstDir, name);
			await rm(dst, { force: true });
			await (plan.isDev ? symlink(src, dst) : copyFile(src, dst));
		}),
	);
	return entries.length;
};

export interface InstallOpts {
	readonly force?: boolean;
	readonly dryRun?: boolean;
}

export interface InstallDeps {
	readonly runner?: (cmd: string, args: readonly string[]) => Promise<number>;
	readonly readInstalled?: typeof readInstalledVersion;
	readonly materialize?: (plan: PlannedInstall) => Promise<number>;
}

export const executeInstall = async (
	spec: string,
	opts: InstallOpts,
	deps: InstallDeps = {},
): Promise<void> => {
	const runner = deps.runner ?? runNpm;
	const readInstalled = deps.readInstalled ?? readInstalledVersion;
	const materialize = deps.materialize ?? materializeAgents;
	const plan = planInstall(spec);
	if (opts.dryRun) {
		console.log(`${plan.npmCmd} ${plan.npmArgs.join(" ")}`);
		return;
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
		die(`failed to spawn npm: ${errMessage(error)}`);
		return;
	}
	if (code !== 0) {
		process.exit(code);
	}
	let materialized = 0;
	try {
		materialized = await materialize(plan);
	} catch (error) {
		die(`failed to materialize agents: ${errMessage(error)}`);
		return;
	}
	if (installed && installed !== plan.version) {
		console.log(`upgraded ${installed} -> ${plan.version}`);
	}
	if (materialized > 0) {
		console.log(`materialized ${materialized} agents into ${plan.configDir}`);
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
			default: "pi",
			description:
				"Adapter id, optionally with @<version> suffix (e.g. pi, pi@1.2.3); defaults to pi",
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
