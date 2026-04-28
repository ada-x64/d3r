// Pure zod -> node:util.parseArgs bridge for the `d3r tool` dispatcher.
//
// Walks the top-level shape of a registry tool's zod schema and emits
// `parseArgs` options + a per-field "kind" table the dispatcher uses
// to coerce parsed values (parseArgs has no native number type, so
// numeric flags are declared as strings and converted afterwards).
// Discriminated unions are exposed via `walkDiscriminated` so the
// dispatcher can peel `--<discriminator> <variant>` first and then
// re-walk the chosen arm.
//
// Nested object / non-discriminated union shapes are rejected with a
// clear message rather than silently flattened; v1 callers are flat.

import { z } from "zod";

export type FieldKind = "string" | "number" | "boolean" | "array";

export interface ParseArgsOptionConfig {
	type: "string" | "boolean";
	multiple?: boolean;
	default?: string | boolean | string[];
	short?: string;
}

export interface ParseConfig {
	options: Record<string, ParseArgsOptionConfig>;
	fieldKinds: Record<string, FieldKind>;
}

interface UnwrapResult {
	inner: z.ZodTypeAny;
	defaultValue: unknown;
	hasDefault: boolean;
}

const peelDefault = (
	schema: z.ZodTypeAny,
): { next: z.ZodTypeAny; defaultValue: unknown; hasDefault: boolean } => {
	if (schema instanceof z.ZodDefault) {
		const def = schema._def as { defaultValue: () => unknown };
		return {
			next: schema._def.innerType as z.ZodTypeAny,
			defaultValue: def.defaultValue(),
			hasDefault: true,
		};
	}
	return { next: schema, defaultValue: undefined, hasDefault: false };
};

const unwrap = (schema: z.ZodTypeAny): UnwrapResult => {
	let cur: z.ZodTypeAny = schema;
	let defaultValue: unknown = undefined;
	let hasDefault = false;
	// ZodOptional / ZodDefault / ZodNullable nest in any order; peel
	// repeatedly until we hit the underlying scalar.
	while (
		cur instanceof z.ZodOptional ||
		cur instanceof z.ZodNullable ||
		cur instanceof z.ZodDefault
	) {
		if (cur instanceof z.ZodDefault) {
			const peeled = peelDefault(cur);
			({ defaultValue } = peeled);
			hasDefault = true;
			cur = peeled.next;
		} else {
			cur = (
				cur as z.ZodOptional<z.ZodTypeAny> | z.ZodNullable<z.ZodTypeAny>
			).unwrap() as z.ZodTypeAny;
		}
	}
	return { inner: cur, defaultValue, hasDefault };
};

const isStringScalar = (schema: z.ZodTypeAny): boolean =>
	schema instanceof z.ZodString ||
	schema instanceof z.ZodEnum ||
	(schema instanceof z.ZodLiteral && typeof schema.value === "string");

const nestedRejection = (key: string): Error =>
	new Error(
		`d3r tool: nested object/union schemas are not yet supported by --flag parsing for field "${key}"; flatten the schema or use --params (not yet implemented)`,
	);

const stringifyDefault = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
};

const buildBooleanOption = (
	defaultValue: unknown,
	hasDefault: boolean,
): ParseArgsOptionConfig => {
	const opt: ParseArgsOptionConfig = { type: "boolean" };
	if (hasDefault && typeof defaultValue === "boolean") {
		opt.default = defaultValue;
	}
	return opt;
};

const buildScalarStringOption = (
	defaultValue: unknown,
	hasDefault: boolean,
): ParseArgsOptionConfig => {
	const opt: ParseArgsOptionConfig = { type: "string" };
	if (hasDefault) {
		const asStr = stringifyDefault(defaultValue);
		if (asStr !== undefined) {
			opt.default = asStr;
		}
	}
	return opt;
};

interface FieldEntry {
	kind: FieldKind;
	option: ParseArgsOptionConfig;
}

interface FieldFromInnerArgs {
	key: string;
	inner: z.ZodTypeAny;
	defaultValue: unknown;
	hasDefault: boolean;
}

const fieldFromInner = (args: FieldFromInnerArgs): FieldEntry => {
	const { key, inner, defaultValue, hasDefault } = args;
	if (inner instanceof z.ZodBoolean) {
		return {
			kind: "boolean",
			option: buildBooleanOption(defaultValue, hasDefault),
		};
	}
	if (inner instanceof z.ZodNumber) {
		return {
			kind: "number",
			option: buildScalarStringOption(defaultValue, hasDefault),
		};
	}
	if (inner instanceof z.ZodArray) {
		const { element } = inner as z.ZodArray<z.ZodTypeAny>;
		if (!isStringScalar(element) && !(element instanceof z.ZodNumber)) {
			throw nestedRejection(key);
		}
		return { kind: "array", option: { type: "string", multiple: true } };
	}
	if (isStringScalar(inner)) {
		return {
			kind: "string",
			option: buildScalarStringOption(defaultValue, hasDefault),
		};
	}
	throw nestedRejection(key);
};

export const schemaToParseArgsOptions = (
	schema: z.ZodObject<z.ZodRawShape>,
): ParseConfig => {
	const options: Record<string, ParseArgsOptionConfig> = {};
	const fieldKinds: Record<string, FieldKind> = {};
	const entries = Object.entries(schema.shape) as [string, z.ZodTypeAny][];
	for (const [key, child] of entries) {
		const { inner, defaultValue, hasDefault } = unwrap(child);
		const entry = fieldFromInner({ key, inner, defaultValue, hasDefault });
		fieldKinds[key] = entry.kind;
		options[key] = entry.option;
	}
	return { options, fieldKinds };
};

export interface DiscriminatedWalk {
	discriminator: string;
	arms: Map<string, z.ZodObject<z.ZodRawShape>>;
}

export const walkDiscriminated = (
	schema: z.ZodDiscriminatedUnion<string, z.ZodObject<z.ZodRawShape>[]>,
): DiscriminatedWalk => {
	const arms = new Map<string, z.ZodObject<z.ZodRawShape>>();
	const { discriminator } = schema;
	for (const arm of schema.options as z.ZodObject<z.ZodRawShape>[]) {
		const tag = (arm.shape as Record<string, z.ZodTypeAny>)[discriminator];
		if (!(tag instanceof z.ZodLiteral)) {
			throw new Error(
				`d3r tool: discriminator "${discriminator}" arm is not a literal`,
			);
		}
		const { value } = tag;
		if (typeof value !== "string") {
			throw new Error(
				`d3r tool: discriminator "${discriminator}" must be a string literal; got ${typeof value}`,
			);
		}
		arms.set(value, arm);
	}
	return { discriminator, arms };
};

const coerceOne = (
	key: string,
	kind: FieldKind | undefined,
	raw: string | string[] | boolean,
): unknown => {
	if (kind !== "number") {
		return raw;
	}
	if (typeof raw !== "string") {
		throw new Error(
			`d3r tool: --${key} must be a number, got ${JSON.stringify(raw)}`,
		);
	}
	const n = Number(raw);
	if (Number.isNaN(n)) {
		throw new Error(`d3r tool: --${key} must be a number, got "${raw}"`);
	}
	return n;
};

export const coerceParsedValues = (
	values: Record<string, string | string[] | boolean | undefined>,
	fieldKinds: Record<string, FieldKind>,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(values)) {
		if (raw !== undefined) {
			out[key] = coerceOne(key, fieldKinds[key], raw);
		}
	}
	return out;
};
