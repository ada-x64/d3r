import assert from "node:assert/strict";
import { type z } from "zod";
import { FmReadParams, fmRead } from "./fm/read.ts";
import { FmWriteParams, fmWrite } from "./fm/write.ts";
import { VaultEditParams, vaultEdit } from "./vault/edit.ts";
import { VaultFindParams, vaultFind } from "./vault/find.ts";
import { VaultInitParams, vaultInit } from "./vault/init.ts";
import { VaultLintParams, vaultLint } from "./vault/lint.ts";
import { VaultLsParams, vaultLs } from "./vault/ls.ts";
import { VaultMvParams, vaultMv } from "./vault/mv.ts";
import { VaultReadParams, vaultRead } from "./vault/read.ts";
import { VaultRmParams, vaultRm } from "./vault/rm.ts";
import { VaultWriteParams, vaultWrite } from "./vault/write.ts";
import {
	WebFetchParams,
	WebSearchParams,
	type WebSearchProvider,
} from "./web/search.ts";

export interface ToolEntry {
	name: string;
	label: string;
	description: string;
	schema: z.ZodTypeAny;
	fn: (...args: never[]) => unknown;
}

// Composition-root inputs threaded by the shell. The shell parses
// env once at the boundary, constructs each provider, and hands the
// table back fully wired; tools never reach into env or singletons.
// `web` is undefined when the missing-api-key precondition fires:
// the shell short-circuits `web_*` dispatch with a typed message
// before reaching the registry, so the rows are simply omitted here
// rather than carrying an in-band error.
export interface RegistryDeps {
	web: WebSearchProvider | undefined;
}

export const buildRegistry = (deps: RegistryDeps): ToolEntry[] => {
	const webSearchFn = async (params: WebSearchParams, signal?: AbortSignal) => {
		assert(deps.web, "web_search dispatched without a configured provider");
		return deps.web.search(params, signal);
	};

	const webFetchFn = async (params: WebFetchParams, signal?: AbortSignal) => {
		assert(deps.web, "web_fetch dispatched without a configured provider");
		return deps.web.fetch(params, signal);
	};

	const entries: ToolEntry[] = [
		{
			name: "fm_read",
			label: "Frontmatter read",
			description:
				"Parse a markdown string into its YAML frontmatter object and body text.",
			schema: FmReadParams,
			fn: fmRead as (...args: never[]) => unknown,
		},
		{
			name: "fm_write",
			label: "Frontmatter write",
			description:
				"Serialise a frontmatter object plus body back to a single markdown string.",
			schema: FmWriteParams,
			fn: fmWrite as (...args: never[]) => unknown,
		},
		{
			name: "vault_init",
			label: "Vault init",
			description:
				"Initialise an empty directory as a fresh D3R vault: copies the canonical seed and creates a single chore commit.",
			schema: VaultInitParams,
			fn: vaultInit as (...args: never[]) => unknown,
		},
		{
			name: "vault_read",
			label: "Vault read",
			description:
				"Read a vault file as text, or list immediate children when the path is a directory.",
			schema: VaultReadParams,
			fn: vaultRead as (...args: never[]) => unknown,
		},
		{
			name: "vault_ls",
			label: "Vault list",
			description: "List immediate children of a vault-relative directory.",
			schema: VaultLsParams,
			fn: vaultLs as (...args: never[]) => unknown,
		},
		{
			name: "vault_find",
			label: "Vault find",
			description:
				"Find vault files by glob, body substring, or frontmatter kind. All filters optional.",
			schema: VaultFindParams,
			fn: vaultFind as (...args: never[]) => unknown,
		},
		{
			name: "vault_mv",
			label: "Vault move",
			description:
				"Rename or move a file within the vault; refuses to clobber unless overwrite is set.",
			schema: VaultMvParams,
			fn: vaultMv as (...args: never[]) => unknown,
		},
		{
			name: "vault_rm",
			label: "Vault remove",
			description: "Remove a vault file; directories require recursive: true.",
			schema: VaultRmParams,
			fn: vaultRm as (...args: never[]) => unknown,
		},
		{
			name: "vault_edit",
			label: "Vault edit",
			description:
				"Literal find/replace inside a vault file; refuses unless find occurs exactly count times.",
			schema: VaultEditParams,
			fn: vaultEdit as (...args: never[]) => unknown,
		},
		{
			name: "vault_write",
			label: "Vault write",
			description:
				"Write a vault file. mode: doc assembles frontmatter+body; mode: raw writes bytes verbatim.",
			schema: VaultWriteParams,
			fn: vaultWrite as (...args: never[]) => unknown,
		},
		{
			name: "vault_lint",
			label: "Vault lint",
			description:
				"Validate vault markdown frontmatter against per-kind zod schemas; reports findings.",
			schema: VaultLintParams,
			fn: vaultLint as (...args: never[]) => unknown,
		},
	];
	if (deps.web !== undefined) {
		entries.push(
			{
				name: "web_search",
				label: "Web search",
				description:
					"Search the web for relevant pages and return titled hits with highlight snippets.",
				schema: WebSearchParams,
				fn: webSearchFn as (...args: never[]) => unknown,
			},
			{
				name: "web_fetch",
				label: "Web fetch",
				description:
					"Retrieve the full extracted text of one or more web pages by URL.",
				schema: WebFetchParams,
				fn: webFetchFn as (...args: never[]) => unknown,
			},
		);
	}
	return entries;
};
