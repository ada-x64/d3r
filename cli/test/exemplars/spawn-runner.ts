// Exemplar for the testing conventions doc; not consumed by
// production code. Demonstrates a "spawn + capture" seam that a
// real-subprocess fixture test exercises. When
// `feat/cli/bare-launch` or `feat/cli/install` lands, replace
// this exemplar with the real spawn call site.

import { spawn } from "node:child_process";

export interface RunResult {
	stdout: string;
	// Mirrors node's ChildProcess `close` semantics: exactly one of
	// `exitCode` or `signal` is non-null. A clean exit gives a
	// numeric `exitCode` and `signal === null`; a signal-killed
	// child gives `exitCode === null` and a `signal` name. Callers
	// must not collapse the two — a signal kill is not a clean exit.
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export const runAndCapture = async (
	binPath: string,
	args: readonly string[],
): Promise<RunResult> => {
	const child = spawn(process.execPath, [binPath, ...args], {
		stdio: ["ignore", "pipe", "inherit"],
	});

	const chunks: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
	});

	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({
				stdout: Buffer.concat(chunks).toString("utf8"),
				exitCode: code,
				signal,
			});
		});
	});
};
