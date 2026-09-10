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
	type RuntimeActivity,
	type RuntimeClientServices,
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeSessionInput,
	type RuntimeTool,
} from "@d3r/core/runtime";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseCheckpoint } from "./embedded-checkpoint.ts";

/** Expected public defaults are independent of implementation constants. */
const INITIAL_LIMIT = 50;

/** The default hard ceiling must not include hidden synthesis grace. */
const HARD_LIMIT = 100;

/** Warning awareness includes the currently generating response. */
const WARNING_REQUESTS = 5;

/** Fractional budgets must not silently round to a usable request count. */
const FRACTIONAL_LIMIT = 1.5;

/** Legacy callers may explicitly select an initial allowance above the default hard cap. */
const LEGACY_LARGE_LIMIT = 101;

/** Persistence crosses JSON rather than carrying live invocation state. */
const wireRoundTrip = (value: unknown): unknown => {
	const serialized = JSON.stringify(value);
	return JSON.parse(serialized);
};

/** A concrete injected tool keeps tests on the production tool-enabled Pi loop. */
const workTool = (
	execute = vi.fn(async () => ({ text: "work saved" })),
): RuntimeTool => ({
	name: "save_work",
	description: "Save work before reporting results",
	kind: "edit",
	permission: "none",
	schema: z.object({}),
	execute,
});

/** Every invocation receives a fresh cancellation signal unless a test supplies one. */
const prompt = (overrides: Partial<RuntimePrompt> = {}): RuntimePrompt => ({
	content: [{ type: "text", text: "Complete the task and report results" }],
	signal: new AbortController().signal,
	emit: async () => {},
	...overrides,
});

/** Permission settlement can be controlled independently of cancellation. */
const gate = <T>() => {
	let release: (value: T) => void = vi.fn();
	const promise = new Promise<T>((resolvePromise) => {
		release = resolvePromise;
	});
	return { promise, release };
};

/** An unknown tool keeps Pi looping without introducing unrelated privileged effects. */
const working = () => fauxAssistantMessage(fauxToolCall("unknown", {}));

/** Calls go through Pi's real schema validation, preflight, and parallel executor. */
const extension = (
	args: unknown = { reason: "Finish verification and report" },
) =>
	fauxAssistantMessage(
		fauxToolCall("d3r_request_extension", args as Record<string, unknown>),
	);

/** Copy only provider-visible data, not the executable tool callbacks Pi also carries. */
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

/** Script the provider IO only; the Agent, tool bridge, and budget are production code. */
describe("embedded invocation request budgets", () => {
	const sessions: RuntimeSession[] = [];
	const open = (
		options: Partial<EmbeddedRuntimeOptions> = {},
		client?: RuntimeClientServices,
	) => {
		const faux = fauxProvider({ models: [{ id: "budget-model" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const contexts: Context[] = [];
		const factory = createEmbeddedRuntime({
			models: {
				streamSimple: (model, context, settings) => {
					contexts.push(captureContext(context));
					return models.streamSimple(model, context, settings);
				},
			},
			model: faux.getModel(),
			systemPrompt: "Original role instructions",
			tools: [workTool()],
			...options,
		});
		const createSession = (input: Partial<RuntimeSessionInput> = {}) => {
			const session = factory({
				sessionId: "shared-external-id",
				cwd: resolve("budget-workspace"),
				client,
				...input,
			});
			sessions.push(session);
			return session;
		};
		return { faux, contexts, createSession, session: createSession() };
	};

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((session) => session.dispose()));
	});

	it("makes all 50 default requests visible before inference, warning with five left and preserving user history", async () => {
		const f = open();
		f.faux.setResponses(Array.from({ length: INITIAL_LIMIT + 1 }, working));
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		expect(f.faux.state.callCount).toBe(INITIAL_LIMIT);
		expect(f.faux.getPendingResponseCount()).toBe(1);
		f.contexts.forEach((context, index) => {
			expect(context.systemPrompt).toContain("Original role instructions");
			expect(context.systemPrompt).toContain(`Response ${index + 1} of 50`);
			expect(context.systemPrompt).toContain(
				`Remaining model requests: ${INITIAL_LIMIT - index}, including this response and any final synthesis`,
			);
			expect(context.systemPrompt).toContain("Hard cap: 100");
			expect(context.systemPrompt).toContain("d3r_request_extension");
			expect(context.systemPrompt?.includes("WARNING")).toBe(
				index >= INITIAL_LIMIT - WARNING_REQUESTS,
			);
			expect(
				context.messages.filter((message) => message.role === "user"),
			).toHaveLength(1);
			expect(JSON.stringify(context.messages)).not.toContain(
				"D3R request budget",
			);
		});
		expect(f.contexts.at(-1)?.systemPrompt).toContain(
			"Save work and report/finalize now",
		);
		expect(f.contexts.at(-1)?.systemPrompt).toContain(
			"no extra final-response allowance",
		);
		expect(JSON.stringify(f.session.snapshot?.())).not.toContain(
			"D3R request budget",
		);
	});

	it("awaits a labeled one-time grant on response 50 before request 51, then saves and synthesizes within the extended limit", async () => {
		const held = gate<boolean>();
		const permission = vi.fn(async () => held.promise);
		const additionalRequests = 2;
		const extendedLimit = INITIAL_LIMIT + additionalRequests;
		const execute = vi.fn(async () => ({ text: "work saved" }));
		const f = open(
			{ tools: [workTool(execute)], budgetLabel: "reviewer" },
			{ requestPermission: permission },
		);
		f.faux.setResponses([
			...Array.from({ length: 49 }, working),
			extension({
				reason: "  Save findings and write final report  ",
				additionalRequests: 2,
			}),
			fauxAssistantMessage(fauxToolCall("save_work", {})),
			fauxAssistantMessage("Saved findings; final report"),
			working(),
		]);
		const events: RuntimeActivity[] = [];
		const running = f.session.prompt(
			prompt({
				activity: async (event) => {
					events.push(event);
				},
			}),
		);
		try {
			await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
			expect(f.faux.state.callCount).toBe(INITIAL_LIMIT);
			expect(f.contexts).toHaveLength(INITIAL_LIMIT);
			expect(execute).not.toHaveBeenCalled();
			expect(
				events.some(
					(event) =>
						event.kind === "tool" &&
						event.title === "d3r_request_extension" &&
						event.status === "completed",
				),
			).toBe(false);
			expect(permission).toHaveBeenCalledWith(
				{
					toolCallId: expect.any(String),
					title: "Extend request budget (reviewer): 50 -> 52 (hard cap 100)",
					kind: "other",
					input: {
						reason: "Save findings and write final report",
						additionalRequests: 2,
						currentLimit: 50,
						requestedLimit: 52,
						maxTotalTurns: 100,
					},
				},
				expect.any(AbortSignal),
			);
		} finally {
			held.release(true);
		}
		await expect(running).resolves.toBe("completed");
		expect(execute).toHaveBeenCalledOnce();
		expect(f.faux.state.callCount).toBe(extendedLimit);
		expect(f.faux.getPendingResponseCount()).toBe(1);
		expect(f.contexts[INITIAL_LIMIT].systemPrompt).toContain(
			"Response 51 of 52",
		);
		expect(f.contexts.at(-1)?.systemPrompt).toContain(
			"Remaining model requests: 1",
		);
		expect(JSON.stringify(f.contexts[INITIAL_LIMIT].messages)).toContain(
			"Request extension approved",
		);
		const schemas = f.contexts[0].tools;
		expect(schemas?.map((tool) => tool.name)).toEqual([
			"save_work",
			"d3r_request_extension",
		]);
		schemas?.forEach((tool) =>
			expect(tool.parameters).toMatchObject({ type: "object" }),
		);
		expect(schemas?.[1].parameters).toMatchObject({
			type: "object",
			properties: {
				reason: { type: "string", minLength: 1 },
				additionalRequests: {
					type: "integer",
					exclusiveMinimum: 0,
					maximum: 50,
				},
			},
			required: ["reason"],
		});
	});

	it("defaults extension size to the available headroom and never adds implicit grace beyond hard 100", async () => {
		const permission = vi.fn(async () => true);
		const f = open({}, { requestPermission: permission });
		f.faux.setResponses([
			...Array.from({ length: 49 }, working),
			extension(),
			...Array.from({ length: 49 }, working),
			extension(),
			fauxAssistantMessage("unbudgeted synthesis must not run"),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		expect(permission).toHaveBeenCalledOnce();
		expect(permission).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					additionalRequests: 50,
					requestedLimit: 100,
				}),
			}),
			expect.any(AbortSignal),
		);
		expect(f.faux.state.callCount).toBe(HARD_LIMIT);
		expect(f.faux.getPendingResponseCount()).toBe(1);
		expect(f.contexts.at(-1)?.systemPrompt).toContain("Response 100 of 100");
		expect(f.contexts.at(-1)?.systemPrompt).toContain(
			"No extension is available",
		);
		expect(JSON.stringify(f.session.snapshot?.())).toContain(
			"exceeds available hard-cap headroom",
		);
	});

	it("does not issue request 51 after a last-response denial", async () => {
		const permission = vi.fn(async () => false);
		const f = open({}, { requestPermission: permission });
		f.faux.setResponses([
			...Array.from({ length: INITIAL_LIMIT - 1 }, working),
			extension(),
			fauxAssistantMessage("unapproved extra response"),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		expect(permission).toHaveBeenCalledOnce();
		expect(f.faux.state.callCount).toBe(INITIAL_LIMIT);
		expect(f.faux.getPendingResponseCount()).toBe(1);
	});

	it("allows a later independent approval without exceeding the configured hard cap", async () => {
		const permission = vi.fn(async () => true);
		const f = open(
			{ maxTurns: 1, maxTotalTurns: 3 },
			{ requestPermission: permission },
		);
		f.faux.setResponses([
			extension({
				reason: "Run one final verification",
				additionalRequests: 1,
			}),
			extension({
				reason: "Summarize the verification result",
				additionalRequests: 1,
			}),
			fauxAssistantMessage("final report"),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		const approvalCount = 2;
		expect(permission).toHaveBeenCalledTimes(approvalCount);
		expect(f.contexts[1].systemPrompt).toContain("Response 2 of 2");
		expect(f.contexts.at(-1)?.systemPrompt).toContain("Response 3 of 3");
	});

	it("defaults a smaller extension to the remaining headroom", async () => {
		const permission = vi.fn(async () => true);
		const f = open(
			{ maxTurns: 1, maxTotalTurns: 4 },
			{ requestPermission: permission },
		);
		f.faux.setResponses([extension(), fauxAssistantMessage("report")]);
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		expect(permission).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({ additionalRequests: 3 }),
			}),
			expect.any(AbortSignal),
		);
		expect(f.contexts[1].systemPrompt).toContain("Response 2 of 4");
	});

	it.each([false, undefined, "true", { optionId: "allow_once" }])(
		"does not treat %j as approval or repeatedly prompt after denial",
		async (approval) => {
			const permission = vi.fn(async () => approval as boolean);
			const maxTurns = 4;
			const f = open({ maxTurns }, { requestPermission: permission });
			f.faux.setResponses([
				extension(),
				extension(),
				extension(),
				extension(),
				working(),
			]);
			await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
			expect(permission).toHaveBeenCalledOnce();
			expect(f.faux.state.callCount).toBe(maxTurns);
			expect(f.contexts[1].systemPrompt).toContain("Response 2 of 4");
			expect(f.contexts[1].systemPrompt).toContain("No extension is available");
			expect(JSON.stringify(f.session.snapshot?.())).toContain(
				"already denied",
			);
		},
	);

	it.each(["missing", "failed"])(
		"fails closed without repeating a %s approval service or leaking diagnostics",
		async (mode) => {
			const permission = vi.fn(async () => {
				throw new Error("private approval backend details");
			});
			const maxTurns = 2;
			const f = open(
				{ maxTurns },
				mode === "missing" ? undefined : { requestPermission: permission },
			);
			f.faux.setResponses([extension(), extension(), working()]);
			await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
			expect(permission).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
			expect(f.faux.state.callCount).toBe(maxTurns);
			expect(JSON.stringify(f.session.snapshot?.())).not.toContain(
				"private approval backend details",
			);
		},
	);

	it.each([
		{},
		{ reason: "" },
		{ reason: "   " },
		{ reason: 12 },
		{ reason: "need more", additionalRequests: "2" },
		{ reason: "need more", additionalRequests: null },
		{ reason: "need more", additionalRequests: 0 },
		{ reason: "need more", additionalRequests: -1 },
		{ reason: "need more", additionalRequests: 1.5 },
		{ reason: "need more", additionalRequests: 51 },
	])("does not prompt for invalid original arguments %j", async (args) => {
		const permission = vi.fn(async () => true);
		const f = open({ maxTurns: 1 }, { requestPermission: permission });
		f.faux.setResponses([extension(args), working()]);
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		expect(permission).not.toHaveBeenCalled();
		expect(f.faux.state.callCount).toBe(1);
		expect(
			parseCheckpoint(f.session.snapshot?.()).messages.at(-1),
		).toMatchObject({ role: "toolResult", isError: true });
	});

	it.each([
		{ hard: 1, args: { reason: "need more" } },
		{ hard: 2, args: { reason: "need more", additionalRequests: 2 } },
	])(
		"does not prompt when the request exceeds headroom: %j",
		async ({ hard, args }) => {
			const permission = vi.fn(async () => true);
			const f = open(
				{ maxTurns: 1, maxTotalTurns: hard },
				{ requestPermission: permission },
			);
			f.faux.setResponses([extension(args), working()]);
			await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
			expect(permission).not.toHaveBeenCalled();
			expect(f.faux.state.callCount).toBe(1);
		},
	);

	it.each(["immediate", "pending"])(
		"suppresses duplicate same-response extensions with %s approval",
		async (mode) => {
			const held = gate<boolean>();
			const permission = vi.fn(async () =>
				mode === "pending" ? held.promise : true,
			);
			const f = open(
				{ maxTurns: 1, maxTotalTurns: 10 },
				{ requestPermission: permission },
			);
			f.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall(
						"d3r_request_extension",
						{ reason: "first", additionalRequests: 2 },
						{ id: "first" },
					),
					fauxToolCall(
						"d3r_request_extension",
						{ reason: "duplicate", additionalRequests: 2 },
						{ id: "duplicate" },
					),
				]),
				fauxAssistantMessage("final report"),
			]);
			const running = f.session.prompt(prompt());
			try {
				await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
				if (mode === "pending") {
					expect(f.faux.state.callCount).toBe(1);
				}
			} finally {
				held.release(true);
			}
			await expect(running).resolves.toBe("completed");
			expect(permission).toHaveBeenCalledOnce();
			expect(f.contexts[1].systemPrompt).toContain("Response 2 of 3");
			expect(JSON.stringify(f.session.snapshot?.())).toContain(
				"Duplicate request extension ignored",
			);
		},
	);

	it("blocks ambiguous raw IDs before requesting any approval", async () => {
		const permission = vi.fn(async () => true);
		const f = open({ maxTurns: 1 }, { requestPermission: permission });
		f.faux.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 2 }, () =>
					fauxToolCall(
						"d3r_request_extension",
						{ reason: "duplicate" },
						{ id: "same-id" },
					),
				),
			),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		expect(permission).not.toHaveBeenCalled();
	});

	it("awaits cancelled approval cleanup and ignores a late true grant without reviving the invocation", async () => {
		const held = gate<boolean>();
		const signals: AbortSignal[] = [];
		const permission = vi.fn(async (_request, signal: AbortSignal) => {
			signals.push(signal);
			return held.promise;
		});
		const f = open(
			{ maxTurns: 1, maxTotalTurns: 3 },
			{ requestPermission: permission },
		);
		f.faux.setResponses([extension(), working()]);
		const controller = new AbortController();
		const running = f.session.prompt(prompt({ signal: controller.signal }));
		try {
			await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
			controller.abort();
			expect(signals[0].aborted).toBe(true);
			await expect(f.session.dispose()).rejects.toThrow("active runtime");
			expect(f.faux.state.callCount).toBe(1);
		} finally {
			held.release(true);
		}
		await expect(running).resolves.toBe("cancelled");
		expect(f.faux.state.callCount).toBe(1);
		expect(JSON.stringify(f.session.snapshot?.())).not.toContain(
			"Request extension approved",
		);
		f.faux.setResponses([working(), working()]);
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		expect(f.contexts.at(-1)?.systemPrompt).toContain("Response 1 of 1");
	});

	it.each(["pending", "in_progress", "completed"] as const)(
		"preserves output-failure handling during extension %s activity",
		async (status) => {
			const permission = vi.fn(async () => true);
			const f = open(
				{ maxTurns: 1, maxTotalTurns: 3 },
				{ requestPermission: permission },
			);
			f.faux.setResponses([extension(), working()]);
			await expect(
				f.session.prompt(
					prompt({
						activity: async (event) => {
							if (event.kind === "tool" && event.status === status) {
								throw new Error("output unavailable");
							}
						},
					}),
				),
			).rejects.toThrow("Runtime output delivery failed");
			expect(permission).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
			expect(f.faux.state.callCount).toBe(1);
			f.faux.setResponses([working(), working()]);
			await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
			expect(f.contexts.at(-1)?.systemPrompt).toContain("Response 1 of 1");
		},
	);

	it("ignores a late approval when sibling output failure aborts Pi rather than the prompt signal", async () => {
		const held = gate<boolean>();
		const signals: AbortSignal[] = [];
		const permission = vi.fn(async (_request, signal: AbortSignal) => {
			signals.push(signal);
			return held.promise;
		});
		const execute = vi.fn(async () => {
			await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
			return { text: "work saved" };
		});
		const f = open(
			{ tools: [workTool(execute)], maxTurns: 1, maxTotalTurns: 3 },
			{ requestPermission: permission },
		);
		f.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("d3r_request_extension", { reason: "Finish report" }),
				fauxToolCall("save_work", {}),
			]),
			working(),
		]);
		const request = prompt({
			activity: async (event) => {
				if (
					event.kind === "tool" &&
					event.title === "save_work" &&
					event.status === "completed"
				) {
					throw new Error("output unavailable");
				}
			},
		});
		const running = f.session.prompt(request);
		const observed = expect(running).rejects.toThrow(
			"Runtime output delivery failed",
		);
		try {
			await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
			expect(request.signal.aborted).toBe(false);
			expect(f.faux.state.callCount).toBe(1);
			await expect(f.session.dispose()).rejects.toThrow("active runtime");
		} finally {
			held.release(true);
		}
		await observed;
		expect(JSON.stringify(f.session.snapshot?.())).not.toContain(
			"Request extension approved",
		);
		expect(f.faux.state.callCount).toBe(1);
	});

	it("does not execute an extension from a truncated tool response", async () => {
		const permission = vi.fn(async () => true);
		const f = open({}, { requestPermission: permission });
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("d3r_request_extension", { reason: "need more" }),
				{ stopReason: "length" },
			),
			working(),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("token_limit");
		expect(permission).not.toHaveBeenCalled();
		expect(f.faux.state.callCount).toBe(1);
	});

	it("isolates sibling, subsequent, and reloaded budgets without persisting synthetic reminders", async () => {
		const held = gate<boolean>();
		const permission = vi.fn(async () => held.promise);
		const f = open(
			{ maxTurns: 1, maxTotalTurns: 3 },
			{ requestPermission: permission },
		);
		const sibling = f.createSession();
		f.faux.setResponses([
			extension(),
			working(),
			fauxAssistantMessage("extended report"),
		]);
		const running = f.session.prompt(prompt());
		try {
			await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
			await expect(sibling.prompt(prompt())).resolves.toBe("request_limit");
			expect(f.contexts[1].systemPrompt).toContain("Response 1 of 1");
		} finally {
			held.release(true);
		}
		await expect(running).resolves.toBe("completed");
		expect(f.contexts.at(-1)?.systemPrompt).toContain("Response 2 of 3");
		const previousRequests = f.contexts.length;
		const saved = wireRoundTrip(f.session.snapshot?.());
		expect(JSON.stringify(saved)).not.toContain("D3R request budget");
		const reloaded = f.createSession();
		reloaded.restore?.(saved);
		f.faux.setResponses([working(), working(), working()]);
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		await expect(reloaded.prompt(prompt())).resolves.toBe("request_limit");
		expect(f.faux.getPendingResponseCount()).toBe(1);
		const userPrompts = 2;
		f.contexts.slice(previousRequests).forEach((context) => {
			expect(context.systemPrompt).toContain("Response 1 of 1");
			expect(context.systemPrompt?.match(/\[D3R request budget/g)).toHaveLength(
				1,
			);
			expect(
				context.messages.filter((message) => message.role === "user"),
			).toHaveLength(userPrompts);
			expect(JSON.stringify(context.messages)).not.toContain(
				"D3R request budget",
			);
		});
	});

	it("clears denial state for the next invocation and allows a new explicit grant", async () => {
		const permission = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const f = open(
			{ maxTurns: 1, maxTotalTurns: 3 },
			{ requestPermission: permission },
		);
		f.faux.setResponses([
			extension(),
			extension(),
			fauxAssistantMessage("report"),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("request_limit");
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		const invocationCount = 2;
		expect(permission).toHaveBeenCalledTimes(invocationCount);
		expect(f.contexts[1].systemPrompt).toContain("Response 1 of 1");
		expect(f.contexts.at(-1)?.systemPrompt).toContain("Response 2 of 3");
	});

	it("keeps the no-tools contract even for hallucinated extension calls", async () => {
		const permission = vi.fn(async () => true);
		const f = open({ tools: [] }, { requestPermission: permission });
		f.faux.setResponses([extension(), working()]);
		await expect(f.session.prompt(prompt())).rejects.toThrow(
			"Embedded tool execution is not supported yet",
		);
		expect(f.contexts[0].tools).toEqual([]);
		expect(f.contexts[0].systemPrompt).not.toContain("d3r_request_extension");
		expect(permission).not.toHaveBeenCalled();
		expect(f.faux.state.callCount).toBe(1);
	});

	it.each(["maxTurns", "maxTotalTurns"] as const)(
		"validates %s as a positive safe integer",
		(key) => {
			[
				0,
				-1,
				FRACTIONAL_LIMIT,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				Number.MAX_SAFE_INTEGER + 1,
			].forEach((value) => {
				expect(() => open({ [key]: value })).toThrow(
					`${key} must be a positive safe integer`,
				);
			});
		},
	);

	it("rejects a hard cap smaller than the initial allowance and reserved-name collisions", () => {
		expect(() => open({ maxTurns: 3, maxTotalTurns: 2 })).toThrow(
			"maxTotalTurns must be at least maxTurns",
		);
		expect(() => open({ maxTotalTurns: 49 })).toThrow(
			"maxTotalTurns must be at least maxTurns",
		);
		expect(() =>
			open({ tools: [{ ...workTool(), name: "d3r_request_extension" }] }),
		).toThrow("reserved");
	});

	it.each([LEGACY_LARGE_LIMIT, Number.MAX_SAFE_INTEGER])(
		"preserves an explicit maxTurns of %s by defaulting the hard cap upward",
		async (maxTurns) => {
			const f = open({ maxTurns });
			f.faux.setResponses([fauxAssistantMessage("report")]);
			await expect(f.session.prompt(prompt())).resolves.toBe("completed");
			expect(f.contexts[0].systemPrompt).toContain(`Response 1 of ${maxTurns}`);
			expect(f.contexts[0].systemPrompt).toContain(`Hard cap: ${maxTurns}`);
		},
	);
});
