// This file is for constants and types.

import path from "path";

export interface AdapterEntry {
	readonly pkg: string;
	readonly target: (piConfigDir: string) => string;
}

export const ADAPTERS: Readonly<Record<string, AdapterEntry>> = {
	pi: {
		pkg: "@d3r/adapter-pi",
		target: (piConfigDir) => path.join(piConfigDir, "extensions", "d3r-tools"),
	},
};
