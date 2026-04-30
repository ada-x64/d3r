// Exemplar for the testing conventions doc; not consumed by
// production code. Demonstrates a "spawn + capture" seam that a
// real-subprocess fixture test exercises. When
// `feat/cli/bare-launch` or `feat/cli/install` lands, replace
// this exemplar with the real spawn call site.

import { spawn } from "node:child_process";

export const runAndCapture = async (
	binPath: string,
	args: readonly string[],
): Promise<{ stdout: string; exitCode: number }> => {
	const child = spawn(process.execPath, [binPath, ...args], {
		stdio: ["ignore", "pipe", "inherit"],
	});

	const chunks: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
	});

	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(chunks).toString("utf8"),
				exitCode: code ?? 0,
			});
		});
	});
};
