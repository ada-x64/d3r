// Walks a tool's zod schema into a flat record of CLI arg specs.
// The dispatcher consumes the record to drive `node:util.parseArgs`,
// to print per-tool usage, and to coerce string values back into the
// types zod expects. The walker pokes at zod's `_def` shape because
// no public reflection API exists; the unit tests guard against
// silent regressions if zod's internals shift.

import { type z } from "zod";

/** A single CLI argument derived from one zod schema field. */
export type ArgSpec =
	| {
			type: "string";
			required: boolean;
			default?: string;
			description?: string;
			valueHint?: string;
			/** True for primitive arrays serialised as comma-joined strings. */
			multi?: boolean;
	  }
	| {
			type: "number";
			required: boolean;
			default?: number;
			description?: string;
	  }
	| {
			type: "boolean";
			required: boolean;
			default?: boolean;
			description?: string;
	  };

/** A flat name->spec map ready to be turned into parseArgs options. */
export type ArgsRecord = Record<string, ArgSpec>;

/** Top-level walk result: either a plain object or a discriminated union. */
export type WalkResult =
	| { kind: "object"; args: ArgsRecord }
	| {
			kind: "union";
			discriminator: string;
			variants: Record<string, z.ZodObject<z.ZodRawShape>>;
	  };

/**
 * Map a tool's top-level schema to a CLI arg description.
 * Top-level must be `ZodObject` or `ZodDiscriminatedUnion`; anything
 * else throws so the failure is loud at registration time, not silent
 * at parse time.
 */
export const walkSchema = (schema: z.ZodTypeAny): WalkResult => {
	const def = schema._def as { typeName?: string };
	if (def.typeName === "ZodObject") {
		return {
			kind: "object",
			args: walkObject(schema as z.ZodObject<z.ZodRawShape>),
		};
	}
	if (def.typeName === "ZodDiscriminatedUnion") {
		const union = schema as z.ZodDiscriminatedUnion<
			string,
			z.ZodObject<z.ZodRawShape>[]
		>;
		const variants: Record<string, z.ZodObject<z.ZodRawShape>> = {};
		for (const [key, variant] of union.optionsMap.entries()) {
			variants[String(key)] = variant;
		}
		return {
			kind: "union",
			discriminator: union._def.discriminator,
			variants,
		};
	}
	throw new Error(
		`top-level schema must be ZodObject or ZodDiscriminatedUnion; got ${def.typeName ?? "unknown"}`,
	);
};

const walkObject = (obj: z.ZodObject<z.ZodRawShape>): ArgsRecord => {
	const out: ArgsRecord = {};
	for (const [key, field] of Object.entries(obj.shape)) {
		out[key] = walkLeaf(field as z.ZodTypeAny, key);
	}
	return out;
};

interface Wrap {
	required: boolean;
	defaultValue: unknown;
}

/** Peel ZodOptional / ZodDefault / ZodNullable layers off in any order. */
const unwrap = (
	field: z.ZodTypeAny,
	wrap: Wrap = { required: true, defaultValue: undefined },
): { inner: z.ZodTypeAny; wrap: Wrap } => {
	const { typeName } = field._def as { typeName?: string };
	if (typeName === "ZodOptional" || typeName === "ZodNullable") {
		const { innerType } = field._def as { innerType: z.ZodTypeAny };
		return unwrap(innerType, {
			required: false,
			defaultValue: wrap.defaultValue,
		});
	}
	if (typeName === "ZodDefault") {
		const { innerType, defaultValue } = field._def as {
			innerType: z.ZodTypeAny;
			defaultValue: () => unknown;
		};
		return unwrap(innerType, { required: false, defaultValue: defaultValue() });
	}
	return { inner: field, wrap };
};

interface DecorateArgs<T extends ArgSpec> {
	spec: T;
	wrap: Wrap;
	description: string | undefined;
	coerce: (v: unknown) => T["default"];
}

/** Apply default + description on whichever primitive ArgSpec was just built. */
const decorate = <T extends ArgSpec>({
	spec,
	wrap,
	description,
	coerce,
}: DecorateArgs<T>): T => {
	if (wrap.defaultValue !== undefined) {
		spec.default = coerce(wrap.defaultValue);
	}
	if (description) {
		spec.description = description;
	}
	return spec;
};

const walkLeaf = (field: z.ZodTypeAny, path: string): ArgSpec => {
	const { inner, wrap } = unwrap(field);
	const { description } = inner._def as { description?: string };
	const { typeName: tn } = inner._def as { typeName?: string };
	switch (tn) {
		case "ZodString": {
			return decorate({
				spec: { type: "string", required: wrap.required } as const,
				wrap,
				description,
				coerce: (v) => String(v),
			});
		}
		case "ZodNumber": {
			return decorate({
				spec: { type: "number", required: wrap.required } as const,
				wrap,
				description,
				coerce: (v) => Number(v),
			});
		}
		case "ZodBoolean": {
			return decorate({
				spec: { type: "boolean", required: wrap.required } as const,
				wrap,
				description,
				coerce: (v) => Boolean(v),
			});
		}
		case "ZodLiteral": {
			// Discriminator fields land here when re-walking a union variant.
			// Treated as an optional string with the literal as default so the
			// dispatcher can drop the flag without losing zod's final check.
			const lit = (inner._def as { value: unknown }).value;
			return {
				type: "string",
				required: false,
				default: String(lit),
				description: `literal: ${String(lit)}`,
			};
		}
		case "ZodEnum":
		case "ZodNativeEnum": {
			const opts =
				tn === "ZodEnum"
					? ((inner._def as { values: readonly string[] }).values ?? [])
					: Object.values(
							(inner._def as { values: Record<string, string | number> })
								.values,
						).map((v) => String(v));
			const spec: ArgSpec = {
				type: "string",
				required: wrap.required,
				valueHint: opts.join("|"),
				description: description ?? `one of: ${opts.join(", ")}`,
			};
			if (wrap.defaultValue !== undefined) {
				spec.default = String(wrap.defaultValue);
			}
			return spec;
		}
		case "ZodArray": {
			const elem = (inner._def as { type: z.ZodTypeAny }).type;
			const elemKind = (elem._def as { typeName?: string }).typeName;
			const primitives = new Set([
				"ZodString",
				"ZodNumber",
				"ZodBoolean",
				"ZodEnum",
				"ZodLiteral",
			]);
			if (!elemKind || !primitives.has(elemKind)) {
				throw new Error(
					`unsupported array element at ${path}: ${elemKind ?? "unknown"}; use a JSON file or stdin`,
				);
			}
			const spec: ArgSpec = {
				type: "string",
				required: wrap.required,
				description: description ?? "comma-separated",
				multi: true,
			};
			if (wrap.defaultValue !== undefined && Array.isArray(wrap.defaultValue)) {
				spec.default = wrap.defaultValue.map(String).join(",");
			}
			return spec;
		}
		case "ZodObject": {
			throw new Error(
				`unsupported nested object at ${path}; flat schemas only`,
			);
		}
		default: {
			throw new Error(`unsupported zod node at ${path}: ${tn ?? "unknown"}`);
		}
	}
};
