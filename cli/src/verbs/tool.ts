// `d3r tool <name> [--flag value ...]` -- the user-facing dispatch
// into the @d3r/tools registry. We deliberately do not pre-register
// each tool as a citty sub-command (cold-start cost grows with the
// catalog and we want lazy resolution); instead the verb owns argv
// parsing, schema-driven flag derivation, and JSON output. The
// per-call shape is also exported so tests can drive it without
// going through process.exit / process.std{out,err}.

import { defineCommand, type CommandDef } from "citty";
import assert from "node:assert/strict";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
	buildRegistry,
	selectWebSearchProvider,
	type ToolEntry,
} from "@d3r/tools";
import { z } from "zod";

import { parseWebProviderConfig } from "../utils/env.ts";

import {
	walkSchema,
	type ArgSpec,
	type ArgsRecord,
	type WalkResult,
} from "../zod-args.ts";

/** Streams + exit hook the dispatcher writes through; tests inject fakes. */
export interface DispatchIO {
	readonly stdout: (chunk: string) => void;
	readonly stderr: (chunk: string) => void;
	readonly exit: (code: number) => never;
}

/** Dispatcher input: registry to look up against, the raw argv tail, the IO surface. */
export interface DispatchArgs {
	readonly registry: readonly ToolEntry[];
	readonly name: string;
	readonly tail: readonly string[];
	readonly io: DispatchIO;
}

const EXIT_FAILURE = 1;
const JSON_INDENT = 2;

const fail = (io: DispatchIO, message: string): never => {
	io.stderr(`error: ${message}\n`);
	return io.exit(EXIT_FAILURE);
};

const errMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const parseOptionsFor = (
	args: ArgsRecord,
): NonNullable<ParseArgsConfig["options"]> => {
	const out: NonNullable<ParseArgsConfig["options"]> = {};
	for (const [key, spec] of Object.entries(args)) {
		out[key] = { type: spec.type === "boolean" ? "boolean" : "string" };
	}
	return out;
};

const coerceOne = (raw: unknown, spec: ArgSpec): unknown => {
	if (spec.type === "number" && typeof raw === "string") {
		const n = Number(raw);
		if (Number.isNaN(n)) {
			throw new Error(`expected a number, got ${JSON.stringify(raw)}`);
		}
		return n;
	}
	if (spec.type === "string" && spec.multi && typeof raw === "string") {
		return raw === "" ? [] : raw.split(",");
	}
	return raw;
};

/** Coerce parseArgs's all-string output back to the types zod expects. */
const coerce = (
	values: Record<string, unknown>,
	args: ArgsRecord,
): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(values)
			.filter(([, raw]) => raw !== undefined)
			.map(([key, raw]) => [key, args[key] ? coerceOne(raw, args[key]) : raw]),
	);

const formatFlag = (key: string, spec: ArgSpec): string => {
	const required = spec.required ? "(required) " : "";
	const def =
		spec.default === undefined ? "" : ` [default: ${String(spec.default)}]`;
	const hint =
		spec.type === "string" && spec.valueHint ? ` <${spec.valueHint}>` : "";
	const desc = spec.description ? ` -- ${spec.description}` : "";
	return `  --${key}${hint}  ${required}${spec.type}${def}${desc}`;
};

/** Render a per-tool usage block to stdout. */
const printUsage = (
	io: DispatchIO,
	entry: ToolEntry,
	walked: WalkResult,
): void => {
	const head = [
		`d3r tool ${entry.name} [flags]`,
		"",
		entry.description,
		"",
		"Flags:",
	];
	const body =
		walked.kind === "union"
			? [
					`  --${walked.discriminator} <${Object.keys(walked.variants).join("|")}>  (required) variant selector`,
				]
			: Object.entries(walked.args).map(([k, s]) => formatFlag(k, s));
	io.stdout(`${[...head, ...body].join("\n")}\n`);
};

/** Strip the discriminator key the dispatcher already supplied. */
const omit = (args: ArgsRecord, key: string): ArgsRecord =>
	Object.fromEntries(Object.entries(args).filter(([k]) => k !== key));

const formatZodIssues = (error: z.ZodError): string =>
	error.issues
		.map((iss) => `invalid ${iss.path.join(".") || "<root>"}: ${iss.message}`)
		.join("; ");

/** Pull `--<key> <value>` (or `--<key>=<value>`) out of argv, returning
 *  the value and the surviving tail; undefined if the flag is absent. */
const pickFlag = (
	tail: readonly string[],
	key: string,
): { value: string; remaining: string[] } | undefined => {
	const long = `--${key}`;
	const longEq = `${long}=`;
	const remaining: string[] = [];
	let value: string | undefined = undefined;
	let skipNext = false;
	tail.forEach((arg, i) => {
		if (skipNext) {
			skipNext = false;
			return;
		}
		if (value === undefined && arg === long && i + 1 < tail.length) {
			value = tail[i + 1];
			skipNext = true;
			return;
		}
		if (value === undefined && arg.startsWith(longEq)) {
			value = arg.slice(longEq.length);
			return;
		}
		remaining.push(arg);
	});
	return value === undefined ? undefined : { value, remaining };
};

interface ResolvedVariant {
	args: ArgsRecord;
	remaining: readonly string[];
	preset: Record<string, unknown>;
}

/** Resolve a discriminated-union tool to its chosen variant + carrier preset. */
const resolveUnion = (
	io: DispatchIO,
	walked: Extract<WalkResult, { kind: "union" }>,
	tail: readonly string[],
): ResolvedVariant => {
	const choices = Object.keys(walked.variants);
	const head = pickFlag(tail, walked.discriminator);
	if (!head) {
		fail(
			io,
			`--${walked.discriminator} is required (one of: ${choices.join(", ")})`,
		);
	}
	const variant = walked.variants[head!.value];
	if (!variant) {
		fail(
			io,
			`unknown ${walked.discriminator}: ${head!.value} (expected one of: ${choices.join(", ")})`,
		);
	}
	const inner = walkSchema(variant!);
	if (inner.kind !== "object") {
		fail(io, `union variant ${head!.value} did not resolve to an object`);
	}
	return {
		args: omit(
			(inner as Extract<WalkResult, { kind: "object" }>).args,
			walked.discriminator,
		),
		remaining: head!.remaining,
		preset: { [walked.discriminator]: head!.value },
	};
};

interface ParseInput {
	io: DispatchIO;
	entry: ToolEntry;
	args: ArgsRecord;
	remaining: readonly string[];
	preset: Record<string, unknown>;
}

const parseAndValidate = ({
	io,
	entry,
	args,
	remaining,
	preset,
}: ParseInput): unknown => {
	let values: Record<string, unknown> = {};
	try {
		({ values } = parseArgs({
			args: [...remaining],
			options: parseOptionsFor(args),
			allowPositionals: false,
			strict: true,
		}) as { values: Record<string, unknown> });
	} catch (error) {
		fail(io, errMessage(error));
		return undefined;
	}
	try {
		// preset carries the discriminator (omitted from `args` upstream); the
		// disjoint-keys invariant guarantees coerced flag values cannot shadow it.
		const coerced = coerce(values, args);
		for (const key of Object.keys(coerced)) {
			assert(
				!Object.hasOwn(preset, key),
				`coerced arg '${key}' collides with preset key`,
			);
		}
		return entry.schema.parse({ ...preset, ...coerced });
	} catch (error) {
		fail(
			io,
			error instanceof z.ZodError ? formatZodIssues(error) : errMessage(error),
		);
		return undefined;
	}
};

/** The pure dispatcher kernel; no process.* dependencies inside. */
export const dispatchTool = async ({
	registry: reg,
	name,
	tail,
	io,
}: DispatchArgs): Promise<void> => {
	const entry = reg.find((e) => e.name === name);
	if (!entry) {
		return void fail(io, `unknown tool: ${name}`);
	}
	let walked: WalkResult = { kind: "object", args: {} };
	try {
		walked = walkSchema(entry.schema);
	} catch (error) {
		return void fail(io, errMessage(error));
	}
	// Walker postcondition: the cover-type branch matches its payload shape.
	assert(
		walked.kind === "union"
			? Object.keys(walked.variants).length > 0
			: walked.args !== null &&
					typeof walked.args === "object" &&
					!Array.isArray(walked.args),
		`walkSchema returned malformed ${walked.kind} result`,
	);
	if (tail.includes("--help") || tail.includes("-h")) {
		printUsage(io, entry, walked);
		return;
	}
	const resolved =
		walked.kind === "union"
			? resolveUnion(io, walked, tail)
			: { args: walked.args, remaining: tail, preset: {} };
	const params = parseAndValidate({
		io,
		entry,
		args: resolved.args,
		remaining: resolved.remaining,
		preset: resolved.preset,
	});
	let result: unknown = undefined;
	try {
		result = await (entry.fn as (p: unknown) => unknown | Promise<unknown>)(
			params,
		);
	} catch (error) {
		return void fail(io, errMessage(error));
	}
	io.stdout(`${JSON.stringify(result, null, JSON_INDENT)}\n`);
};

const command = defineCommand({
	meta: {
		name: "tool",
		description: "Dispatch into the @d3r/tools registry",
	},
	args: {
		name: {
			type: "positional",
			required: true,
			description: "Registered tool name (see @d3r/tools registry)",
		},
	},
	run: async (ctx) => {
		const tail = (ctx.rawArgs ?? []).slice(1);
		const io: DispatchIO = {
			stdout: (chunk) => {
				process.stdout.write(chunk);
			},
			stderr: (chunk) => {
				process.stderr.write(chunk);
			},
			exit: (code) => process.exit(code),
		};
		const name = String(ctx.args.name);
		// Composition root: the env is parsed once at the shell, the
		// web-search provider is constructed against the typed config,
		// and the registry is built fully wired before dispatch. The
		// missing-api-key precondition is a typed Result here, not an
		// in-band error inside `tools/`: when a `web_*` verb is invoked
		// without credentials, the shell surfaces the canonical message
		// and exits before reaching the dispatcher; otherwise the web
		// rows are simply omitted from the registry.
		const webConfig = parseWebProviderConfig(process.env);
		const webProvider = selectWebSearchProvider(webConfig);
		if (!webProvider.ok && name.startsWith("web_")) {
			return fail(
				io,
				`Missing required environment variable: ${webProvider.error.envVar}`,
			);
		}
		const registry = buildRegistry({
			web: webProvider.ok ? webProvider.value : undefined,
		});
		await dispatchTool({
			registry,
			name,
			tail,
			io,
		});
	},
});

export default command as CommandDef;
