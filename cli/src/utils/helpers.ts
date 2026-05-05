// this file is for general-purpose helper functions

import { spawn } from "node:child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { z } from "zod";

export const piConfigDir = (): string =>
	process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");

// Slice of `<piConfigDir>/settings.json` consumed by
// resolveNpmCommand. Passthrough so unrelated settings keys do not
// cause a refuse: the contract here is just "npmCommand if present".
const PiSettings = z
	.object({ npmCommand: z.string().optional() })
	.passthrough();

// Slice of an installed package's package.json consumed by
// readInstalledVersion. Same passthrough rationale.
const InstalledPackageJson = z
	.object({ version: z.string().optional() })
	.passthrough();

export const resolveNpmCommand = (configDir: string): string => {
	try {
		const raw = readFileSync(path.join(configDir, "settings.json"), "utf8");
		const result = PiSettings.safeParse(JSON.parse(raw));
		if (result.success && result.data.npmCommand !== undefined) {
			return result.data.npmCommand;
		}
	} catch {
		// missing or unparseable -> fall through
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
		const result = InstalledPackageJson.safeParse(JSON.parse(raw));
		if (result.success && result.data.version !== undefined) {
			return result.data.version;
		}
	} catch {
		// not installed
	}
	return null;
};

export const die = (msg: string): never => {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(1);
};

export const runNpm = (cmd: string, args: readonly string[]): Promise<number> =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, [...args], { stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? 1));
	});

export const isEnoent = (err: unknown): boolean =>
	typeof err === "object" &&
	err !== null &&
	(err as { code?: unknown }).code === "ENOENT";
