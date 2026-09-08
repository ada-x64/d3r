import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	ModelConfig,
	resolveModelConfig,
	type ModelConfigError,
	type ResolvedModelConfig,
} from "@d3r/core/model-config";
import { fail, ok, type Result } from "@d3r/core/result";
import { isEnoent } from "./utils/helpers.ts";

/** The caller establishes the workspace and home roots, not the process cwd. */
export interface ModelConfigRoots {
	readonly home: string;
	readonly cwd: string;
}

/** Only successfully parsed, present files appear in provenance. */
export interface LoadedModelConfig {
	readonly config: ResolvedModelConfig;
	readonly sources: readonly string[];
}

/** Failures identify a file or root without including its potentially sensitive bytes. */
export type ModelConfigLoadError =
	| ModelConfigError
	| { readonly code: "invalid-root"; readonly root: "home" | "cwd" }
	| {
			readonly code: "read-failed" | "invalid-json" | "invalid-config";
			readonly path: string;
	  };

/** Missing files are optional; unreadable or malformed files must never trigger fallback. */
const readLayer = async (
	path: string,
): Promise<Result<ModelConfig | null, ModelConfigLoadError>> => {
	let raw = "";
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		return isEnoent(error) ? ok(null) : fail({ code: "read-failed", path });
	}
	let value: unknown = null;
	try {
		value = JSON.parse(raw);
	} catch {
		return fail({ code: "invalid-json", path });
	}
	const parsed = ModelConfig.safeParse(value);
	return parsed.success
		? ok(parsed.data)
		: fail({ code: "invalid-config", path });
};

/** Read global then workspace .agents model configuration without writes or provider calls. */
export const loadModelConfig = async (
	roots: ModelConfigRoots,
): Promise<Result<LoadedModelConfig, ModelConfigLoadError>> => {
	for (const root of ["home", "cwd"] as const) {
		if (!isAbsolute(roots[root])) {
			return fail({ code: "invalid-root", root });
		}
	}
	const paths = [
		...new Set([
			join(roots.home, ".agents", "models.json"),
			join(roots.cwd, ".agents", "models.json"),
		]),
	];
	const reads = await Promise.all(
		paths.map(async (path) => ({ path, result: await readLayer(path) })),
	);
	const layers: ModelConfig[] = [];
	const sources: string[] = [];
	for (const { path, result } of reads) {
		if (!result.ok) {
			return result;
		}
		if (result.value !== null) {
			layers.push(result.value);
			sources.push(path);
		}
	}
	const resolved = resolveModelConfig(layers);
	return resolved.ok ? ok({ config: resolved.value, sources }) : resolved;
};
