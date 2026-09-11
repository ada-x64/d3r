/* oxlint-disable no-magic-numbers -- Explicit safety-boundary fixtures. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { permissionIdentity } from "./permission-identity.ts";

/** Use the real envelope, not a display-redacted approximation. */
const identify = (input: unknown) =>
	permissionIdentity({
		toolCallId: "transient-id",
		title: "approval",
		kind: "other",
		input,
	});

/** Exact identities must follow JSON semantics without executing object behavior. */
describe("permission identity", () => {
	it("hashes deep-sorted JSON, including numeric and prototype-like keys, without call IDs", () => {
		const input = JSON.parse(
			'{"2":2,"10":10,"nested":{"z":0,"a":[true,null,"x"]},"__proto__":{"b":2,"a":1}}',
		);
		const canonical =
			'{"input":{"10":10,"2":2,"__proto__":{"a":1,"b":2},"nested":{"a":[true,null,"x"],"z":0}},"kind":"other","title":"approval"}';
		const result = identify(input);
		expect(result?.exactId).toBe(
			`exact:${createHash("sha256").update(canonical).digest("hex")}`,
		);
		expect(result?.input).toEqual(input);
		expect(
			identify(Object.fromEntries(Object.entries(input).toReversed()))?.exactId,
		).toBe(result?.exactId);
		expect(
			permissionIdentity({ ...result, toolCallId: "next-role" })?.exactId,
		).toBe(result?.exactId);
	});

	it("snapshots frozen plain data and shared children without retaining mutable input", () => {
		const child = Object.assign(Object.create(null), { present: 1 });
		const input = Object.freeze({
			child,
			array: Object.freeze([child, child]),
		});
		const result = identify(input);
		expect(result?.input).toEqual({
			child: { present: 1 },
			array: [{ present: 1 }, { present: 1 }],
		});
		expect(identify(result?.input)?.exactId).toBe(result?.exactId);
		child.present = 2;
		expect(result?.input).toEqual({
			child: { present: 1 },
			array: [{ present: 1 }, { present: 1 }],
		});
		expect(identify(input)?.exactId).not.toBe(result?.exactId);
	});

	it("never gives normalized undefined fields an exact identity", () => {
		expect(identify(undefined)).toBeUndefined();
		for (const { input, normalized } of [
			{ input: { absent: undefined }, normalized: {} },
			{ input: { nested: { absent: undefined } }, normalized: { nested: {} } },
			{ input: [{ absent: undefined }], normalized: [{}] },
		]) {
			const result = identify(input);
			expect(result).toBeDefined();
			expect(result?.input).toEqual(normalized);
			expect(result?.exactId).toBeUndefined();
			expect(identify(result?.input)?.exactId).toMatch(/^exact:[a-f0-9]{64}$/);
		}
	});

	it("never gives negative zero an exact identity, including in nested objects and arrays", () => {
		for (const { input, normalized } of [
			{ input: -0, normalized: 0 },
			{
				input: { nested: { value: -0 } },
				normalized: { nested: { value: 0 } },
			},
			{ input: [-0, 0], normalized: [0, 0] },
		]) {
			const result = identify(input);
			expect(result).toBeDefined();
			expect(result?.input).toEqual(normalized);
			expect(result?.exactId).toBeUndefined();
			expect(identify(normalized)?.exactId).toMatch(/^exact:[a-f0-9]{64}$/);
		}
	});

	it.each([null, true, false, 0, -1.5, "", "primitive"])(
		"accepts finite JSON primitive %j",
		(input) => {
			expect(identify(input)?.input).toBe(input);
		},
	);

	it.each([
		NaN,
		Infinity,
		-Infinity,
		1n,
		Symbol("value"),
		() => 1,
		new Date(),
		new Map(),
		new Set(),
		new Uint8Array([1]),
		new String("boxed"),
		Object.create({ inherited: 1 }),
		[undefined],
		Array(1),
		Object.assign([1], { extra: true }),
		Object.defineProperty({}, "hidden", { value: 1 }),
		{ [Symbol("hidden")]: 1 },
	])("rejects non-plain or lossy JSON (case %#)", (input) => {
		expect(identify(input)).toBeUndefined();
		expect(identify({ nested: input })).toBeUndefined();
	});

	it("rejects cycles, depth, node, and UTF-8/escaped-byte overflow", () => {
		const cycle: unknown[] = [];
		cycle.push(cycle);
		const deep = Array.from({ length: 40 }).reduce<unknown>(
			(value) => ({ value }),
			null,
		);
		for (const input of [
			cycle,
			deep,
			Array(4096).fill(0),
			"x".repeat(8_388_608),
			"\u00e9".repeat(4_194_304),
			"\0".repeat(1_398_102),
		]) {
			expect(identify(input)).toBeUndefined();
		}
		expect(identify({ text: "x".repeat(8_000_000) })).toBeDefined();
		expect(identify(Array(1000).fill(null))).toBeDefined();
	});

	it("does not execute toJSON, accessors, proxies, or revoked proxy traps", () => {
		const hook = vi.fn(() => {
			throw new Error("must not execute");
		});
		const getter = Object.defineProperty({}, "secret", {
			get: hook,
			enumerable: true,
		});
		const proxy = new Proxy(
			{},
			{
				get: hook,
				getPrototypeOf: hook,
				ownKeys: hook,
				getOwnPropertyDescriptor: hook,
			},
		);
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		const array = Object.defineProperty([1], "0", {
			get: hook,
			enumerable: true,
		});
		for (const input of [
			getter,
			{ toJSON: hook },
			proxy,
			revoked.proxy,
			array,
		]) {
			expect(identify(input)).toBeUndefined();
			expect(identify({ nested: input })).toBeUndefined();
		}
		expect(permissionIdentity(proxy)).toBeUndefined();
		for (const key of ["title", "kind", "input", "toolCallId", "scope"]) {
			const request = {
				title: "safe",
				kind: "other",
				input: {},
				toolCallId: "id",
			};
			Object.defineProperty(request, key, { get: hook });
			expect(permissionIdentity(request)).toBeUndefined();
		}
		expect(hook).not.toHaveBeenCalled();
	});

	it("treats unsafe explicit metadata as absent without traversing or executing it", () => {
		const hook = vi.fn(() => {
			throw new Error("must not execute");
		});
		const proxy = new Proxy(
			{},
			{ get: hook, getPrototypeOf: hook, ownKeys: hook },
		);
		for (const scope of [
			proxy,
			{ id: proxy, label: "unsafe" },
			Object.defineProperty({ label: "unsafe" }, "id", { get: hook }),
		]) {
			const request = {
				title: "safe",
				kind: "other",
				input: {},
				toolCallId: "id",
				scope,
			};
			expect(permissionIdentity(request)).toMatchObject({
				scope: undefined,
				exactId: expect.stringMatching(/^exact:[a-f0-9]{64}$/),
			});
		}
		expect(hook).not.toHaveBeenCalled();
	});
});
