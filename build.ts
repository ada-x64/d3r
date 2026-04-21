// Build dispatcher.
// Usage: pnpm build [--target=pi]

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile as compilePi } from "./adapters/pi/compile.ts";

const { values } = parseArgs({
	options: { target: { type: "string", default: "pi" } },
});
const target = values.target ?? "pi";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(HERE, "core");
const distDir = path.join(HERE, "dist", target);

switch (target) {
	case "pi": {
		await compilePi(coreDir, distDir);
		break;
	}
	default: {
		console.error(`Unknown target: ${target}`);
		// oxlint-disable-next-line no-magic-numbers
		process.exit(1);
	}
}
