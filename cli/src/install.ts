import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };

interface AdapterEntry {
	pkg: string;
	shortName: string;
	resolveTarget: () => string;
}

const piConfigDir = (): string =>
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const ADAPTERS: Record<string, AdapterEntry> = {
	pi: {
		pkg: "@d3r/adapter-pi",
		shortName: "d3r-tools",
		resolveTarget: () => join(piConfigDir(), "extensions", "d3r-tools"),
	},
};

const parseAdapterSpec = (
	spec: string,
): { name: string; version: string | null } => {
	const at = spec.indexOf("@");
	if (at <= 0) {
		return { name: spec, version: null };
	}
	return { name: spec.slice(0, at), version: spec.slice(at + 1) || null };
};

const TWO_CHAR_RANGE_LEN = 2;
const stripRange = (value: string): string => {
	const trimmed = value.trim();
	const twoChar = trimmed.slice(0, TWO_CHAR_RANGE_LEN);
	if (twoChar === ">=" || twoChar === "<=") {
		return trimmed.slice(TWO_CHAR_RANGE_LEN).trim();
	}
	const first = trimmed.charAt(0);
	if (
		first === "^" ||
		first === "~" ||
		first === "=" ||
		first === ">" ||
		first === "<"
	) {
		return trimmed.slice(1).trim();
	}
	return trimmed;
};

const defaultAdapterVersion = (entry: AdapterEntry): string => {
	const deps = (pkg as { dependencies?: Record<string, string> }).dependencies;
	const raw = deps?.[entry.pkg];
	if (!raw || raw.length === 0) {
		throw new Error(
			`d3r install: ${entry.pkg} not declared in @d3r/cli's dependencies; this is a build error`,
		);
	}
	if (raw.startsWith("workspace:")) {
		process.stderr.write(
			`d3r install: ${entry.pkg} pinned to workspace:* in @d3r/cli; falling back to "latest" (publish wiring will land in a later task)\n`,
		);
		return "latest";
	}
	const cleaned = stripRange(raw);
	if (cleaned.length === 0) {
		throw new Error(
			`d3r install: ${entry.pkg} dependency value "${raw}" is empty after stripping range; this is a build error`,
		);
	}
	return cleaned;
};

const resolveNpm = (configDir: string): string[] => {
	try {
		const raw = readFileSync(join(configDir, "settings.json"), "utf8");
		const settings = JSON.parse(raw) as { npmCommand?: unknown };
		if (
			typeof settings.npmCommand === "string" &&
			settings.npmCommand.trim().length > 0
		) {
			return settings.npmCommand.trim().split(/\s+/);
		}
	} catch {
		// Settings file is optional; any read/parse failure falls through.
	}
	return ["npm"];
};

const readInstalledVersion = (
	target: string,
	pkgName: string,
): string | null => {
	try {
		const raw = readFileSync(
			join(target, "node_modules", pkgName, "package.json"),
			"utf8",
		);
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
};

const SAFE_TOKEN = /^[A-Za-z0-9_@:./=-]+$/;
const shellQuote = (s: string): string => {
	if (SAFE_TOKEN.test(s)) {
		return s;
	}
	return `'${s.replace(/'/g, String.raw`'\''`)}'`;
};

// POSIX convention: a process killed by signal N exits with 128 + N.
const SIGNAL_EXIT_BASE = 128;
// POSIX "command not found" exit code, reused for spawn ENOENT.
const EXIT_COMMAND_NOT_FOUND = 127;

export default defineCommand({
	meta: {
		name: "install",
		description: "Install an adapter package into the harness's user dir.",
	},
	args: {
		adapter: {
			type: "positional",
			required: true,
			description: 'Adapter to install (e.g. "pi" or "pi@1.2.3")',
		},
		force: {
			type: "boolean",
			description: "Reinstall even if the target version is already present",
		},
		"dry-run": {
			type: "boolean",
			description: "Print the planned npm command without executing",
		},
	},
	run: async (ctx) => {
		const { name, version: explicit } = parseAdapterSpec(
			String(ctx.args.adapter),
		);
		const entry = ADAPTERS[name];
		if (!entry) {
			throw new Error(
				`d3r install: unknown adapter "${name}"; v1 only supports "pi"`,
			);
		}
		const version = explicit ?? defaultAdapterVersion(entry);
		const target = entry.resolveTarget();
		const npmCmd = resolveNpm(piConfigDir());
		const specifier = `npm:${entry.pkg}@${version}`;
		const fullCmd = [...npmCmd, "install", "--prefix", target, specifier];

		if (ctx.args["dry-run"]) {
			process.stdout.write(`${fullCmd.map(shellQuote).join(" ")}\n`);
			return;
		}

		let oldVersion: string | null = null;
		if (!ctx.args.force) {
			const installed = readInstalledVersion(target, entry.pkg);
			if (installed === version) {
				process.stderr.write(`already installed at ${version}\n`);
				return;
			}
			oldVersion = installed;
		}

		if (ctx.args.force) {
			process.stderr.write(
				`force-reinstalling ${entry.pkg}@${version} into ${target}\n`,
			);
		} else if (oldVersion === null) {
			process.stderr.write(
				`installing ${entry.pkg}@${version} into ${target}\n`,
			);
		}

		const child = spawn(npmCmd[0], fullCmd.slice(1), { stdio: "inherit" });

		const result = await new Promise<{ ok: boolean }>((resolve) => {
			// `error` and `close` can both fire when the binary is missing; the
			// first event wins so the exit code is not overwritten.
			let settled = false;
			const settle = (assign: () => void, ok: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				assign();
				resolve({ ok });
			};
			child.on("error", (err) => {
				settle(() => {
					process.stderr.write(
						`d3r install: failed to spawn ${npmCmd[0]}: ${err.message}; is it installed and on $PATH?\n`,
					);
					process.exitCode = EXIT_COMMAND_NOT_FOUND;
				}, false);
			});
			child.on("close", (code, signal) => {
				settle(() => {
					if (code === 0) {
						return;
					}
					if (code !== null) {
						process.exitCode = code;
					} else if (signal) {
						const signo = osConstants.signals[signal];
						process.exitCode =
							typeof signo === "number" ? SIGNAL_EXIT_BASE + signo : 1;
					} else {
						process.exitCode = 1;
					}
				}, code === 0);
			});
		});

		if (!result.ok) {
			return;
		}
		if (!ctx.args.force && oldVersion !== null && oldVersion !== version) {
			process.stderr.write(`upgraded ${oldVersion} -> ${version}\n`);
		}
	},
});
