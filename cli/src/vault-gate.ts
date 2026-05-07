import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { gateExemptVerbs } from "./verbs/registry.ts";

/**
 * Verbs that are allowed to run without a registered vault for the
 * current working directory. Derived from the `GATE_EXEMPT_VERBS`
 * table in the verb registry -- membership in that table is the
 * encoding of gate-exempt status -- so the allow-list and the citty
 * registration cannot drift. Every other verb (and the bare-launch
 * path) is gated.
 */
export const ALLOW_LIST: ReadonlySet<string> = gateExemptVerbs();

const withTrailingSep = (p: string): string => (p.endsWith(sep) ? p : p + sep);

const isAncestor = (ancestor: string, child: string): boolean => {
	const a = withTrailingSep(ancestor);
	const c = withTrailingSep(child);
	return c === a || c.startsWith(a);
};

const realpathOrNull = (p: string): string | null => {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
};

/**
 * Shape admitted from `~/.d3r/config.yaml`. Each of `consumer`,
 * `path`, and `root` may appear at the top level or on an entry of a
 * top-level `vaults` array, and is treated as a candidate registered
 * vault root. `.passthrough()` keeps unknown sibling fields from
 * refusing the file -- the long-term schema for this config lives
 * with the vault-architecture work; the gate's contract here is only
 * "what shapes contribute a candidate root".
 */
const VaultEntry = z
	.object({
		consumer: z.string().optional(),
		path: z.string().optional(),
		root: z.string().optional(),
	})
	.passthrough();

const ConfigYaml = z
	.object({
		consumer: z.string().optional(),
		path: z.string().optional(),
		root: z.string().optional(),
		vaults: z.array(VaultEntry).optional().catch(undefined),
	})
	.passthrough();

const candidateRoots = (cfg: z.infer<typeof ConfigYaml>): string[] => {
	const top = [cfg.consumer, cfg.path, cfg.root];
	const nested = (cfg.vaults ?? []).flatMap((v) => [
		v.consumer,
		v.path,
		v.root,
	]);
	return [...top, ...nested].filter((s): s is string => typeof s === "string");
};

/**
 * Read `~/.d3r/config.yaml` and return the absolute paths of every
 * view-consumer symlink it declares. Missing or unparseable file --
 * or one that does not match {@link ConfigYaml} -- yields the empty
 * list (treated as "no vault registered" by {@link gate}). The
 * schema is the contract: any field outside it does not contribute a
 * candidate root.
 */
const readRegisteredRoots = (): string[] => {
	const cfgPath = resolve(homedir(), ".d3r", "config.yaml");
	let raw = "";
	try {
		raw = readFileSync(cfgPath, "utf8");
	} catch {
		return [];
	}
	let parsedYaml: unknown = null;
	try {
		parsedYaml = parseYaml(raw);
	} catch {
		return [];
	}
	const result = ConfigYaml.safeParse(parsedYaml);
	if (!result.success) {
		return [];
	}
	return candidateRoots(result.data)
		.map(realpathOrNull)
		.filter((p): p is string => p !== null);
};

/**
 * Refuse-to-run gate. Resolves cleanly when `verbName` is
 * allow-listed or when some registered vault root is an ancestor of
 * `cwd`; otherwise writes the prescribed error/hint pair to stderr
 * and exits with code 1.
 */
export const gate = async (
	verbName: string | undefined,
	cwd: string,
): Promise<void> => {
	if (verbName !== undefined && ALLOW_LIST.has(verbName)) {
		return;
	}
	const cwdReal = realpathOrNull(cwd) ?? cwd;
	const roots = readRegisteredRoots();
	for (const root of roots) {
		if (isAncestor(root, cwdReal)) {
			return;
		}
	}
	process.stderr.write(`error: no d3r vault registered for ${cwd}\n`);
	process.stderr.write("hint: run `d3r vault init`\n");
	process.exit(1);
};
