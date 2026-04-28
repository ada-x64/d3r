// Pure zod -> TypeBox bridge.
//
// The tools package colocates a zod schema with every tool function;
// pi's tool ABI wants a TypeBox `parameters` object instead. This
// module converts one to the other without any I/O. Native zod enums
// always emit `StringEnum(...)` from `@mariozechner/pi-ai` (Google
// models reject `anyOf`/`const`); plain `z.string()` fields can also
// be constrained via the per-field `hints` table.
//
// Coverage matches the shapes used by the registry as of authoring:
// object, string, number, boolean, array, record, optional, default,
// nullable, enum, literal, union, discriminated-union, any/unknown.
// Unhandled shapes throw rather than silently producing `Type.Any()`
// so a missing case is caught at extension load.

// oxlint-disable new-cap -- TypeBox factories use PascalCase by design.

import { StringEnum } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";
// oxlint-disable-next-line no-duplicate-imports
import { Type } from "@sinclair/typebox";
import { z } from "zod";

type Hints = Record<string, readonly string[]>;

interface ZodMeta {
	description?: string;
}

const collectMeta = (schema: z.ZodTypeAny): ZodMeta => {
	const meta: ZodMeta = {};
	if (typeof schema.description === "string") {
		meta.description = schema.description;
	}
	return meta;
};

const withMeta = (node: TSchema, meta: ZodMeta): TSchema => {
	if (meta.description !== undefined && node.description === undefined) {
		node.description = meta.description;
	}
	return node;
};

const stringEnumNode = (values: readonly string[], meta: ZodMeta): TSchema => {
	const opts: { description?: string } = {};
	if (meta.description !== undefined) {
		opts.description = meta.description;
	}
	return StringEnum(
		[...values] as readonly string[],
		opts,
	) as unknown as TSchema;
};

const literalNode = (value: unknown, meta: ZodMeta): TSchema => {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return withMeta(Type.Literal(value), meta);
	}
	throw new Error(`zodToTypebox: unsupported literal type ${typeof value}`);
};

const objectNode = (
	schema: z.ZodObject<z.ZodRawShape>,
	hints: Hints,
	meta: ZodMeta,
): TSchema => {
	const properties: Record<string, TSchema> = {};
	const entries = Object.entries(schema.shape) as [string, z.ZodTypeAny][];
	for (const [key, child] of entries) {
		properties[key] = convertNode(child, hints, key);
	}
	return withMeta(Type.Object(properties), meta);
};

const unionArms = (
	options: readonly z.ZodTypeAny[],
	hints: Hints,
	fieldName: string | undefined,
): TSchema[] => options.map((arm) => convertNode(arm, hints, fieldName));

// Bundles the per-call carry-along state so handler arities stay
// within the project's max-params budget.
interface NodeCtx {
	hints: Hints;
	fieldName: string | undefined;
	meta: ZodMeta;
}

const stringNode = (ctx: NodeCtx): TSchema => {
	const { hints, fieldName, meta } = ctx;
	const hint = fieldName === undefined ? undefined : hints[fieldName];
	if (hint !== undefined && hint.length > 0) {
		return stringEnumNode(hint, meta);
	}
	return withMeta(Type.String(), meta);
};

const enumNode = (
	schema: z.ZodEnum<[string, ...string[]]>,
	meta: ZodMeta,
): TSchema => stringEnumNode(schema.options as readonly string[], meta);

const wrappedNode = (schema: z.ZodTypeAny, ctx: NodeCtx): TSchema | null => {
	const { hints, fieldName, meta } = ctx;
	if (schema instanceof z.ZodOptional) {
		const inner = convertNode(schema.unwrap(), hints, fieldName);
		return Type.Optional(withMeta(inner, meta));
	}
	if (schema instanceof z.ZodNullable) {
		const inner = convertNode(schema.unwrap(), hints, fieldName);
		return withMeta(Type.Union([inner, Type.Null()]), meta);
	}
	if (schema instanceof z.ZodDefault) {
		const def = schema._def as { defaultValue: () => unknown };
		const inner = convertNode(schema._def.innerType, hints, fieldName);
		const defaulted: TSchema = { ...inner, default: def.defaultValue() };
		return withMeta(defaulted, meta);
	}
	return null;
};

const convertNode = (
	schema: z.ZodTypeAny,
	hints: Hints,
	fieldName: string | undefined,
): TSchema => {
	const meta = collectMeta(schema);
	const ctx: NodeCtx = { hints, fieldName, meta };
	const wrapped = wrappedNode(schema, ctx);
	if (wrapped !== null) {
		return wrapped;
	}
	if (schema instanceof z.ZodObject) {
		return objectNode(schema as z.ZodObject<z.ZodRawShape>, hints, meta);
	}
	if (schema instanceof z.ZodEnum) {
		return enumNode(schema as z.ZodEnum<[string, ...string[]]>, meta);
	}
	if (schema instanceof z.ZodLiteral) {
		const { value } = schema;
		return literalNode(value, meta);
	}
	if (schema instanceof z.ZodString) {
		return stringNode(ctx);
	}
	if (schema instanceof z.ZodNumber) {
		return withMeta(Type.Number(), meta);
	}
	if (schema instanceof z.ZodBoolean) {
		return withMeta(Type.Boolean(), meta);
	}
	if (schema instanceof z.ZodArray) {
		return withMeta(
			Type.Array(convertNode(schema.element, hints, undefined)),
			meta,
		);
	}
	if (schema instanceof z.ZodRecord) {
		return withMeta(
			Type.Record(
				Type.String(),
				convertNode(schema.valueSchema, hints, undefined),
			),
			meta,
		);
	}
	if (schema instanceof z.ZodDiscriminatedUnion) {
		return withMeta(
			Type.Union(unionArms(schema.options as z.ZodTypeAny[], hints, fieldName)),
			meta,
		);
	}
	if (schema instanceof z.ZodUnion) {
		return withMeta(
			Type.Union(unionArms(schema.options as z.ZodTypeAny[], hints, fieldName)),
			meta,
		);
	}
	if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
		return withMeta(Type.Any(), meta);
	}
	const typeName = (schema._def as { typeName?: string }).typeName ?? "unknown";
	throw new Error(`zodToTypebox: unsupported zod type ${typeName}`);
};

export const zodToTypebox = (
	schema: z.ZodTypeAny,
	hints: Hints = {},
): TSchema => convertNode(schema, hints, undefined);
