// Refuse-to-run gate. Verbs that touch a vault MUST resolve a
// registered consumer symlink in `~/.d3r/config.yaml` whose realpath
// is (an ancestor of) the current working directory; otherwise we
// throw a typed error with an actionable hint and a deterministic
// non-zero exit code. Allow-listed verbs (init, migrate, install,
// version) bypass the gate; --help is short-circuited by citty
// before any setup hook fires.

import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const VAULT_DIR = path.join(".agents", "vault");

export class VaultGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultGateError";
		// Make exit code deterministic regardless of how the throw is
		// surfaced (citty's runMain, a per-subcommand setup hook, or the
		// bare path's explicit call).
		process.exitCode = 1;
	}
}

const errorMessage = (cwd: string): string =>
	[
		`error: no d3r vault registered for ${cwd}`,
		"hint: run `d3r init` to create one, or `d3r migrate` if you",
		"      have a legacy `.agents/vault/` to relocate.",
	].join("\n");

interface ParsedConfig {
	views: { consumer: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

const narrowConfig = (raw: unknown): ParsedConfig => {
	if (!isRecord(raw)) {
		return { views: [] };
	}
	const { views } = raw;
	if (!Array.isArray(views)) {
		return { views: [] };
	}
	const out: { consumer: string }[] = [];
	for (const v of views) {
		if (
			isRecord(v) &&
			typeof v.consumer === "string" &&
			v.consumer.length > 0
		) {
			out.push({ consumer: v.consumer });
		}
	}
	return { views: out };
};

const readConfig = async (): Promise<ParsedConfig> => {
	const configPath = path.join(homedir(), ".d3r", "config.yaml");
	let raw = "";
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			return { views: [] };
		}
		throw error;
	}
	return narrowConfig(parseYaml(raw) as unknown);
};

const ancestorVaultDirs = (cwd: string): string[] => {
	const out: string[] = [];
	let current = path.resolve(cwd);
	for (;;) {
		out.push(path.join(current, VAULT_DIR));
		const parent = path.dirname(current);
		if (parent === current) {
			return out;
		}
		current = parent;
	}
};

const realpathOrNull = async (target: string): Promise<string | null> => {
	try {
		return await realpath(target);
	} catch {
		return null;
	}
};

export const vaultGate = async (cwd: string): Promise<void> => {
	const config = await readConfig();
	if (config.views.length === 0) {
		throw new VaultGateError(errorMessage(cwd));
	}
	const ancestorReals = await Promise.all(
		ancestorVaultDirs(cwd).map((dir) => realpathOrNull(dir)),
	);
	const candidates = new Set<string>();
	for (const real of ancestorReals) {
		if (real !== null) {
			candidates.add(real);
		}
	}
	const consumerReals = await Promise.all(
		config.views.map((v) => realpathOrNull(v.consumer)),
	);
	for (const real of consumerReals) {
		if (real !== null && candidates.has(real)) {
			return;
		}
	}
	throw new VaultGateError(errorMessage(cwd));
};
