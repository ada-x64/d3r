// vault_lint: walk the resolved vault and validate each markdown file's
// frontmatter against the per-kind zod schema in ./lint/index.ts.
// Files without a `kind:` field are reported as `no-kind`; files whose
// `kind:` is not in the registered map are reported as `unknown-kind`.
// Genuine zod failures are reported as `schema-fail` with the issue
// list attached. Returns structured findings; never throws on bad
// frontmatter.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Result } from "../common/result.ts";
import type { VaultAccessor, VaultPathError } from "../common/vault-root.ts";
import { parseFm } from "../fm/_lib.ts";
import { acceptRoot, resolveRoot, walkVault } from "./_lib.ts";
import { lintSchemas } from "./lint/index.ts";

export const VaultLintParams = z.object({
	paths: z.array(z.string()).optional(),
});
export type VaultLintParams = z.infer<typeof VaultLintParams>;

export type VaultLintReason = "no-kind" | "unknown-kind" | "schema-fail";

export interface VaultLintFinding {
	path: string;
	kind?: string;
	ok: boolean;
	reason?: VaultLintReason;
	errors?: z.ZodIssue[];
}

export interface VaultLintSummary {
	total: number;
	ok: number;
	failed: number;
}

export interface VaultLintResult {
	findings: VaultLintFinding[];
	summary: VaultLintSummary;
}

const lintOne = async (abs: string, rel: string): Promise<VaultLintFinding> => {
	const raw = await readFile(abs, "utf8");
	const { data } = parseFm(raw);
	const kindValue = typeof data.kind === "string" ? data.kind : undefined;
	if (kindValue === undefined) {
		return { path: rel, ok: false, reason: "no-kind" };
	}
	const schema = lintSchemas[kindValue];
	if (!schema) {
		return { path: rel, kind: kindValue, ok: false, reason: "unknown-kind" };
	}
	const result = schema.safeParse(data);
	if (!result.success) {
		return {
			path: rel,
			kind: kindValue,
			ok: false,
			reason: "schema-fail",
			errors: result.error.issues,
		};
	}
	return { path: rel, kind: kindValue, ok: true };
};

export const vaultLint = async (
	params: VaultLintParams,
	accessor: VaultAccessor,
): Promise<Result<VaultLintResult, VaultPathError>> => {
	const root = await resolveRoot(accessor);
	const targets: { abs: string; rel: string }[] = [];
	if (params.paths === undefined) {
		const walked = await walkVault(root);
		for (const rel of walked) {
			if (rel.endsWith(".md")) {
				targets.push({ abs: path.join(root, rel), rel });
			}
		}
	} else {
		const resolutions = await Promise.all(
			params.paths.map((rel) => acceptRoot(accessor, rel)),
		);
		for (let i = 0; i < resolutions.length; i++) {
			const resolved = resolutions[i];
			if (!resolved.ok) {
				return resolved;
			}
			targets.push({ abs: resolved.value, rel: params.paths[i] });
		}
	}
	const findings = await Promise.all(
		targets.map(({ abs, rel }) => lintOne(abs, rel)),
	);
	const okCount = findings.filter((f) => f.ok).length;
	return {
		ok: true,
		value: {
			findings,
			summary: {
				total: findings.length,
				ok: okCount,
				failed: findings.length - okCount,
			},
		},
	};
};
