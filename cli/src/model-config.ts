import { dirname, isAbsolute, join } from "node:path";
import {
	ModelConfig,
	resolveModelConfig,
	type ModelConfigError,
	type ResolvedModelConfig,
} from "@d3r/core/model-config";
import { fail, ok, type Result } from "@d3r/core/result";
import { isEnoent } from "./utils/helpers.ts";
import { readDiskText, workspacePath } from "./resource-paths.ts";

/** File reads are bounded even when setup has no explicit caller deadline. */
const READ_TIMEOUT_MS = 10_000;

/** Session creation can cancel discovery before a provider request is made. */
export interface ModelConfigLoadOptions {
	readonly signal?: AbortSignal;
}

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
	signal: AbortSignal,
): Promise<Result<ModelConfig | null, ModelConfigLoadError>> => {
	let raw = "";
	try {
		const root = dirname(dirname(path));
		const canonical = await workspacePath(path, {
			cwd: root,
			roots: [root],
			signal,
		});
		raw = await readDiskText(canonical, signal);
	} catch (error) {
		signal.throwIfAborted();
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
	options: ModelConfigLoadOptions = {},
): Promise<Result<LoadedModelConfig, ModelConfigLoadError>> => {
	const signal = AbortSignal.any([
		AbortSignal.timeout(READ_TIMEOUT_MS),
		...(options.signal ? [options.signal] : []),
	]);
	signal.throwIfAborted();
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
	const completed = await Promise.allSettled(
		paths.map(async (path) => ({
			path,
			result: await readLayer(path, signal),
		})),
	);
	signal.throwIfAborted();
	const reads = completed.map((result) => {
		if (result.status === "rejected") {
			throw result.reason;
		}
		return result.value;
	});
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
