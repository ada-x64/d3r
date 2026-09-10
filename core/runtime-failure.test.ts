import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeFailure,
	formatRuntimeFailure,
	readRuntimeFailure,
	type RuntimeFailure,
	type RuntimeFailureCategory,
} from "./runtime.ts";

/** Safe configured metadata contains no provider diagnostic text. */
const failure: RuntimeFailure = {
	stage: "model_request",
	category: "access",
	httpStatus: 403,
	provider: "configured-provider",
	model: "configured-model",
	toolsStarted: false,
	code: "permission_error",
};

/** Synthetic secrets must never cross the error reporting boundary, even as keys. */
const privateData = {
	message:
		"Bearer fake-credential https://private.invalid/token /private/credentials.json",
	stack: "private-stack",
	headers: {
		Authorization: "fake-key",
		"x-api-key": "fake-key",
		"Set-Cookie": "fake-cookie",
	},
	request: { payload: "private-prompt" },
	cause: new Error("private-cause"),
};

/** The neutral contract is safe to forward even when consumers know nothing about Pi. */
describe("runtime failure reporting", () => {
	it("keeps ordinary Error/rejection behavior while exporting only detached safe data", async () => {
		const input = { ...failure, ...privateData };
		const error = createRuntimeFailure(input);
		await expect(Promise.reject(error)).rejects.toThrow("Model request failed");
		expect(readRuntimeFailure(error)).toEqual(failure);
		input.category = "auth";
		expect(readRuntimeFailure(error)?.category).toBe("access");
		expect(Object.isFrozen(readRuntimeFailure(error))).toBe(true);
		expect(error.stack).toBeUndefined();
		expect(error.cause).toBeUndefined();
		const serialized = JSON.stringify(error);
		expect(serialized).not.toMatch(
			/Bearer|fake-|private|Authorization|x-api-key|Set-Cookie|headers|stack|cause|payload|https:/,
		);
		expect(serialized).toContain("403");
		expect(serialized).toContain("permission_error");
	});

	it("formats fixed guidance, safe identity and status without JSON dumps or policy blame", () => {
		const text = formatRuntimeFailure(failure);
		expect(text).toContain("Model request failed");
		expect(text).toContain("HTTP 403");
		expect(text).toContain("`permission_error`");
		expect(text).toContain("`configured-provider`");
		expect(text).toContain("Check account permissions");
		expect(text).toContain("No tool execution started in this invocation.");
		expect(text).not.toMatch(/content.?policy|safety|\{|\}|workflow/i);
		expect(formatRuntimeFailure({ ...failure, toolsStarted: true })).toContain(
			"may have had effects",
		);
		expect(
			formatRuntimeFailure({ ...failure, toolsStarted: true }),
		).not.toContain("No tool execution");
	});

	it.each([
		["auth", "credentials"],
		["access", "permissions"],
		["rate_limit", "reset"],
		["quota", "billing"],
		["invalid_request", "compatibility"],
		["model_unavailable", "model ID"],
		["context_limit", "Reduce"],
		["network", "connectivity"],
		["timeout", "timed out"],
		["provider_error", "provider status"],
		["unknown", "details are unavailable"],
	] satisfies [RuntimeFailureCategory, string][])(
		"provides actionable fixed guidance for %s",
		(category, expected) => {
			expect(
				formatRuntimeFailure({
					stage: "model_request",
					category,
					toolsStarted: false,
				}),
			).toContain(expected);
		},
	);

	it("does not guess authentication or retry advice when details are unavailable", () => {
		const text = formatRuntimeFailure({
			stage: "model_request",
			category: "unknown",
			toolsStarted: false,
		});
		expect(text).not.toMatch(/auth|credential|sign in|retry|try again/i);
	});

	it("distinguishes output delivery and reliably identified request incompatibilities", () => {
		expect(formatRuntimeFailure({ ...failure, stage: "output" })).toContain(
			"Runtime output delivery failed",
		);
		expect(
			formatRuntimeFailure({
				...failure,
				category: "invalid_request",
				detail: "invalid_tool_schema",
			}),
		).toContain("rejected a tool schema");
		expect(
			formatRuntimeFailure({
				...failure,
				category: "invalid_request",
				detail: "invalid_thinking_options",
			}),
		).toContain("rejected thinking or reasoning options");
	});

	it.each([
		undefined,
		null,
		new Error("Model request failed"),
		{ ...failure },
		{ runtimeFailure: { ...failure, category: "invented" } },
		{ runtimeFailure: { ...failure, toolsStarted: undefined } },
		{ runtimeFailure: { ...failure, httpStatus: 999 } },
		{ runtimeFailure: { ...failure, code: "Authorization-fake-key" } },
	])("does not trust untagged or malformed failures", (error) => {
		expect(readRuntimeFailure(error)).toBeUndefined();
	});

	it("does not run getters, coercions or serialization hooks, or walk extra cyclic data", () => {
		const getter = vi.fn(() => {
			throw new Error("must not execute");
		});
		const input = Object.defineProperty(
			{ ...failure, ...privateData },
			"cause",
			{ get: getter },
		);
		Object.defineProperty(input, "toJSON", { get: getter });
		Object.defineProperty(input, "unused", { value: input });
		expect(readRuntimeFailure({ runtimeFailure: input })).toEqual(failure);
		expect(
			readRuntimeFailure(
				Object.defineProperty({}, "runtimeFailure", { get: getter }),
			),
		).toBeUndefined();
		expect(
			readRuntimeFailure({
				runtimeFailure: Object.defineProperty({ ...failure }, "toolsStarted", {
					get: getter,
				}),
			}),
		).toBeUndefined();
		const proxy = new Proxy(
			{},
			{ get: getter, getOwnPropertyDescriptor: getter },
		);
		expect(readRuntimeFailure(proxy)).toBeUndefined();
		expect(readRuntimeFailure({ runtimeFailure: proxy })).toBeUndefined();
		// oxlint-disable-next-line unicorn/no-thenable -- Hostile scalar fixture must not reach Zod's thenable detection.
		const scalar = Object.defineProperty({}, "then", { get: getter });
		expect(
			readRuntimeFailure({ runtimeFailure: { ...failure, category: scalar } }),
		).toBeUndefined();
		expect(getter).not.toHaveBeenCalled();
	});

	it("omits URL/path/Markdown identities and bounds oversized catalog input", () => {
		const hugeLength = 1_000_000;
		for (const identity of [
			"https://private.invalid/key",
			"/private/key",
			String.raw`C:\private\key`,
			"[link](private)",
			"../private",
			"x".repeat(hugeLength),
		]) {
			const error = createRuntimeFailure({
				...failure,
				provider: identity,
				model: identity,
			});
			expect(readRuntimeFailure(error)).toEqual({
				...failure,
				provider: undefined,
				model: undefined,
			});
			expect(error.message).not.toContain(identity);
		}
	});
});
