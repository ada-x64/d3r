import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getSupportedThinkingLevels,
	type Context,
} from "@earendil-works/pi-ai";
import {
	createEmbeddedRuntime,
	type EmbeddedRuntimeOptions,
} from "@d3r/adapter-pi/embedded";
import {
	type RuntimeActivity,
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeSessionInput,
	type RuntimeTool,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseCheckpoint } from "./embedded-checkpoint.ts";

/** Explicit workspaces avoid reliance on process-wide cwd or hidden filesystem IO. */
const CWD = resolve("embedded-tools-workspace");

/** Default inputs leave all transport and capability choices to individual tests. */
const prompt = (overrides: Partial<RuntimePrompt> = {}): RuntimePrompt => ({
	content: [{ type: "text", text: "hello" }],
	signal: new AbortController().signal,
	emit: async () => {},
	...overrides,
});

/** Controlled settlement tests cleanup without sleeps or production provider access. */
const gate = <T>() => {
	let release: (value: T) => void = vi.fn();
	const promise = new Promise<T>((resolvePromise) => {
		release = resolvePromise;
	});
	return { promise, release };
};

/** Pi context includes executable tools; copy only the model-facing declaration fields. */
const captureContext = (context: Context): Context => ({
	...structuredClone({
		systemPrompt: context.systemPrompt,
		messages: context.messages,
	}),
	tools: context.tools?.map(({ name, description, parameters }) => ({
		name,
		description,
		parameters: structuredClone(parameters),
	})),
});

/** Tool schemas, not TypeBox approximations, authorize execution arguments. */
const tool = (overrides: Partial<RuntimeTool> = {}): RuntimeTool => ({
	name: "write",
	description: "Write a test file",
	kind: "edit",
	permission: "ask",
	schema: z.object({ path: z.string(), text: z.string().default("default") }),
	execute: async () => ({ text: "written" }),
	...overrides,
});

/** Identify selectors through public metadata rather than assuming provider IDs. */
const plainKey = (session: RuntimeSession) =>
	session
		.getConfig?.()[0]
		.options.find((entry) => entry.value.endsWith("/plain"))?.value ??
	"missing";

/** Persistence uses JSON, so test its serialization rather than just object cloning. */
const wireRoundTrip = (input: unknown): unknown => {
	const serialized = JSON.stringify(input);
	return JSON.parse(serialized);
};

/** Fractional bounds are rejected even when finite and positive. */
const FRACTIONAL_LIMIT = 1.5;

/** Real pinned Pi libraries exercise the complete model/tool loop offline. */
describe("embedded runtime expansion", () => {
	const sessions: RuntimeSession[] = [];
	const open = (
		options: Partial<EmbeddedRuntimeOptions> = {},
		input: Partial<RuntimeSessionInput> = {},
	) => {
		const faux = fauxProvider({
			models: [
				{ id: "vision", reasoning: true, input: ["text", "image"] },
				{ id: "plain", reasoning: false, input: ["text"] },
			],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const factory = createEmbeddedRuntime({
			models,
			model: faux.models[0],
			modelChoices: faux.models,
			systemPrompt: "injected system",
			...options,
		});
		const createSession = () => {
			const session = factory({ sessionId: "same-id", cwd: CWD, ...input });
			sessions.push(session);
			return session;
		};
		return { faux, session: createSession(), createSession };
	};
	const checkpoint = (session: RuntimeSession) =>
		parseCheckpoint(session.snapshot?.());

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((session) => session.dispose()));
	});

	it("awaits approval before effects and forwards schemas, roots, statuses, diffs, and usage", async () => {
		const approved = gate<boolean>();
		const permission = vi.fn(async () => approved.promise);
		const result: RuntimeToolResult = {
			text: "written",
			content: [
				{
					type: "diff",
					path: resolve(CWD, "a"),
					oldText: null,
					newText: "default",
				},
			],
			locations: [{ path: resolve(CWD, "a"), line: 1 }],
		};
		const execute = vi.fn(async () => result);
		const root = resolve(CWD, "other");
		const f = open(
			{ tools: [tool({ execute })] },
			{
				client: { requestPermission: permission },
				additionalDirectories: [root],
			},
		);
		const contexts: Context[] = [];
		f.faux.setResponses([
			(context) => {
				contexts.push(captureContext(context));
				return fauxAssistantMessage(
					fauxToolCall("write", { path: "a" }, { id: "raw-id" }),
				);
			},
			(context) => {
				contexts.push(captureContext(context));
				return fauxAssistantMessage("done");
			},
		]);
		const events: RuntimeActivity[] = [];
		const observed = f.session
			.prompt(
				prompt({
					activity: async (event) => {
						events.push(event);
					},
				}),
			)
			.catch((error: unknown) => error);
		try {
			await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
			expect(execute).not.toHaveBeenCalled();
			expect(
				events
					.filter((event) => event.kind === "tool")
					.map((event) => event.status),
			).toEqual(["pending"]);
		} finally {
			approved.release(true);
			await expect(observed).resolves.toBe("completed");
		}
		const eventsForTool = events.filter((event) => event.kind === "tool");
		expect(eventsForTool.map((event) => event.status)).toEqual([
			"pending",
			"in_progress",
			"completed",
		]);
		const id = eventsForTool[0].toolCallId;
		expect(id).toMatch(/^d3r:same-id:.*:tool:/);
		expect(id).not.toBe("raw-id");
		expect(eventsForTool.every((event) => event.toolCallId === id)).toBe(true);
		expect(permission).toHaveBeenCalledWith(
			{
				toolCallId: id,
				title: "write",
				kind: "edit",
				input: { path: "a", text: "default" },
			},
			expect.any(AbortSignal),
		);
		expect(execute).toHaveBeenCalledWith(
			{ path: "a", text: "default" },
			{
				toolCallId: id,
				cwd: CWD,
				roots: [CWD, root],
				signal: expect.any(AbortSignal),
				client: { requestPermission: permission },
			},
		);
		expect(eventsForTool.at(-1)).toMatchObject({
			content: result.content,
			locations: result.locations,
			rawOutput: result,
		});
		expect(contexts[0].tools?.[0].parameters).toMatchObject({
			type: "object",
			properties: {
				path: { type: "string" },
				text: { type: "string", default: "default" },
			},
			required: ["path"],
		});
		expect(
			contexts[1].messages.find((entry) => entry.role === "toolResult"),
		).toMatchObject({
			toolCallId: "raw-id",
			content: [{ type: "text", text: "written" }],
			isError: false,
		});
		const saved = checkpoint(f.session);
		const assistant = saved.messages.find(
			(entry) => entry.role === "assistant",
		);
		expect(events.find((event) => event.kind === "usage")).toEqual({
			kind: "usage",
			used: assistant?.usage.totalTokens,
			size: f.faux.models[0].contextWindow,
			cost: { amount: assistant?.usage.cost.total, currency: "USD" },
		});
	});

	it.each([false, undefined, "allow_once", { optionId: "unknown" }])(
		"never treats an unknown permission response (%s) as approval",
		async (choice) => {
			const execute = vi.fn(async () => ({ text: "must not run" }));
			const permission = vi.fn(async () => choice as boolean);
			const f = open(
				{ tools: [tool({ execute })] },
				{ client: { requestPermission: permission } },
			);
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "a" })),
				fauxAssistantMessage("denied"),
			]);
			await expect(f.session.prompt(prompt())).resolves.toBe("completed");
			expect(execute).not.toHaveBeenCalled();
			expect(
				checkpoint(f.session).messages.find(
					(entry) => entry.role === "toolResult",
				),
			).toMatchObject({
				isError: true,
				content: [{ type: "text", text: "Tool permission denied" }],
			});
		},
	);

	it.each(["missing", "throws"])(
		"fails closed when the permission service is %s",
		async (mode) => {
			const execute = vi.fn(async () => ({ text: "must not run" }));
			const f = open(
				{ tools: [tool({ execute })] },
				mode === "missing"
					? {}
					: {
							client: {
								requestPermission: async () => {
									throw new Error("private credentials");
								},
							},
						},
			);
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "a" })),
				fauxAssistantMessage("blocked"),
			]);
			await f.session.prompt(prompt());
			expect(execute).not.toHaveBeenCalled();
			expect(JSON.stringify(checkpoint(f.session))).toContain(
				mode === "missing"
					? "requires a client permission"
					: "permission request failed",
			);
			expect(JSON.stringify(checkpoint(f.session))).not.toContain(
				"private credentials",
			);
		},
	);

	it("validates original arguments with each tool's refinements before asking", async () => {
		const execute = vi.fn(async () => ({ text: "no" }));
		const permission = vi.fn(async () => true);
		const f = open(
			{
				tools: [
					tool({
						schema: z.object({
							count: z.number().refine((value) => value === 1),
						}),
						execute,
					}),
				],
			},
			{ client: { requestPermission: permission } },
		);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { count: "1" })),
			fauxAssistantMessage(fauxToolCall("write", { count: 0 })),
			fauxAssistantMessage("invalid"),
		]);
		await f.session.prompt(prompt());
		expect(execute).not.toHaveBeenCalled();
		expect(permission).not.toHaveBeenCalled();
	});

	it("executes Zod transforms once and bypasses permission only for explicit none", async () => {
		const transform = vi.fn((value: string) => `${value}!`);
		const execute = vi.fn(async () => ({ text: "ok", isError: true }));
		const f = open({
			tools: [
				tool({
					permission: "none",
					schema: z.object({ text: z.string().transform(transform) }),
					execute,
				}),
			],
		});
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { text: "value" })),
			fauxAssistantMessage("handled error"),
		]);
		const events: RuntimeActivity[] = [];
		await f.session.prompt(
			prompt({
				activity: async (event) => {
					events.push(event);
				},
			}),
		);
		expect(transform).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledWith({ text: "value!" }, expect.anything());
		expect(events.findLast((event) => event.kind === "tool")).toMatchObject({
			status: "failed",
		});
		expect(
			checkpoint(f.session).messages.find(
				(entry) => entry.role === "toolResult",
			),
		).toMatchObject({ isError: true });
	});

	it.each([undefined, 1])(
		"bounds unknown tools with maxTurns %s",
		async (maxTurns) => {
			const defaultLimit = 20;
			const limit = maxTurns ?? defaultLimit;
			const execute = vi.fn(async () => ({ text: "unused" }));
			const f = open({ tools: [tool({ execute })], maxTurns });
			f.faux.setResponses(
				Array.from({ length: limit + 1 }, () =>
					fauxAssistantMessage(fauxToolCall("unknown", {})),
				),
			);
			await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
			expect(f.faux.state.callCount).toBe(limit);
			expect(f.faux.getPendingResponseCount()).toBe(1);
			expect(execute).not.toHaveBeenCalled();
			expect(
				checkpoint(f.session).messages.filter(
					(entry) => entry.role === "toolResult",
				),
			).toHaveLength(limit);
		},
	);

	it("does not execute truncated tool arguments or issue another request", async () => {
		const execute = vi.fn(async () => ({ text: "unused" }));
		const f = open({ tools: [tool({ permission: "none", execute })] });
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a" }), {
				stopReason: "length",
			}),
			fauxAssistantMessage("unused"),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("token_limit");
		expect(execute).not.toHaveBeenCalled();
		expect(f.faux.state.callCount).toBe(1);
		expect(checkpoint(f.session).messages.at(-1)).toMatchObject({
			role: "toolResult",
			isError: true,
		});
	});

	it("gives reused raw tool IDs distinct presentation IDs across turns and sessions", async () => {
		const f = open({ tools: [tool({ permission: "none" })], maxTurns: 1 });
		const other = f.createSession();
		const requests = [f.session, f.session, other];
		f.faux.setResponses(
			requests.map(() =>
				fauxAssistantMessage(
					fauxToolCall("write", { path: "a" }, { id: "reused" }),
				),
			),
		);
		const ids: string[] = [];
		const activity: NonNullable<RuntimePrompt["activity"]> = async (event) => {
			if (event.kind === "tool" && event.status === "pending") {
				ids.push(event.toolCallId);
			}
		};
		await f.session.prompt(prompt({ activity }));
		await Promise.all(
			[f.session, other].map((session) => session.prompt(prompt({ activity }))),
		);
		expect(new Set(ids).size).toBe(requests.length);
	});

	it("exposes only injected model identities and supported thought levels", async () => {
		const f = open();
		expect(
			f.session.getConfig?.()[1].options.map((entry) => entry.value),
		).toEqual(getSupportedThinkingLevels(f.faux.models[0]));
		await f.session.setConfig?.("thought_level", "medium");
		const previous = f.session.getConfig?.();
		await expect(
			f.session.setConfig?.("model", plainKey(f.session)),
		).rejects.toThrow("Unsupported thought");
		await expect(f.session.setConfig?.("model", "unknown")).rejects.toThrow(
			"Unknown model",
		);
		await expect(
			f.session.setConfig?.("thought_level", "unknown"),
		).rejects.toThrow("Unsupported thought");
		await expect(f.session.setConfig?.("mode", "anything")).rejects.toThrow(
			"Unknown runtime configuration",
		);
		expect(f.session.getConfig?.()).toEqual(previous);
		await f.session.setConfig?.("thought_level", "off");
		await f.session.setConfig?.("model", plainKey(f.session));
		expect(f.session.getConfig?.()[1].options).toEqual([
			{ value: "off", name: "off" },
		]);
		f.faux.setResponses([
			(...[_context, settings, _state, model]) => {
				expect(model.id).toBe("plain");
				expect(settings?.reasoning).toBeUndefined();
				return fauxAssistantMessage("configured");
			},
		]);
		await f.session.prompt(prompt());
	});

	it("rejects snapshot, restore and configuration changes while output is unsettled", async () => {
		const f = open();
		const saved = checkpoint(f.session);
		const held = gate<void>();
		const emit = vi.fn(async () => held.promise);
		f.faux.setResponses([fauxAssistantMessage("held")]);
		const running = f.session.prompt(prompt({ emit }));
		try {
			await vi.waitFor(() => expect(emit).toHaveBeenCalled());
			expect(() => f.session.snapshot?.()).toThrow("already running");
			expect(() => f.session.restore?.(saved)).toThrow("already running");
			await expect(
				f.session.setConfig?.("thought_level", "low"),
			).rejects.toThrow("already running");
		} finally {
			held.release();
		}
		await running;
	});

	it("round trips signatures, selections, and history without provider credentials or IO", async () => {
		const f = open();
		f.faux.models[0].headers = { Authorization: "secret-token" };
		await f.session.setConfig?.("thought_level", "low");
		f.faux.setResponses([
			fauxAssistantMessage([
				{ ...fauxThinking("reason"), thinkingSignature: "opaque-signature" },
				{ ...fauxText("answer"), textSignature: "text-signature" },
			]),
		]);
		await f.session.prompt(prompt());
		const saved = parseCheckpoint(wireRoundTrip(f.session.snapshot?.()));
		expect(JSON.stringify(saved)).not.toMatch(
			/secret-token|Authorization|injected system|baseUrl/,
		);
		const other = f.createSession();
		other.restore?.(saved);
		expect(other.getConfig?.()).toEqual(f.session.getConfig?.());
		expect(checkpoint(other)).toEqual(checkpoint(f.session));
		expect(f.faux.state.callCount).toBe(1);
		saved.messages.length = 0;
		f.faux.setResponses([
			(context, settings) => {
				expect(context.messages.map((entry) => entry.role)).toEqual([
					"user",
					"assistant",
					"user",
				]);
				expect(JSON.stringify(context)).toContain("opaque-signature");
				expect(settings?.reasoning).toBe("low");
				return fauxAssistantMessage("resumed");
			},
		]);
		await other.prompt(prompt());
		const initialTurnMessages = 2;
		expect(checkpoint(f.session).messages).toHaveLength(initialTurnMessages);
	});

	it.each([
		{ version: 0 },
		{ messages: [{ role: "custom" }] },
		{
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: 1, mimeType: "image/png" }],
					timestamp: 0,
				},
			],
		},
		{ model: { provider: "unknown", id: "unknown" } },
		{ thinkingLevel: "unknown" },
		{ apiKey: "secret" },
	])("rejects malformed checkpoints atomically: %s", (patch) => {
		const f = open();
		const saved = checkpoint(f.session);
		expect(() => f.session.restore?.({ ...saved, ...patch })).toThrow();
		expect(checkpoint(f.session)).toEqual(saved);
	});

	it("rejects cyclic, accessor, unfinished and malformed Pi transcripts", () => {
		const f = open();
		const saved = checkpoint(f.session);
		const cycle: unknown[] = [];
		cycle.push(cycle);
		const getter = vi.fn(() => 1);
		expect(() => f.session.restore?.({ ...saved, messages: cycle })).toThrow(
			"acyclic",
		);
		expect(() =>
			f.session.restore?.(
				Object.defineProperty({}, "version", { get: getter }),
			),
		).toThrow("accessors");
		expect(getter).not.toHaveBeenCalled();
		const assistant = fauxAssistantMessage(
			fauxToolCall("write", { path: "a" }),
		);
		expect(() =>
			f.session.restore?.({ ...saved, messages: [assistant] }),
		).toThrow("Unfinished");
		expect(() =>
			f.session.restore?.({
				...saved,
				messages: [
					{ ...assistant, usage: { ...assistant.usage, input: Number.NaN } },
				],
			}),
		).toThrow();
		expect(() =>
			f.session.restore?.({
				...saved,
				messages: [
					{ ...assistant, content: [{ type: "thinking", thinking: 1 }] },
				],
			}),
		).toThrow();
	});

	it("forwards inline images only to capable models and preserves them in checkpoints", async () => {
		const f = open();
		const image = {
			type: "image" as const,
			data: "aW1hZ2U=",
			mimeType: "image/png",
		};
		f.faux.setResponses([
			(context) => {
				expect(context.messages[0].content).toEqual([image]);
				return fauxAssistantMessage("image");
			},
		]);
		await f.session.prompt(prompt({ content: [image] }));
		const saved = checkpoint(f.session);
		const other = f.createSession();
		other.restore?.(saved);
		expect(checkpoint(other)).toEqual(saved);
		await expect(other.setConfig?.("model", plainKey(other))).rejects.toThrow(
			"does not support images",
		);
		const plain = f.createSession();
		await plain.setConfig?.("model", plainKey(plain));
		await expect(plain.prompt(prompt({ content: [image] }))).rejects.toThrow(
			"does not support images",
		);
		expect(() =>
			plain.restore?.({
				...saved,
				model: { provider: f.faux.models[1].provider, id: "plain" },
			}),
		).toThrow("does not support images");
		expect(f.faux.state.callCount).toBe(1);
	});

	it.each(["error", "aborted"] as const)(
		"keeps completed tool evidence when the next provider turn is %s and never replays on restore",
		async (stopReason) => {
			const execute = vi.fn(async () => ({
				text: "irreversible effect completed",
			}));
			const f = open({ tools: [tool({ permission: "none", execute })] });
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "a" })),
				fauxAssistantMessage("", {
					stopReason,
					errorMessage: "private backend detail",
				}),
			]);
			const running = f.session.prompt(prompt());
			await (stopReason === "error"
				? expect(running).rejects.toThrow("Model request failed")
				: expect(running).resolves.toBe("cancelled"));
			const saved = checkpoint(f.session);
			expect(JSON.stringify(saved)).toContain("irreversible effect completed");
			expect(JSON.stringify(saved)).not.toContain("private backend detail");
			const other = f.createSession();
			other.restore?.(wireRoundTrip(saved));
			expect(execute).toHaveBeenCalledOnce();
			f.faux.setResponses([
				(context) => {
					expect(JSON.stringify(context)).toContain(
						"irreversible effect completed",
					);
					return fauxAssistantMessage("resumed without replay");
				},
			]);
			await other.prompt(prompt());
			expect(execute).toHaveBeenCalledOnce();
		},
	);

	it.each(["execute", "completed"] as const)(
		"retains a committed effect and diff when cancellation happens during %s",
		async (cancelAt) => {
			const controller = new AbortController();
			const result: RuntimeToolResult = {
				text: "committed effect",
				content: [
					{
						type: "diff",
						path: resolve(CWD, "edited"),
						oldText: "before",
						newText: "after",
					},
				],
				locations: [{ path: resolve(CWD, "edited"), line: 1 }],
			};
			const execute = vi.fn(async () => {
				if (cancelAt === "execute") {
					controller.abort();
				}
				return result;
			});
			const f = open({ tools: [tool({ permission: "none", execute })] });
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "edited" })),
			]);
			const events: RuntimeActivity[] = [];
			await expect(
				f.session.prompt(
					prompt({
						signal: controller.signal,
						activity: async (event) => {
							events.push(event);
							if (
								cancelAt === "completed" &&
								event.kind === "tool" &&
								event.status === "completed"
							) {
								controller.abort();
							}
						},
					}),
				),
			).resolves.toBe("cancelled");
			expect(f.faux.state.callCount).toBe(1);
			const saved = checkpoint(f.session);
			expect(
				saved.messages.find((entry) => entry.role === "toolResult"),
			).toMatchObject({ isError: false, details: result });
			expect(events.findLast((event) => event.kind === "tool")).toMatchObject({
				status: "completed",
				content: result.content,
				locations: result.locations,
			});
			const resumed = f.createSession();
			resumed.restore?.(wireRoundTrip(saved));
			f.faux.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages)).toContain(
						"committed effect",
					);
					return fauxAssistantMessage("resumed");
				},
			]);
			await expect(resumed.prompt(prompt())).resolves.toBe("completed");
			expect(execute).toHaveBeenCalledOnce();
		},
	);

	it("redacts auth and private-path failure diagnostics without discarding earlier effects", async () => {
		const privateDiagnostic =
			"credentials /private/d3r/credentials.json fake-auth-secret";
		const execute = vi.fn(async () => ({ text: "effect completed" }));
		const f = open({ tools: [tool({ permission: "none", execute })] });
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a" })),
			() => {
				throw new Error(privateDiagnostic);
			},
		]);
		const events: RuntimeActivity[] = [];
		await expect(
			f.session.prompt(
				prompt({
					activity: async (event) => {
						events.push(event);
					},
				}),
			),
		).rejects.toThrow("Model request failed");
		expect(JSON.stringify(checkpoint(f.session))).not.toContain(
			privateDiagnostic,
		);
		expect(JSON.stringify(events)).not.toContain(privateDiagnostic);
		f.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain(
					privateDiagnostic,
				);
				return fauxAssistantMessage("recovered");
			},
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		expect(execute).toHaveBeenCalledOnce();
	});

	it("redacts unexpected originating-schema errors from tool activity and checkpoints", async () => {
		const privateDiagnostic =
			"auth failure /private/d3r/credentials.json fake-auth-secret";
		const permission = vi.fn(async () => true);
		const execute = vi.fn(async () => ({ text: "must not execute" }));
		const schema = z.record(z.unknown()).superRefine(() => {
			throw new Error(privateDiagnostic);
		});
		const f = open(
			{ tools: [tool({ schema, execute })] },
			{ client: { requestPermission: permission } },
		);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", {})),
			fauxAssistantMessage("blocked"),
		]);
		const events: RuntimeActivity[] = [];
		await f.session.prompt(
			prompt({
				activity: async (event) => {
					events.push(event);
				},
			}),
		);
		expect(permission).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(JSON.stringify(events)).not.toContain(privateDiagnostic);
		expect(JSON.stringify(checkpoint(f.session))).not.toContain(
			privateDiagnostic,
		);
	});

	it("waits for every started parallel tool after cancellation and restores closed results", async () => {
		const held = [gate<void>(), gate<void>()];
		const signals: AbortSignal[] = [];
		const finished: number[] = [];
		const execute = vi.fn(
			async (
				_args: unknown,
				context: Parameters<RuntimeTool["execute"]>[1],
			) => {
				const index = signals.length;
				signals.push(context.signal);
				await held[index].promise;
				finished.push(index);
				context.signal.throwIfAborted();
				return { text: "unused" };
			},
		);
		const f = open({ tools: [tool({ permission: "none", execute })] });
		f.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write", { path: "a" }),
				fauxToolCall("write", { path: "b" }),
			]),
		]);
		const controller = new AbortController();
		let settled = false;
		const running = f.session
			.prompt(prompt({ signal: controller.signal }))
			.finally(() => {
				settled = true;
			});
		const count = held.length;
		try {
			await vi.waitFor(() => expect(signals).toHaveLength(count));
			controller.abort();
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			held[0].release();
			await vi.waitFor(() => expect(finished).toHaveLength(1));
			expect(settled).toBe(false);
			await expect(f.session.dispose()).rejects.toThrow("active runtime");
			expect(() => f.session.snapshot?.()).toThrow("already running");
		} finally {
			held.forEach((entry) => entry.release());
		}
		await expect(running).resolves.toBe("cancelled");
		const saved = checkpoint(f.session);
		expect(
			saved.messages.filter((entry) => entry.role === "toolResult"),
		).toHaveLength(count);
		expect(JSON.stringify(saved)).toContain("effects may have occurred");
		const other = f.createSession();
		other.restore?.(saved);
		f.faux.setResponses([fauxAssistantMessage("resumed")]);
		await other.prompt(prompt());
		expect(execute).toHaveBeenCalledTimes(count);
	});

	it("awaits cancellation of a pending approval and never starts its effect", async () => {
		const held = gate<boolean>();
		const signals: AbortSignal[] = [];
		const execute = vi.fn(async () => ({ text: "must not run" }));
		const f = open(
			{ tools: [tool({ execute })] },
			{
				client: {
					requestPermission: async (_request, signal) => {
						signals.push(signal);
						return held.promise;
					},
				},
			},
		);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a" })),
		]);
		const controller = new AbortController();
		const running = f.session.prompt(prompt({ signal: controller.signal }));
		try {
			await vi.waitFor(() => expect(signals).toHaveLength(1));
			controller.abort();
			expect(signals[0].aborted).toBe(true);
			await expect(f.session.dispose()).rejects.toThrow("active runtime");
		} finally {
			held.release(true);
		}
		await expect(running).resolves.toBe("cancelled");
		expect(execute).not.toHaveBeenCalled();
		expect(checkpoint(f.session).messages).toEqual([]);
	});

	it("preserves tool evidence when activity delivery fails after execution", async () => {
		const execute = vi.fn(async () => ({ text: "effect completed" }));
		const f = open({ tools: [tool({ permission: "none", execute })] });
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a" })),
		]);
		await expect(
			f.session.prompt(
				prompt({
					activity: async (event) => {
						if (event.kind === "tool" && event.status === "completed") {
							throw new Error("output unavailable");
						}
					},
				}),
			),
		).rejects.toThrow("Runtime output delivery failed");
		expect(execute).toHaveBeenCalledOnce();
		expect(JSON.stringify(checkpoint(f.session))).toContain("effect completed");
	});

	it("aborts and awaits sibling tools when completion delivery fails", async () => {
		const fast = gate<void>();
		const cleanup = gate<void>();
		const signals: AbortSignal[] = [];
		const execute: RuntimeTool["execute"] = async (_args, { signal }) => {
			const index = signals.length;
			signals.push(signal);
			if (index === 0) {
				await fast.promise;
				return { text: "first effect completed" };
			}
			await new Promise<void>((resolveAbort) => {
				if (signal.aborted) {
					resolveAbort();
				} else {
					signal.addEventListener("abort", () => resolveAbort(), {
						once: true,
					});
				}
			});
			await cleanup.promise;
			signal.throwIfAborted();
			return { text: "unused" };
		};
		const f = open({ tools: [tool({ permission: "none", execute })] });
		f.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write", { path: "a" }),
				fauxToolCall("write", { path: "b" }),
			]),
		]);
		let settled = false;
		const running = f.session.prompt(
			prompt({
				activity: async (event) => {
					if (event.kind === "tool" && event.status === "completed") {
						throw new Error("delivery failed");
					}
				},
			}),
		);
		const observed = running.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			const toolCount = 2;
			await vi.waitFor(() => expect(signals).toHaveLength(toolCount));
			fast.release();
			await vi.waitFor(() => expect(signals[1].aborted).toBe(true));
			expect(settled).toBe(false);
			await expect(f.session.dispose()).rejects.toThrow("active runtime");
		} finally {
			fast.release();
			cleanup.release();
			await observed;
		}
		await expect(running).rejects.toThrow("Runtime output delivery failed");
		expect(JSON.stringify(checkpoint(f.session))).toContain(
			"first effect completed",
		);
		expect(JSON.stringify(checkpoint(f.session))).toContain(
			"effects may have occurred",
		);
	});

	it("awaits usage delivery before settling a turn", async () => {
		const f = open();
		const held = gate<void>();
		const activity = vi.fn(async () => held.promise);
		f.faux.setResponses([fauxAssistantMessage("done")]);
		const running = f.session.prompt(prompt({ activity }));
		try {
			await vi.waitFor(() => expect(activity).toHaveBeenCalled());
			expect(() => f.session.snapshot?.()).toThrow("already running");
		} finally {
			held.release();
		}
		await expect(running).resolves.toBe("completed");
	});

	it.each([0, -1, FRACTIONAL_LIMIT, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid request bounds %s",
		(maxTurns) => {
			expect(() => open({ maxTurns })).toThrow("maxTurns");
		},
	);
});
