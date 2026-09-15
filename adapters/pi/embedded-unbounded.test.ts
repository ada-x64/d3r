import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
	type RuntimeActivity,
	type RuntimeClientServices,
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeSessionInput,
	type RuntimeTool,
} from "@d3r/core/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseCheckpoint } from "./embedded-checkpoint.ts";

/** Cross the legacy hard cap with actual length-stopped provider responses. */
const LENGTH_RESPONSES = 101;

/** Continuation must not need another user request or another cancellation signal. */
const prompt = (overrides: Partial<RuntimePrompt> = {}): RuntimePrompt => ({
	content: [{ type: "text", text: "Finish the implementation and report" }],
	signal: new AbortController().signal,
	emit: async () => {},
	...overrides,
});

/** A salvaged partial string is schema-valid, but still unsafe to execute. */
const writeTool = (overrides: Partial<RuntimeTool> = {}): RuntimeTool => ({
	name: "write",
	description: "Save implementation work",
	kind: "edit",
	permission: "none",
	schema: z.object({ text: z.string() }),
	execute: async () => ({ text: "Work saved" }),
	...overrides,
});

/** Synchronize on provider entry and settlement, never elapsed time. */
const gate = <T>() => {
	let release: (value: T) => void = vi.fn();
	const promise = new Promise<T>((resolvePromise) => {
		release = resolvePromise;
	});
	return { promise, release };
};

/** These adapter journeys retain the real Agent and replace only provider IO. */
describe("unbounded embedded length continuation", () => {
	const sessions: RuntimeSession[] = [];
	const directories: string[] = [];
	const open = (
		options: Partial<EmbeddedRuntimeOptions> = {},
		input: Partial<RuntimeSessionInput> = {},
	) => {
		const faux = fauxProvider({ models: [{ id: "unbounded-model" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const contexts: Context[] = [];
		const providerSessions: (string | undefined)[] = [];
		const factory = createEmbeddedRuntime({
			models: {
				streamSimple: (model, context, settings) => {
					contexts.push({
						systemPrompt: context.systemPrompt,
						messages: structuredClone(context.messages),
						tools: context.tools?.map(({ name, description, parameters }) => ({
							name,
							description,
							parameters: structuredClone(parameters),
						})),
					});
					providerSessions.push(settings?.sessionId);
					return models.streamSimple(model, context, settings);
				},
			},
			model: faux.getModel(),
			systemPrompt: "Complete the assigned implementation",
			maxTurns: null,
			...options,
		});
		const session = factory({
			sessionId: "unbounded-test",
			cwd: resolve("unbounded-workspace"),
			...input,
		});
		sessions.push(session);
		return { faux, session, contexts, providerSessions };
	};
	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((session) => session.dispose()));
		await Promise.all(
			directories
				.splice(0)
				.map((path) => rm(path, { recursive: true, force: true })),
		);
	});

	it("continues over 100 length responses without tools, losing context, or imposing another ceiling", async () => {
		const f = open();
		const parts: string[] = [];
		const events: RuntimeActivity[] = [];
		f.faux.setResponses([
			...Array.from({ length: LENGTH_RESPONSES }, (_, index) =>
				fauxAssistantMessage(`Part ${index + 1}\n`, { stopReason: "length" }),
			),
			fauxAssistantMessage("Implementation complete"),
		]);
		await expect(
			f.session.prompt(
				prompt({
					emit: async ({ text }) => {
						parts.push(text);
					},
					activity: async (event) => {
						events.push(event);
					},
				}),
			),
		).resolves.toBe("completed");
		expect(f.faux.state.callCount).toBe(LENGTH_RESPONSES + 1);
		expect(parts.join("")).toBe(
			[
				...Array.from(
					{ length: LENGTH_RESPONSES },
					(_, index) => `Part ${index + 1}\n`,
				),
				"Implementation complete",
			].join(""),
		);
		expect(events.filter(({ kind }) => kind === "usage")).toHaveLength(
			LENGTH_RESPONSES + 1,
		);
		expect(new Set(f.providerSessions).size).toBe(1);
		expect(f.providerSessions[0]).toBeTruthy();
		f.contexts.forEach((context, index) => {
			expect(context.systemPrompt).toBe("Complete the assigned implementation");
			expect(context.tools).toEqual([]);
			expect(context.messages[0]).toMatchObject({
				role: "user",
				content: [
					{ type: "text", text: "Finish the implementation and report" },
				],
			});
			expect(
				context.messages.filter(({ role }) => role === "assistant"),
			).toHaveLength(index);
		});
		expect(f.contexts.at(-1)?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: [{ type: "text", text: "Part 1\n" }],
				}),
			]),
		);
		expect(
			parseCheckpoint(f.session.snapshot!()).messages.at(-1),
		).toMatchObject({ stopReason: "stop" });
	});

	it("skips the entire truncated batch, saves the next complete call, and continues after a successful report without replay", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "d3r-unbounded-"));
		directories.push(cwd);
		const journal = join(cwd, "work.jsonl");
		const reports: unknown[] = [];
		const permission = vi.fn<RuntimeClientServices["requestPermission"]>(
			async () => true,
		);
		const f = open(
			{
				tools: [
					writeTool({
						permission: "ask",
						execute: async (args) => {
							await appendFile(journal, `${JSON.stringify(args)}\n`);
							return { text: "Work saved" };
						},
					}),
					{
						name: "d3r_report",
						description: "Record the final workflow outcome once",
						kind: "other",
						permission: "none",
						schema: z.object({ summary: z.string() }),
						execute: async (args) => {
							reports.push(args);
							return { text: "Workflow report recorded" };
						},
					},
				],
			},
			{ cwd, client: { requestPermission: permission } },
		);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { text: "settled" })),
			fauxAssistantMessage(
				[
					fauxToolCall("write", { text: "trunc" }, { id: "truncated-write" }),
					fauxToolCall(
						"d3r_report",
						{ summary: "trunc" },
						{ id: "truncated-report" },
					),
				],
				{ stopReason: "length" },
			),
			fauxAssistantMessage(fauxToolCall("write", { text: "complete" })),
			fauxAssistantMessage(
				fauxToolCall("d3r_report", { summary: "Verified implementation" }),
			),
			fauxAssistantMessage("Implementation saved; verification", {
				stopReason: "length",
			}),
			fauxAssistantMessage(" passed."),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		expect(await readFile(journal, "utf8")).toBe(
			'{"text":"settled"}\n{"text":"complete"}\n',
		);
		expect(reports).toEqual([{ summary: "Verified implementation" }]);
		expect(permission.mock.calls.map(([request]) => request.input)).toEqual([
			{ text: "settled" },
			{ text: "complete" },
		]);
		const afterTruncation = f.contexts.find(
			({ messages }) =>
				messages.at(-1)?.role === "user" &&
				messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === "truncated-write",
				),
		);
		expect(afterTruncation?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "truncated-write",
					isError: true,
				}),
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "truncated-report",
					isError: true,
				}),
			]),
		);
		expect(JSON.stringify(afterTruncation?.messages)).toContain("Work saved");
		const guidance = JSON.stringify(f.contexts.at(-1)?.messages.at(-1));
		expect(guidance).toContain("same invocation");
		expect(guidance).toContain(
			"If d3r_report already succeeded in this invocation, do not call it again",
		);
		expect(JSON.stringify(f.contexts.at(-1)?.messages)).toContain(
			"Workflow report recorded",
		);
		const saved = parseCheckpoint(f.session.snapshot!());
		expect(
			saved.messages.filter(
				(message) =>
					message.role === "toolResult" &&
					message.toolName === "d3r_report" &&
					!message.isError,
			),
		).toHaveLength(1);
	});

	it.each([false, true])(
		"cancels an active continuation without losing settled chunks (toolsStarted=%s)",
		async (toolsStarted) => {
			const entered = gate<AbortSignal | undefined>();
			const settled = gate<void>();
			const controller = new AbortController();
			const effects: unknown[] = [];
			const f = open({
				tools: toolsStarted
					? [
							writeTool({
								execute: async (args) => {
									effects.push(args);
									return { text: "Retain this effect" };
								},
							}),
						]
					: [],
			});
			f.faux.setResponses([
				...(toolsStarted
					? [
							fauxAssistantMessage(
								fauxToolCall("write", { text: "saved before cancellation" }),
							),
						]
					: []),
				fauxAssistantMessage("Partial report", { stopReason: "length" }),
				async (_context, settings) => {
					entered.release(settings?.signal);
					await settled.promise;
					return fauxAssistantMessage("Late reply", { stopReason: "length" });
				},
				fauxAssistantMessage("Must not run"),
			]);
			const running = f.session.prompt(prompt({ signal: controller.signal }));
			try {
				const providerSignal = await entered.promise;
				controller.abort();
				expect(providerSignal?.aborted).toBe(true);
				expect(() => f.session.snapshot!()).toThrow("already running");
			} finally {
				settled.release();
			}
			await expect(running).resolves.toBe("cancelled");
			expect(f.faux.getPendingResponseCount()).toBe(1);
			expect(effects).toEqual(
				toolsStarted ? [{ text: "saved before cancellation" }] : [],
			);
			const checkpoint = parseCheckpoint(f.session.snapshot!());
			expect(checkpoint.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						stopReason: "length",
						content: [{ type: "text", text: "Partial report" }],
					}),
				]),
			);
			if (toolsStarted) {
				expect(JSON.stringify(checkpoint)).toContain("Retain this effect");
			}
		},
	);

	it.each(["length", "error"] as const)(
		"does not continue after output failure on a %s response",
		async (stopReason) => {
			const f = open();
			f.faux.setResponses([
				fauxAssistantMessage("partial", { stopReason: "length" }),
				fauxAssistantMessage("output fails here", { stopReason }),
				fauxAssistantMessage("Must not run"),
			]);
			const failure = await f.session
				.prompt(
					prompt({
						emit: async () => {
							if (f.contexts.length > 1) {
								throw new Error("client disconnected");
							}
						},
					}),
				)
				.catch((error: unknown) => error);
			expect(readRuntimeFailure(failure)).toMatchObject({
				stage: "output",
				toolsStarted: false,
			});
			expect(f.faux.getPendingResponseCount()).toBe(1);
			expect(parseCheckpoint(f.session.snapshot!()).messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						stopReason: "length",
						content: [{ type: "text", text: "partial" }],
					}),
				]),
			);
		},
	);

	it.each(["context_limit", "cancelled"] as const)(
		"retains length-stopped text without tool effects after provider %s for explicit resume",
		async (outcome) => {
			const f = open();
			const partial = "export const answer = 42;";
			f.faux.setResponses([
				fauxAssistantMessage(partial, { stopReason: "length" }),
				fauxAssistantMessage("", {
					stopReason: outcome === "context_limit" ? "error" : "aborted",
					errorMessage: "context_length_exceeded",
				}),
				fauxAssistantMessage("Resumed explicitly"),
			]);
			const result = await f.session
				.prompt(prompt())
				.catch((error: unknown) => error);
			if (outcome === "context_limit") {
				expect(readRuntimeFailure(result)).toMatchObject({
					stage: "model_request",
					category: "context_limit",
					toolsStarted: false,
				});
			} else {
				expect(result).toBe("cancelled");
			}
			expect(f.faux.getPendingResponseCount()).toBe(1);
			const checkpoint = parseCheckpoint(f.session.snapshot!());
			const priorAssistant = expect.objectContaining({
				role: "assistant",
				stopReason: "length",
				content: [{ type: "text", text: partial }],
			});
			expect(checkpoint.messages).toEqual(
				expect.arrayContaining([priorAssistant]),
			);
			f.session.restore!(checkpoint);
			await expect(f.session.prompt(prompt())).resolves.toBe("completed");
			expect(f.contexts.at(-1)?.messages).toEqual(
				expect.arrayContaining([priorAssistant]),
			);
		},
	);

	it.each([
		{ category: "context_limit", errorMessage: "context_length_exceeded" },
		{ category: "rate_limit", errorMessage: "429 rate limit exceeded" },
	])(
		"propagates $category after continuation and retains settled effects for explicit resume",
		async ({ category, errorMessage }) => {
			const effects: unknown[] = [];
			const f = open({
				tools: [
					writeTool({
						execute: async (args) => {
							effects.push(args);
							return { text: "Saved implementation checkpoint" };
						},
					}),
				],
			});
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { text: "implemented" })),
				fauxAssistantMessage("Verification results", { stopReason: "length" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("Resumed explicitly"),
			]);
			const failure = await f.session
				.prompt(prompt())
				.catch((error: unknown) => error);
			expect(readRuntimeFailure(failure)).toMatchObject({
				stage: "model_request",
				category,
				toolsStarted: true,
			});
			expect(f.faux.getPendingResponseCount()).toBe(1);
			const checkpoint = parseCheckpoint(f.session.snapshot!());
			expect(JSON.stringify(checkpoint)).toContain(
				"Saved implementation checkpoint",
			);
			expect(JSON.stringify(checkpoint)).toContain("Verification results");
			f.session.restore!(checkpoint);
			await expect(f.session.prompt(prompt())).resolves.toBe("completed");
			expect(effects).toEqual([{ text: "implemented" }]);
			expect(JSON.stringify(f.contexts.at(-1)?.messages)).toContain(
				"Saved implementation checkpoint",
			);
		},
	);

	it("preserves permission denial during continuation without re-executing or automatically re-asking", async () => {
		const execute = vi.fn(async () => ({ text: "Must not execute" }));
		const permission = vi.fn(async () => false);
		const f = open(
			{ tools: [writeTool({ permission: "ask", execute })] },
			{ client: { requestPermission: permission } },
		);
		f.faux.setResponses([
			fauxAssistantMessage("Work plan", { stopReason: "length" }),
			fauxAssistantMessage(
				fauxToolCall("write", { text: "requires approval" }),
			),
			fauxAssistantMessage("Permission denied; no changes made"),
			fauxAssistantMessage("Must not run"),
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		expect(execute).not.toHaveBeenCalled();
		expect(permission).toHaveBeenCalledOnce();
		expect(f.faux.getPendingResponseCount()).toBe(1);
		expect(JSON.stringify(f.contexts.at(-1)?.messages)).toContain(
			"Tool permission denied",
		);
	});
});
