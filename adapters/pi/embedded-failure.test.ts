import { resolve } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import {
	createEmbeddedRuntime,
	type EmbeddedRuntimeOptions,
} from "@d3r/adapter-pi/embedded";
import {
	readRuntimeFailure,
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeTool,
} from "@d3r/core/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** No private state, files, credentials, or network are consulted by these fixtures. */
const cwd = resolve("embedded-failure-workspace");
/** Intentionally credential-shaped but entirely synthetic provider diagnostic text. */
const privateText =
	"Authorization: Bearer fake-secret; x-api-key: fake-secret; https://private.invalid/token /private/credentials.json";
/** Ordinary prompt delivery can be replaced to exercise output failure or cancellation. */
const prompt = (overrides: Partial<RuntimePrompt> = {}): RuntimePrompt => ({
	content: [{ type: "text", text: "test invocation" }],
	signal: new AbortController().signal,
	emit: async () => {},
	...overrides,
});

/** Capture rejection without replacing the real prompt or swallowing assertion failures. */
const captureError = (error: unknown): unknown => error;

/** Real model/tool loop tests stop at the injected offline provider seam, not ACP. */
describe("embedded runtime failure propagation", () => {
	const sessions: RuntimeSession[] = [];
	const open = (overrides: Partial<EmbeddedRuntimeOptions> = {}) => {
		const faux = fauxProvider({
			models: [{ id: "configured-model", reasoning: true }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const factory = createEmbeddedRuntime({
			models,
			model,
			systemPrompt: "offline",
			...overrides,
		});
		const session = factory({ sessionId: "failure-test", cwd });
		sessions.push(session);
		return { faux, models, model, session };
	};
	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((session) => session.dispose()));
	});

	it("reports a pre-delta failure using the selected model and rolls back only the failed turn", async () => {
		const f = open();
		const contexts: Context[] = [];
		f.faux.setResponses([
			fauxAssistantMessage("kept answer"),
			{
				...fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: `403 {"error":{"type":"permission_error","message":${JSON.stringify(privateText)}}}`,
				}),
				provider: "forged-provider",
				model: "forged-model",
			},
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("recovered");
			},
		]);
		await f.session.prompt(prompt());
		const before = f.session.snapshot!();
		const emit = vi.fn(async () => {});
		const running = f.session.prompt(
			prompt({ content: [{ type: "text", text: "failed prompt" }], emit }),
		);
		await expect(running).rejects.toThrow("Model request failed");
		const error: unknown = await running.catch(captureError);
		expect(readRuntimeFailure(error)).toEqual({
			stage: "model_request",
			category: "access",
			httpStatus: 403,
			code: "permission_error",
			provider: f.model.provider,
			model: f.model.id,
			toolsStarted: false,
		});
		expect(emit).not.toHaveBeenCalled();
		expect(JSON.stringify(error)).not.toMatch(
			/fake-secret|Authorization|x-api-key|private|forged/,
		);
		expect(f.session.snapshot!()).toEqual(before);
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		expect(JSON.stringify(contexts)).toContain("kept answer");
		expect(JSON.stringify(contexts)).not.toMatch(
			/failed prompt|private|permission_error/,
		);
	});

	it("captures a structured synchronous stream exception before Pi stringifies it", async () => {
		const getter = vi.fn(() => {
			throw new Error("must not run");
		});
		const thrown = Object.defineProperties(
			{ status: 429, code: "insufficient_quota" },
			{
				message: { get: getter },
				toString: { get: getter },
				headers: { get: getter },
			},
		);
		const f = open({
			models: {
				streamSimple: () => {
					throw thrown;
				},
			},
		});
		const error: unknown = await f.session.prompt(prompt()).catch(captureError);
		expect(readRuntimeFailure(error)).toMatchObject({
			category: "quota",
			httpStatus: 429,
			code: "insufficient_quota",
			toolsStarted: false,
		});
		expect(getter).not.toHaveBeenCalled();
	});

	it("retains HTTP response status when the provider's terminal message drops it", async () => {
		const source = open();
		const headers = Object.defineProperty({}, "Authorization", {
			get: () => {
				throw new Error("must not read headers");
			},
		});
		const f = open({
			model: source.model,
			models: {
				streamSimple: (model, context, settings) =>
					source.models.streamSimple(model, context, {
						...settings,
						onResponse: async (_response, responseModel) =>
							settings?.onResponse?.({ status: 429, headers }, responseModel),
					}),
			},
		});
		source.faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: privateText,
			}),
		]);
		const error = await f.session.prompt(prompt()).catch(captureError);
		expect(readRuntimeFailure(error)).toMatchObject({
			category: "rate_limit",
			httpStatus: 429,
			toolsStarted: false,
		});
		expect(JSON.stringify(error)).not.toMatch(
			/Authorization|fake-secret|headers|private/,
		);
	});

	it("keeps the auth category through the library's lazy-stream and redacted auth wrapper text", async () => {
		const f = open();
		f.models.setProvider({
			...f.faux.provider,
			auth: {
				apiKey: {
					name: "offline",
					resolve: async () => {
						throw new Error("Provider authentication failed");
					},
				},
			},
		});
		const error: unknown = await f.session.prompt(prompt()).catch(captureError);
		expect(readRuntimeFailure(error)).toMatchObject({
			stage: "model_request",
			category: "auth",
			toolsStarted: false,
			provider: f.model.provider,
			model: f.model.id,
		});
		expect(f.faux.state.callCount).toBe(0);
	});

	it.each(["streamed", "synchronous"] as const)(
		"preserves effects and toolsStarted after a %s provider failure with zero usage",
		async (mode) => {
			const effects: string[] = [];
			const contexts: Context[] = [];
			const tool: RuntimeTool = {
				name: "write",
				description: "offline effect",
				kind: "edit",
				permission: "none",
				schema: z.object({}),
				execute: async () => {
					effects.push("written");
					return { text: "effect recorded" };
				},
			};
			const source = open();
			let calls = 0;
			const failedRequest = 2;
			const f = open({
				tools: [tool],
				model: source.model,
				models: {
					streamSimple: (model, context, settings) => {
						calls += 1;
						if (
							mode === "synchronous" &&
							effects.length > 0 &&
							calls === failedRequest
						) {
							throw {
								status: 400,
								error: {
									code: "invalid_request_error",
									message: `Invalid schema for function 'write': ${privateText}`,
								},
							};
						}
						return source.models.streamSimple(model, context, settings);
					},
				},
			});
			source.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", {})),
				...(mode === "streamed"
					? [
							fauxAssistantMessage("partial reply", {
								stopReason: "error",
								errorMessage: `400 {"error":{"code":"invalid_request_error","message":${JSON.stringify(`Invalid schema for function 'write': ${privateText}`)}}}`,
							}),
						]
					: []),
				(context: Context) => {
					contexts.push({ messages: structuredClone(context.messages) });
					return fauxAssistantMessage("recovered");
				},
			]);
			const error: unknown = await f.session
				.prompt(prompt())
				.catch(captureError);
			expect(readRuntimeFailure(error)).toMatchObject({
				category: "invalid_request",
				httpStatus: 400,
				code: "invalid_request_error",
				detail: "invalid_tool_schema",
				toolsStarted: true,
			});
			expect((error as Error).message).toContain("may have had effects");
			expect((error as Error).message).not.toContain("No tool execution");
			expect(effects).toEqual(["written"]);
			expect(calls).toBe(failedRequest);
			const saved = JSON.stringify(f.session.snapshot!());
			expect(saved).toContain("effect recorded");
			expect(saved).not.toMatch(/fake-secret|Authorization|x-api-key|private/);
			await expect(f.session.prompt(prompt())).resolves.toBe("completed");
			expect(JSON.stringify(contexts)).toContain("effect recorded");
			expect(JSON.stringify(contexts)).not.toContain("fake-secret");
			expect(effects).toEqual(["written"]);
		},
	);

	it("scopes no-tools reporting to this invocation, not earlier effects in the session", async () => {
		const effects: string[] = [];
		const f = open({
			tools: [
				{
					name: "write",
					description: "offline effect",
					kind: "edit",
					permission: "none",
					schema: z.object({}),
					execute: async () => {
						effects.push("written");
						return { text: "effect recorded" };
					},
				},
			],
		});
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", {})),
			fauxAssistantMessage("done"),
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "401 rejected",
			}),
		]);
		await f.session.prompt(prompt());
		const before = f.session.snapshot!();
		const error = await f.session.prompt(prompt()).catch(captureError);
		expect(readRuntimeFailure(error)).toMatchObject({
			category: "auth",
			toolsStarted: false,
		});
		expect((error as Error).message).toContain(
			"No tool execution started in this invocation",
		);
		expect(f.session.snapshot!()).toEqual(before);
		expect(effects).toEqual(["written"]);
	});

	it("does not confuse announced but blocked tool calls with execution", async () => {
		const execute = vi.fn(async () => ({ text: "not allowed" }));
		const f = open({
			tools: [
				{
					name: "write",
					description: "denied",
					kind: "edit",
					permission: "ask",
					schema: z.object({}),
					execute,
				},
			],
		});
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", {})),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "503 service unavailable",
			}),
		]);
		const error: unknown = await f.session.prompt(prompt()).catch(captureError);
		expect(readRuntimeFailure(error)).toMatchObject({
			category: "provider_error",
			httpStatus: 503,
			toolsStarted: false,
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"separates output failure from provider failure (toolsStarted=%s)",
		async (toolsStarted) => {
			const effects: string[] = [];
			const f = open({
				tools: toolsStarted
					? [
							{
								name: "write",
								description: "offline effect",
								kind: "edit",
								permission: "none",
								schema: z.object({}),
								execute: async () => {
									effects.push("written");
									return { text: "effect recorded" };
								},
							},
						]
					: [],
			});
			f.faux.setResponses([
				...(toolsStarted
					? [fauxAssistantMessage(fauxToolCall("write", {}))]
					: []),
				fauxAssistantMessage("answer"),
			]);
			const error: unknown = await f.session
				.prompt(
					prompt({
						emit: async () => {
							throw new Error(privateText);
						},
					}),
				)
				.catch(captureError);
			expect(readRuntimeFailure(error)).toMatchObject({
				stage: "output",
				category: "unknown",
				toolsStarted,
			});
			expect((error as Error).message).toContain(
				"Runtime output delivery failed",
			);
			expect(JSON.stringify(error)).not.toContain("fake-secret");
			expect(effects.length).toBe(toolsStarted ? 1 : 0);
		},
	);

	it("returns cancelled even when a provider error arrives at the cancellation boundary", async () => {
		const controller = new AbortController();
		const f = open();
		f.faux.setResponses([
			() => {
				controller.abort();
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: `401 ${privateText}`,
				});
			},
		]);
		await expect(
			f.session.prompt(prompt({ signal: controller.signal })),
		).resolves.toBe("cancelled");
	});

	it("isolates simultaneous failures and clears captured status before later requests", async () => {
		const f = open({
			models: {
				streamSimple: () => {
					throw { status: 401, code: "invalid_api_key" };
				},
			},
		});
		const other = open();
		other.faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '429 {"error":{"code":"rate_limit_exceeded"}}',
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: privateText,
			}),
		]);
		const errors = await Promise.all(
			[f.session, other.session].map(async (session) =>
				session.prompt(prompt()).catch((error: unknown) => error),
			),
		);
		expect(readRuntimeFailure(errors[0])).toMatchObject({
			category: "auth",
			httpStatus: 401,
		});
		expect(readRuntimeFailure(errors[1])).toMatchObject({
			category: "rate_limit",
			httpStatus: 429,
		});
		const next: unknown = await other.session
			.prompt(prompt())
			.catch((error: unknown) => error);
		expect(readRuntimeFailure(next)).toMatchObject({
			category: "unknown",
			toolsStarted: false,
		});
		const streamedStatus = 200;
		expect(readRuntimeFailure(next)?.httpStatus).toBe(streamedStatus);
	});
});
