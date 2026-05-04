import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { gateExemptVerbs } from "./verbs/registry.ts";

/**
 * Verbs that are allowed to run without a registered vault for the
 * current working directory. Derived from the verb registry's
 * `gateExempt` flag so the allow-list and the citty registration
 * cannot drift. Every other verb (and the bare-launch path) is
 * gated.
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
 * Read `~/.d3r/config.yaml` and return the absolute paths of every
 * view-consumer symlink it declares. Missing or unparseable file
 * yields the empty list (treated as "no vault registered" by
 * {@link gate}). The schema for this file is owned by the (yet to
 * land) vault-architecture work; until then, `gate` walks the
 * parsed object loosely and treats any string-valued `consumer`,
 * `path`, or `root` field as a candidate symlink.
 */
const readRegisteredRoots = (): string[] => {
	const cfgPath = resolve(homedir(), ".d3r", "config.yaml");
	let raw = "";
	try {
		raw = readFileSync(cfgPath, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown = null;
	try {
		parsed = parseYaml(raw);
	} catch {
		return [];
	}
	const out: string[] = [];
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") {
			return;
		}
		for (const [key, value] of Object.entries(
			node as Record<string, unknown>,
		)) {
			if (
				typeof value === "string" &&
				(key === "consumer" || key === "path" || key === "root")
			) {
				const real = realpathOrNull(value);
				if (real !== null) {
					out.push(real);
				}
			} else if (typeof value === "object") {
				visit(value);
			}
		}
	};
	visit(parsed);
	return out;
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
	process.stderr.write("hint: run `d3r init`\n");
	process.exit(1);
};
