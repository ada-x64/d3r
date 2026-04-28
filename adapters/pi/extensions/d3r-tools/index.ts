// d3r-tools pi extension.
//
// Walks `@d3r/tools`'s registry and registers each entry with pi via
// `registerTool`, threading the cross-cutting concerns the registry
// itself stays innocent of: zod -> TypeBox parameter conversion,
// per-tool-name `StringEnum` hints, leading-`@` path normalisation
// (some models include the prefix in path arguments), `ctx.cwd`-based
// vault-root resolution, abort-signal forwarding, mutation-queue
// serialisation for file-mutating tools, and translation of typed
// returns into pi's `{ content, details }` shape.
//
// Errors are not caught here. pi's tool runtime catches and tags the
// turn with `isError: true`; wrapping in a try/catch would only hide
// the stack from the harness.

// oxlint-disable new-cap -- TypeBox factories use PascalCase by design.

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// oxlint-disable-next-line no-duplicate-imports
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { ToolCtx, ToolEntry, VaultAccessor } from "@d3r/tools";
// oxlint-disable-next-line no-duplicate-imports
import { registry } from "@d3r/tools";
import { defaultRenderCall, defaultRenderResult } from "./renderers.ts";
import { STRING_ENUM_HINTS } from "./string-enum-hints.ts";
import { zodToTypebox } from "./zod-to-typebox.ts";

const JSON_INDENT = 2;

// Vault root convention: `<cwd>/.agents/vault`. The vault is a
// per-repo fixed location and the harness has no other handle on it
// today. If a future surface hands us an explicit override, swap
// this resolver for one that reads it.
const VAULT_SUBDIR = path.join(".agents", "vault");

const buildAccessor = (cwd: string): VaultAccessor => ({
	vaultRoot: path.resolve(cwd, VAULT_SUBDIR),
});

// Field names whose string values are interpreted as paths and
// therefore subject to leading-`@` stripping. Kept narrow rather than
// stripping every string field, to avoid mangling user content like
// query strings or commit messages that happen to start with `@`.
const PATH_FIELDS: ReadonlySet<string> = new Set(["path", "from", "to"]);

const stripAtPrefix = (value: string): string =>
	value.startsWith("@") ? value.slice(1) : value;

const normaliseArgs = (raw: unknown): Record<string, unknown> => {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	const source = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		out[key] =
			typeof value === "string" && PATH_FIELDS.has(key)
				? stripAtPrefix(value)
				: value;
	}
	return out;
};

// Mutation-queue keying. Each mutating tool has a single canonical
// path field; `vault_mv` keys on `from` because that's the side that
// disappears (the queue is per-source-path). If a tool ever needs to
// mutate two paths atomically, this is where the policy will grow.
const MUTATION_KEY_FIELD: Record<string, string> = {
	vault_write: "path",
	vault_edit: "path",
	vault_rm: "path",
	vault_mv: "from",
};

const mutationKey = (
	entry: ToolEntry,
	params: Record<string, unknown>,
	accessor: VaultAccessor,
): string | undefined => {
	const field = MUTATION_KEY_FIELD[entry.name];
	if (field === undefined) {
		return undefined;
	}
	const raw = params[field];
	if (typeof raw !== "string") {
		return undefined;
	}
	const root = "vaultRoot" in accessor ? accessor.vaultRoot : "";
	return path.resolve(root, raw);
};

const renderText = (result: unknown): string => {
	if (result === null || typeof result !== "object") {
		return JSON.stringify(result);
	}
	const obj = result as Record<string, unknown>;
	if (typeof obj.ok === "boolean") {
		const payload = obj.ok ? obj.value : obj.error;
		return JSON.stringify(payload, null, JSON_INDENT);
	}
	return JSON.stringify(result, null, JSON_INDENT);
};

interface ExecuteArgs {
	entry: ToolEntry;
	params: Record<string, unknown>;
	signal: AbortSignal | undefined;
	cwd: string;
}

const runEntry = async ({
	entry,
	params,
	signal,
	cwd,
}: ExecuteArgs): Promise<unknown> => {
	const accessor = buildAccessor(cwd);
	const ctx: ToolCtx = { accessor, signal };
	const call = async (): Promise<unknown> => entry.invoke(params as never, ctx);
	if (entry.mutating === true) {
		const key = mutationKey(entry, params, accessor);
		if (key !== undefined) {
			return withFileMutationQueue(key, call);
		}
	}
	return call();
};

// pi's execute ABI is positional with five params; the wrapper
// adapts the registry's uniform shape to that callback signature.
// oxlint-disable max-params
const makeExecute =
	(entry: ToolEntry) =>
	async (
		_id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctxApi: { cwd: string },
	): Promise<{
		content: { type: string; text: string }[];
		details: unknown;
	}> => {
		const result = await runEntry({
			entry,
			params: normaliseArgs(params),
			signal,
			cwd: ctxApi.cwd,
		});
		return {
			content: [{ type: "text", text: renderText(result) }],
			details: result,
		};
	};
// oxlint-enable max-params

const registerOne = (pi: ExtensionAPI, entry: ToolEntry): void => {
	const parameters = zodToTypebox(
		entry.schema,
		STRING_ENUM_HINTS[entry.name] ?? {},
	);
	pi.registerTool({
		name: entry.name,
		label: entry.label,
		description: entry.description,
		parameters,
		prepareArguments: (raw) => normaliseArgs(raw) as never,
		execute: makeExecute(entry) as never,
		renderCall: defaultRenderCall(entry.name) as never,
		renderResult: defaultRenderResult(entry.name) as never,
	});
};

const factory = (pi: ExtensionAPI): void => {
	for (const entry of registry) {
		registerOne(pi, entry);
	}
};

export default factory;
