// `d3r tool <name>` dispatcher. Looks the named entry up in the
// @d3r/tools registry, derives `--key value` parsing from its zod
// schema (top-level shape only; discriminated unions peel
// `--<discriminator> <variant>` first), validates via zod so defaults
// apply and required-field errors surface, builds a ToolCtx, invokes
// the entry, and JSON-prints the typed return on stdout. Throws are
// caught at the top of `run` and become exit-code 1 with the message
// on stderr; typed `{ ok: false, error }` Result returns set exit
// code 1 but keep the JSON diagnostic on stdout.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { defineCommand } from "citty";
import { z } from "zod";

import { registry } from "@d3r/tools";

import {
	coerceParsedValues,
	schemaToParseArgsOptions,
	walkDiscriminated,
} from "./zod-args.js";
import { vaultGate } from "./vault-gate.js";

const JSON_INDENT = 2;
const EXIT_FAILURE = 1;

// Precedence: explicit env > discovered .agents/vault under cwd > cwd.
// The traversal guard inside the vault tools refuses out-of-root
// requests, so passing cwd as a last resort is the v1 fail-safe.
const buildAccessor = (): { vaultRoot: string } => {
	const envRoot = process.env.D3R_VAULT_ROOT;
	if (envRoot !== undefined && envRoot.length > 0) {
		return { vaultRoot: path.resolve(envRoot) };
	}
	const candidate = path.join(process.cwd(), ".agents", "vault");
	if (existsSync(candidate)) {
		return { vaultRoot: realpathSync(candidate) };
	}
	return { vaultRoot: process.cwd() };
};

const buildSignal = (): AbortSignal => {
	const ctrl = new AbortController();
	process.once("SIGINT", () => ctrl.abort());
	return ctrl.signal;
};

const isFailedResult = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"ok" in value &&
	(value as { ok: unknown }).ok === false;

const runWithParseArgsWrap = <T>(fn: () => T): T => {
	try {
		return fn();
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`d3r tool: ${msg}`, { cause: error });
	}
};

const parseFlatSchema = (
	schema: z.ZodObject<z.ZodRawShape>,
	rawArgs: string[],
): Record<string, unknown> => {
	const { options, fieldKinds } = schemaToParseArgsOptions(schema);
	const parsed = runWithParseArgsWrap(() =>
		parseArgs({
			args: rawArgs,
			options,
			strict: true,
			allowPositionals: false,
		}),
	);
	return coerceParsedValues(
		parsed.values as Record<string, string | string[] | boolean | undefined>,
		fieldKinds,
	);
};

interface PeeledFlag {
	value: string;
	remaining: string[];
}

// Pull `--<flag> <value>` or `--<flag>=value` out of `rawArgs` without
// running the rest through parseArgs (which would reject the unchosen
// arm's flags). Returns the captured value and the remainder.
const peelFlag = (rawArgs: string[], flag: string): PeeledFlag | null => {
	const long = `--${flag}`;
	const eqPrefix = `${long}=`;
	for (let i = 0; i < rawArgs.length; i++) {
		const tok = rawArgs[i];
		if (tok === long) {
			const value = rawArgs[i + 1];
			if (value === undefined) {
				return null;
			}
			const remaining = [...rawArgs.slice(0, i), ...rawArgs.slice(i + 1 + 1)];
			return { value, remaining };
		}
		if (tok !== undefined && tok.startsWith(eqPrefix)) {
			const value = tok.slice(eqPrefix.length);
			const remaining = [...rawArgs.slice(0, i), ...rawArgs.slice(i + 1)];
			return { value, remaining };
		}
	}
	return null;
};

const parseDiscriminated = (
	schema: z.ZodDiscriminatedUnion<string, z.ZodObject<z.ZodRawShape>[]>,
	rawArgs: string[],
): Record<string, unknown> => {
	const { discriminator, arms } = walkDiscriminated(schema);
	const variants = [...arms.keys()].join(", ");
	const peeled = peelFlag(rawArgs, discriminator);
	if (peeled === null) {
		throw new Error(
			`d3r tool: --${discriminator} is required (one of: ${variants})`,
		);
	}
	const arm = arms.get(peeled.value);
	if (arm === undefined) {
		throw new Error(
			`d3r tool: --${discriminator} must be one of: ${variants}; got "${peeled.value}"`,
		);
	}
	const inner = parseFlatSchema(arm, peeled.remaining);
	return { [discriminator]: peeled.value, ...inner };
};

const listRegistry = (): string =>
	`${registry.map((e) => `${e.name}\t${e.description}`).join("\n")}\n`;

const formatZodError = (toolName: string, zerr: z.ZodError): Error => {
	const issues = zerr.issues
		.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
		.join("; ");
	return new Error(`d3r tool ${toolName}: ${issues}`, { cause: zerr });
};

const parseForSchema = (
	entry: { name: string; schema: z.ZodTypeAny },
	flagArgs: string[],
): Record<string, unknown> => {
	if (entry.schema instanceof z.ZodDiscriminatedUnion) {
		return parseDiscriminated(
			entry.schema as z.ZodDiscriminatedUnion<
				string,
				z.ZodObject<z.ZodRawShape>[]
			>,
			flagArgs,
		);
	}
	if (entry.schema instanceof z.ZodObject) {
		return parseFlatSchema(
			entry.schema as z.ZodObject<z.ZodRawShape>,
			flagArgs,
		);
	}
	throw new Error(`d3r tool: unsupported top-level schema for "${entry.name}"`);
};

const validateParams = (
	entry: { name: string; schema: z.ZodTypeAny },
	unparsed: Record<string, unknown>,
): unknown => {
	try {
		return entry.schema.parse(unparsed);
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw formatZodError(entry.name, error);
		}
		throw error;
	}
};

interface RegistryEntryLike {
	name: string;
	description: string;
	schema: z.ZodTypeAny;
	invoke: (
		params: never,
		ctx: { accessor: { vaultRoot: string }; signal: AbortSignal },
	) => Promise<unknown>;
}

const dispatchEntry = async (
	entry: RegistryEntryLike,
	flagArgs: string[],
): Promise<void> => {
	const unparsed = parseForSchema(entry, flagArgs);
	const params = validateParams(entry, unparsed);
	const toolCtx = {
		accessor: buildAccessor(),
		signal: buildSignal(),
	};
	const result = await entry.invoke(params as never, toolCtx);
	process.stdout.write(`${JSON.stringify(result, null, JSON_INDENT)}\n`);
	if (isFailedResult(result)) {
		process.exitCode = EXIT_FAILURE;
	}
};

const stripLeadingPositional = (
	rawArgs: readonly string[],
	name: string,
): string[] => {
	const args = [...rawArgs];
	if (args[0] === name) {
		return args.slice(1);
	}
	return args;
};

export default defineCommand({
	meta: {
		name: "tool",
		description: "Dispatch a @d3r/tools registry entry.",
	},
	setup: async () => {
		await vaultGate(process.cwd());
	},
	args: {
		name: {
			type: "positional",
			required: false,
			description: "Registry tool name (omit to list available tools)",
		},
	},
	run: async (ctx) => {
		try {
			const requested = ctx.args.name;
			if (requested === undefined || requested === null || requested === "") {
				process.stdout.write(listRegistry());
				return;
			}
			const entry = registry.find((e) => e.name === requested);
			if (entry === undefined) {
				const available = registry.map((e) => e.name).join(", ");
				throw new Error(
					`d3r tool: unknown tool "${requested}"; available: ${available}`,
				);
			}
			const flagArgs = stripLeadingPositional(ctx.rawArgs, entry.name);
			await dispatchEntry(entry, flagArgs);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${msg}\n`);
			process.exitCode = EXIT_FAILURE;
		}
	},
});
