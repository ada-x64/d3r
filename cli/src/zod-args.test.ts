// Pin the walker's reflection of zod's `_def` shape: the dispatcher
// relies on these mappings being stable, so when zod changes its
// internals we want the failure here, not at runtime against a real
// tool invocation.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { walkSchema } from "./zod-args.ts";

describe("walkSchema", () => {
	it("maps a flat object of primitives", () => {
		const schema = z.object({
			name: z.string(),
			count: z.number().default(1),
			force: z.boolean().optional(),
		});
		const result = walkSchema(schema);
		expect(result.kind).toBe("object");
		if (result.kind !== "object") {
			return;
		}
		expect(result.args).toEqual({
			name: { type: "string", required: true },
			count: { type: "number", required: false, default: 1 },
			force: { type: "boolean", required: false },
		});
	});

	it("emits valueHint and description for enums", () => {
		const schema = z.object({ mode: z.enum(["a", "b"]) });
		const result = walkSchema(schema);
		if (result.kind !== "object") {
			throw new Error("expected object");
		}
		expect(result.args.mode).toMatchObject({
			type: "string",
			required: true,
			valueHint: "a|b",
		});
	});

	it("treats arrays of primitives as comma-separated strings", () => {
		const schema = z.object({ tags: z.array(z.string()).optional() });
		const result = walkSchema(schema);
		if (result.kind !== "object") {
			throw new Error("expected object");
		}
		expect(result.args.tags).toMatchObject({
			type: "string",
			required: false,
			description: "comma-separated",
			multi: true,
		});
	});

	it("decomposes a discriminated union into variants", () => {
		const schema = z.discriminatedUnion("mode", [
			z.object({ mode: z.literal("a"), x: z.string() }),
			z.object({ mode: z.literal("b"), y: z.number() }),
		]);
		const result = walkSchema(schema);
		expect(result.kind).toBe("union");
		if (result.kind !== "union") {
			return;
		}
		expect(result.discriminator).toBe("mode");
		expect(Object.keys(result.variants).toSorted()).toEqual(["a", "b"]);
	});

	it("re-walks a chosen variant, including its literal discriminator", () => {
		const schema = z.discriminatedUnion("mode", [
			z.object({ mode: z.literal("a"), x: z.string() }),
		]);
		const top = walkSchema(schema);
		if (top.kind !== "union") {
			throw new Error("expected union");
		}
		const variant = walkSchema(top.variants.a);
		if (variant.kind !== "object") {
			throw new Error("expected object");
		}
		expect(variant.args.x).toMatchObject({ type: "string", required: true });
		expect(variant.args.mode).toMatchObject({
			type: "string",
			required: false,
			default: "a",
		});
	});

	it("rejects nested objects", () => {
		const schema = z.object({ inner: z.object({ a: z.string() }) });
		expect(() => walkSchema(schema)).toThrow(/unsupported nested object/);
	});

	it("rejects non-object, non-union top-level schemas", () => {
		expect(() => walkSchema(z.string())).toThrow(
			/top-level schema must be ZodObject or ZodDiscriminatedUnion/,
		);
	});

	it("rejects arrays of objects with a clear pointer", () => {
		const schema = z.object({
			items: z.array(z.object({ k: z.string() })),
		});
		expect(() => walkSchema(schema)).toThrow(
			/unsupported array element.*JSON file or stdin/,
		);
	});
});
