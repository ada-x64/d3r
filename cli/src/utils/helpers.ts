// this file is for general-purpose helper functions

import { spawn } from "node:child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";

export const piConfigDir = (): string =>
	process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");

export const resolveNpmCommand = (configDir: string): string => {
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
