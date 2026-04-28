// Pure helpers for the npm-registry update check. No top-level side
// effects; the call site reads the CLI's own version and wires the
// result into stderr after the main command's output.

export interface UpdateNotice {
	current: string;
	latest: string;
	packageName: string;
}

export interface CheckForUpdateOptions {
	signal?: AbortSignal;
	packageName?: string;
	registry?: string;
}

const DEFAULT_PACKAGE = "@d3r/cli";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 10_000;
// process.argv layout: [node, script, verb, ...rest]; the verb sits at
// index 2.
const VERB_INDEX = 2;

const hasOutputModeFlag = (argv: readonly string[]): boolean =>
	argv.some(
		(a) =>
			a === "--print" ||
			a === "--json" ||
			a.startsWith("--print=") ||
			a.startsWith("--json="),
	);

// Skip rules, in precedence order: D3R_OFFLINE, D3R_SKIP_VERSION_CHECK,
// --print/--json anywhere in argv, then the `tool` verb in the verb
// slot. The first match short-circuits to false; otherwise the check
// runs.
export const shouldCheckForUpdate = (
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
): boolean => {
	if (env.D3R_OFFLINE === "1") {
		return false;
	}
	if (env.D3R_SKIP_VERSION_CHECK === "1") {
		return false;
	}
	if (hasOutputModeFlag(argv)) {
		return false;
	}
	if (argv[VERB_INDEX] === "tool") {
		return false;
	}
	return true;
};

// Issues a single GET against the registry's `latest` dist-tag for the
// CLI's package, bound by a 10s timeout. Resolves to undefined on every
// error path -- network failures, non-2xx responses, JSON-parse errors,
// abort, missing/non-string `version` -- and never rejects.
export const checkForUpdate = async (
	currentVersion: string,
	opts: CheckForUpdateOptions = {},
): Promise<UpdateNotice | undefined> => {
	const packageName = opts.packageName ?? DEFAULT_PACKAGE;
	const registry = opts.registry ?? DEFAULT_REGISTRY;
	try {
		const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
		const signal = opts.signal
			? AbortSignal.any([opts.signal, timeoutSignal])
			: timeoutSignal;
		const url = `${registry}/${encodeURIComponent(packageName)}/latest`;
		const response = await fetch(url, { signal });
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as unknown;
		if (typeof body !== "object" || body === null) {
			return undefined;
		}
		const { version } = body as { version?: unknown };
		if (typeof version !== "string") {
			return undefined;
		}
		const latest = version.trim();
		const current = currentVersion.trim();
		if (latest === "" || latest === current) {
			return undefined;
		}
		return { current, latest, packageName };
	} catch {
		return undefined;
	}
};

// One-line stderr notice. The `write` parameter exists for tests; the
// default resolves to process.stderr at call time.
export const printUpdateNotice = (
	notice: UpdateNotice,
	write: (s: string) => void = (s) => {
		process.stderr.write(s);
	},
): void => {
	write(
		`d3r v${notice.latest} is available, run \`pnpm i -g ${notice.packageName}\` to update\n`,
	);
};
