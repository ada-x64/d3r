import type { z } from "zod";
import type { VaultAccessor } from "./common/vault-root.ts";
import { FmReadParams, fmRead } from "./fm/read.ts";
import { FmWriteParams, fmWrite } from "./fm/write.ts";
import { VaultEditParams, vaultEdit } from "./vault/edit.ts";
import { VaultFindParams, vaultFind } from "./vault/find.ts";
import { VaultLintParams, vaultLint } from "./vault/lint.ts";
import { VaultLsParams, vaultLs } from "./vault/ls.ts";
import { VaultMvParams, vaultMv } from "./vault/mv.ts";
import { VaultReadParams, vaultRead } from "./vault/read.ts";
import { VaultRmParams, vaultRm } from "./vault/rm.ts";
import { VaultWriteParams, vaultWrite } from "./vault/write.ts";
import {
	CommentIssueParams,
	CreateIssueParams,
	commentIssueTool,
	createIssueTool,
} from "./ticketing/index.ts";
import { defaultProvider as defaultGithubProvider } from "./ticketing/providers/github.ts";
import { VectorReadParams, vectorRead } from "./vector/read.ts";
import { createExaProvider } from "./web/providers/exa.ts";
import { WebSearchParams, webSearch } from "./web/search.ts";

const DEFAULT_WEB_SEARCH_PROVIDER = "exa";

const webSearchFn = async (params: WebSearchParams, signal?: AbortSignal) => {
	const selector =
		process.env.D3R_WEB_SEARCH_PROVIDER ?? DEFAULT_WEB_SEARCH_PROVIDER;
	if (selector !== "exa") {
		throw new Error(
			`Unknown D3R_WEB_SEARCH_PROVIDER value: ${selector} (supported: exa)`,
		);
	}
	const provider = createExaProvider();
	return webSearch(params, provider, signal);
};

const createIssueFn = async (params: CreateIssueParams) =>
	createIssueTool(params, defaultGithubProvider());

const commentIssueFn = async (params: CommentIssueParams) =>
	commentIssueTool(params, defaultGithubProvider());

// Harness-supplied per-call context. Tools that ignore one or both
// fields just don't read them; the factory always supplies both.
export interface ToolCtx {
	accessor: VaultAccessor;
	signal?: AbortSignal;
}

export interface ToolEntry {
	name: string;
	label: string;
	description: string;
	schema: z.ZodTypeAny;
	// True if a successful invocation mutates the filesystem under the
	// vault root. The harness uses this to serialise per-path writes
	// behind a mutation queue.
	mutating?: boolean;
	// Uniform invocation shape. Each entry adapts its tool's native
	// signature (which may take a VaultAccessor, an AbortSignal, both,
	// or neither) to this single contract so the harness can drive
	// every entry the same way.
	invoke: (params: never, ctx: ToolCtx) => Promise<unknown>;
}

export const registry: ToolEntry[] = [
	{
		name: "fm_read",
		label: "Frontmatter read",
		description:
			"Parse a markdown string into its YAML frontmatter object and body text.",
		schema: FmReadParams,
		invoke: async (params: never) => fmRead(params),
	},
	{
		name: "fm_write",
		label: "Frontmatter write",
		description:
			"Serialise a frontmatter object plus body back to a single markdown string.",
		schema: FmWriteParams,
		invoke: async (params: never) => fmWrite(params),
	},
	{
		name: "vault_read",
		label: "Vault read",
		description:
			"Read a vault file as text, or list immediate children when the path is a directory.",
		schema: VaultReadParams,
		invoke: async (params: never, ctx) => vaultRead(params, ctx.accessor),
	},
	{
		name: "vault_ls",
		label: "Vault list",
		description: "List immediate children of a vault-relative directory.",
		schema: VaultLsParams,
		invoke: async (params: never, ctx) => vaultLs(params, ctx.accessor),
	},
	{
		name: "vault_find",
		label: "Vault find",
		description:
			"Find vault files by glob, body substring, or frontmatter kind. All filters optional.",
		schema: VaultFindParams,
		invoke: async (params: never, ctx) => vaultFind(params, ctx.accessor),
	},
	{
		name: "vault_mv",
		label: "Vault move",
		description:
			"Rename or move a file within the vault; refuses to clobber unless overwrite is set.",
		schema: VaultMvParams,
		mutating: true,
		invoke: async (params: never, ctx) => vaultMv(params, ctx.accessor),
	},
	{
		name: "vault_rm",
		label: "Vault remove",
		description: "Remove a vault file; directories require recursive: true.",
		schema: VaultRmParams,
		mutating: true,
		invoke: async (params: never, ctx) => vaultRm(params, ctx.accessor),
	},
	{
		name: "vault_edit",
		label: "Vault edit",
		description:
			"Literal find/replace inside a vault file; refuses unless find occurs exactly count times.",
		schema: VaultEditParams,
		mutating: true,
		invoke: async (params: never, ctx) => vaultEdit(params, ctx.accessor),
	},
	{
		name: "vault_write",
		label: "Vault write",
		description:
			"Write a vault file. mode: doc assembles frontmatter+body; mode: raw writes bytes verbatim.",
		schema: VaultWriteParams,
		mutating: true,
		invoke: async (params: never, ctx) => vaultWrite(params, ctx.accessor),
	},
	{
		name: "vault_lint",
		label: "Vault lint",
		description:
			"Validate vault markdown frontmatter against per-kind zod schemas; reports findings.",
		schema: VaultLintParams,
		invoke: async (params: never, ctx) => vaultLint(params, ctx.accessor),
	},
	{
		name: "vector_read",
		label: "Vector read",
		description:
			'Semantic search over the vault\'s vector index. Currently a stub; returns kind: "stub" until the recollection-store design lands.',
		schema: VectorReadParams,
		invoke: async (params: never) => vectorRead(params),
	},
	{
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for relevant pages and return titled hits with short snippets.",
		schema: WebSearchParams,
		invoke: async (params: never, ctx) => webSearchFn(params, ctx.signal),
	},
	{
		name: "create_issue",
		label: "Create GitHub issue",
		description:
			'Open a new GitHub issue on repo "owner/name" with title and body. Requires GITHUB_TOKEN with repo scope.',
		schema: CreateIssueParams,
		invoke: async (params: never) => createIssueFn(params),
	},
	{
		name: "comment_issue",
		label: "Comment on GitHub issue",
		description:
			'Post a comment on an existing GitHub issue identified by repo "owner/name" and issue_number. Requires GITHUB_TOKEN with repo scope.',
		schema: CommentIssueParams,
		invoke: async (params: never) => commentIssueFn(params),
	},
];
