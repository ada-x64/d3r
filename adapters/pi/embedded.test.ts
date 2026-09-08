import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerSessionResourceCleanup,
	type Context,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	createEmbeddedRuntime,
	type EmbeddedRuntimeOptions,
} from "@d3r/adapter-pi/embedded";
import {
	type RuntimeChunk,
	type RuntimePrompt,
	type RuntimeSession,
} from "@d3r/core/runtime";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** An explicit cwd must reach resource access without changing process cwd. */
const CWD = resolve("embedded-test-workspace");

/** Default turn input; every test can replace the signal, content, or emitter. */
const prompt = (overrides: Partial<RuntimePrompt> = {}): RuntimePrompt => ({
	content: [{ type: "text", text: "hello" }],
	signal: new AbortController().signal,
	emit: async () => {},
	...overrides,
});

/** A resolver/provider fixture that stops only when its actual signal is aborted. */
const waitForAbort = (signal: AbortSignal): Promise<never> =>
	new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
		} else {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		}
	});

/** Real Pi libraries with an offline scripted provider test only the D3R bridge. */
describe("embedded Pi runtime", () => {
	const sessions: RuntimeSession[] = [];
	const callbacks: (() => void)[] = [];
	const open = (options: Partial<EmbeddedRuntimeOptions> = {}) => {
		const faux = fauxProvider({
			models: [{ id: "test-model", reasoning: true }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const factory = createEmbeddedRuntime({
			models,
			model: faux.getModel(),
			systemPrompt: "D3R test prompt",
			...options,
		});
		const createSession = () => {
			const session = factory({ sessionId: "same-external-id", cwd: CWD });
			sessions.push(session);
			return session;
		};
		return { faux, models, createSession, session: createSession() };
	};

	afterEach(async () => {
		try {
			await Promise.all(sessions.splice(0).map((session) => session.dispose()));
		} finally {
			callbacks.splice(0).forEach((unregister) => unregister());
		}
	});

	it("supplies explicit configuration and emits text/thought blocks once with distinct IDs", async () => {
		const f = open({ thinkingLevel: "medium" });
		const contexts: Context[] = [];
		const settings: (SimpleStreamOptions | undefined)[] = [];
		f.faux.setResponses([
			(context, options) => {
				contexts.push(structuredClone(context));
				settings.push(options);
				return fauxAssistantMessage([
					fauxThinking("Consider carefully"),
					fauxText("Hello world"),
				]);
			},
		]);
		const chunks: RuntimeChunk[] = [];
		await expect(
			f.session.prompt(
				prompt({
					emit: async (chunk) => {
						chunks.push(chunk);
					},
				}),
			),
		).resolves.toBe("completed");
		expect(contexts[0].systemPrompt).toBe("D3R test prompt");
		expect(contexts[0].tools).toEqual([]);
		expect(settings[0]?.reasoning).toBe("medium");
		const text = chunks.filter((chunk) => chunk.kind === "text");
		const thought = chunks.filter((chunk) => chunk.kind === "thought");
		expect(text.map((chunk) => chunk.text).join("")).toBe("Hello world");
		expect(thought.map((chunk) => chunk.text).join("")).toBe(
			"Consider carefully",
		);
		expect(new Set(text.map((chunk) => chunk.messageId)).size).toBe(1);
		expect(new Set(thought.map((chunk) => chunk.messageId)).size).toBe(1);
		expect(text[0].messageId).not.toBe(thought[0].messageId);
	});

	it("retains prior turns only within their session and uses new response IDs", async () => {
		const f = open();
		const other = f.createSession();
		const contexts: Context[] = [];
		const settings: (SimpleStreamOptions | undefined)[] = [];
		const reply = (
			context: Context,
			options: SimpleStreamOptions | undefined,
		) => {
			contexts.push(structuredClone(context));
			settings.push(options);
			return fauxAssistantMessage("reply");
		};
		f.faux.setResponses([reply, reply, reply]);
		const chunks: RuntimeChunk[] = [];
		const emit = async (chunk: RuntimeChunk) => {
			chunks.push(chunk);
		};
		await f.session.prompt(prompt({ emit }));
		const firstId = chunks[0].messageId;
		chunks.length = 0;
		await f.session.prompt(
			prompt({ content: [{ type: "text", text: "follow-up" }], emit }),
		);
		expect(chunks[0].messageId).not.toBe(firstId);
		await other.prompt(prompt());
		expect(contexts[1].messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		const otherSessionTurn = 2;
		expect(
			contexts[otherSessionTurn].messages.map((message) => message.role),
		).toEqual(["user"]);
		expect(settings[0]?.sessionId).toBeTruthy();
		expect(settings[1]?.sessionId).toBe(settings[0]?.sessionId);
		expect(settings[otherSessionTurn]?.sessionId).not.toBe(
			settings[0]?.sessionId,
		);
	});

	it("resolves links through the injected policy and preserves text block order", async () => {
		const resolver = vi.fn(async () => "resolved contents");
		const f = open({ resolveResource: resolver });
		const contexts: Context[] = [];
		f.faux.setResponses([
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		const resource = {
			type: "resource_link" as const,
			uri: "file:///work/config.json",
			name: "config.json",
		};
		const request = prompt({
			content: [
				{ type: "text", text: "before" },
				resource,
				{ type: "text", text: "after" },
			],
		});
		await f.session.prompt(request);
		expect(resolver).toHaveBeenCalledWith(resource, {
			cwd: CWD,
			signal: expect.any(AbortSignal),
		});
		expect(contexts[0].messages[0].content).toEqual([
			{ type: "text", text: "before" },
			{
				type: "text",
				text: "Resource: config.json\nURI: file:///work/config.json\n\nresolved contents",
			},
			{ type: "text", text: "after" },
		]);
	});

	it("refuses links without a resolver before calling a model", async () => {
		const f = open();
		await expect(
			f.session.prompt(
				prompt({
					content: [
						{
							type: "resource_link",
							uri: "file:///work/config",
							name: "config",
						},
					],
				}),
			),
		).rejects.toThrow("Resource links require a configured resolver");
		expect(f.faux.state.callCount).toBe(0);
	});

	it("rolls a failed model turn back without losing earlier successful context", async () => {
		const f = open();
		const contexts: Context[] = [];
		f.faux.setResponses([
			fauxAssistantMessage("kept reply"),
			fauxAssistantMessage("partial", {
				stopReason: "error",
				errorMessage: "sensitive backend detail",
			}),
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("recovered");
			},
		]);
		await f.session.prompt(
			prompt({ content: [{ type: "text", text: "kept prompt" }] }),
		);
		await expect(
			f.session.prompt(
				prompt({ content: [{ type: "text", text: "failed prompt" }] }),
			),
		).rejects.toThrow("Model request failed");
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		expect(contexts[0].messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(JSON.stringify(contexts[0])).toContain("kept reply");
		expect(JSON.stringify(contexts[0])).not.toContain("failed prompt");
		expect(JSON.stringify(contexts[0])).not.toContain(
			"sensitive backend detail",
		);
	});

	it("reports token limits and retains the partial successful turn", async () => {
		const f = open();
		const contexts: Context[] = [];
		f.faux.setResponses([
			fauxAssistantMessage("truncated", { stopReason: "length" }),
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("next");
			},
		]);
		await expect(f.session.prompt(prompt())).resolves.toBe("token_limit");
		await f.session.prompt(prompt());
		expect(JSON.stringify(contexts[0].messages)).toContain("truncated");
	});

	it.each(["toolUse", "length", "stop"] as const)(
		"does not retry unexpected tools with stop reason %s",
		async (stopReason) => {
			const f = open();
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write_file", { path: "file" }), {
					stopReason,
				}),
				fauxAssistantMessage("must not run automatically"),
			]);
			await expect(f.session.prompt(prompt())).rejects.toThrow(
				"Embedded tool execution is not supported yet",
			);
			expect(f.faux.state.callCount).toBe(1);
			expect(f.faux.getPendingResponseCount()).toBe(1);
		},
	);

	it("handles failure before any stream starts instead of returning success", async () => {
		const f = open();
		f.faux.setResponses([
			() => {
				throw new Error("backend failure before start");
			},
		]);
		await expect(f.session.prompt(prompt())).rejects.toThrow(
			"Model request failed",
		);
	});

	it("returns cancelled for an already-aborted prompt without invoking the model", async () => {
		const f = open();
		await expect(
			f.session.prompt(prompt({ signal: AbortSignal.abort() })),
		).resolves.toBe("cancelled");
		expect(f.faux.state.callCount).toBe(0);
	});

	it("forwards cancellation while preparing resources and stays usable", async () => {
		const calls: AbortSignal[] = [];
		const f = open({
			resolveResource: async (_resource, { signal }) => {
				calls.push(signal);
				return waitForAbort(signal);
			},
		});
		const controller = new AbortController();
		const running = f.session.prompt(
			prompt({
				signal: controller.signal,
				content: [
					{ type: "resource_link", uri: "file:///work/file", name: "file" },
				],
			}),
		);
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		controller.abort();
		await expect(running).resolves.toBe("cancelled");
		expect(f.faux.state.callCount).toBe(0);
		f.faux.setResponses([fauxAssistantMessage("recovered")]);
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
	});

	it.each(["failure", "cancel"] as const)(
		"waits for sibling resource cleanup after %s",
		async (mode) => {
			let release: () => void = vi.fn();
			const held = new Promise<void>((resolveCleanup) => {
				release = resolveCleanup;
			});
			const signals: AbortSignal[] = [];
			let cleaning = false;
			let settled = false;
			const f = open({
				resolveResource: async (resource, { signal }) => {
					signals.push(signal);
					if (resource.name === "slow") {
						await waitForAbort(signal).catch(() => {});
						cleaning = true;
						await held;
						signal.throwIfAborted();
						return "unused";
					}
					if (mode === "failure") {
						throw new Error("Resource failed");
					}
					return waitForAbort(signal);
				},
			});
			const controller = new AbortController();
			const running = f.session.prompt(
				prompt({
					signal: controller.signal,
					content: [
						{ type: "resource_link", uri: "file:///work/slow", name: "slow" },
						{ type: "resource_link", uri: "file:///work/fast", name: "fast" },
					],
				}),
			);
			const markSettled = () => {
				settled = true;
			};
			const observed = running.then(markSettled, markSettled);
			try {
				const resourceCount = 2;
				await vi.waitFor(() => expect(signals).toHaveLength(resourceCount));
				if (mode === "cancel") {
					controller.abort();
				}
				await vi.waitFor(() => expect(cleaning).toBe(true));
				expect(signals.every((signal) => signal.aborted)).toBe(true);
				expect(settled).toBe(false);
				await expect(f.session.dispose()).rejects.toThrow("active runtime");
			} finally {
				release();
				await observed;
			}
			await (mode === "cancel"
				? expect(running).resolves.toBe("cancelled")
				: expect(running).rejects.toThrow("Resource failed"));
			expect(f.faux.state.callCount).toBe(0);
			await f.session.dispose();
		},
	);

	it("waits for emitted chunks and rejects overlapping prompts or premature disposal", async () => {
		const f = open();
		f.faux.setResponses([fauxAssistantMessage("hello")]);
		let release: () => void = vi.fn();
		const held = new Promise<void>((resolveOutput) => {
			release = resolveOutput;
		});
		let emitting = false;
		let settled = false;
		const running = f.session
			.prompt(
				prompt({
					emit: async () => {
						emitting = true;
						await held;
					},
				}),
			)
			.then((result) => {
				settled = true;
				return result;
			});
		try {
			await vi.waitFor(() => expect(emitting).toBe(true));
			expect(settled).toBe(false);
			await expect(f.session.prompt(prompt())).rejects.toThrow(
				"already running",
			);
			await expect(f.session.dispose()).rejects.toThrow("active runtime");
		} finally {
			release();
		}
		await expect(running).resolves.toBe("completed");
	});

	it("cancels a model turn and rolls it back", async () => {
		const f = open();
		const contexts: Context[] = [];
		f.faux.setResponses([
			fauxAssistantMessage("cancel this answer"),
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("next answer");
			},
		]);
		const controller = new AbortController();
		const emit = vi.fn(async () => {
			controller.abort();
		});
		await expect(
			f.session.prompt(prompt({ signal: controller.signal, emit })),
		).resolves.toBe("cancelled");
		expect(emit).toHaveBeenCalledOnce();
		await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		expect(contexts[0].messages.map((message) => message.role)).toEqual([
			"user",
		]);
	});

	it("aborts an active provider without retaining previous turns' abort listeners", async () => {
		const f = open();
		const signals: AbortSignal[] = [];
		f.faux.setResponses([
			fauxAssistantMessage("first reply"),
			async (_context, options) => {
				if (!options?.signal) {
					throw new Error("Expected provider signal");
				}
				signals.push(options.signal);
				return waitForAbort(options.signal);
			},
		]);
		const previous = new AbortController();
		await f.session.prompt(prompt({ signal: previous.signal }));
		const current = new AbortController();
		const running = f.session.prompt(prompt({ signal: current.signal }));
		try {
			await vi.waitFor(() => expect(signals).toHaveLength(1));
			previous.abort();
			expect(signals[0].aborted).toBe(false);
		} finally {
			current.abort();
		}
		await expect(running).resolves.toBe("cancelled");
		expect(signals[0].aborted).toBe(true);
	});

	it.each([undefined, new Error("downstream output failure")])(
		"does not swallow emitter rejection (%s)",
		async (rejection) => {
			const f = open();
			f.faux.setResponses([
				fauxAssistantMessage("hello world"),
				fauxAssistantMessage("recovered"),
			]);
			const emit = vi.fn(async () => {
				throw rejection;
			});
			await expect(f.session.prompt(prompt({ emit }))).rejects.toThrow(
				"Runtime output delivery failed",
			);
			expect(emit).toHaveBeenCalledOnce();
			await expect(f.session.prompt(prompt())).resolves.toBe("completed");
		},
	);

	it("treats provider abort as cancellation, not failure or a completed turn", async () => {
		const f = open();
		f.faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);
		await expect(f.session.prompt(prompt())).resolves.toBe("cancelled");
	});

	it("cleans only its provider session once and rejects prompts after disposal", async () => {
		const cleaned: (string | undefined)[] = [];
		callbacks.push(
			registerSessionResourceCleanup((id) => {
				cleaned.push(id);
			}),
		);
		const f = open();
		const other = f.createSession();
		const ids: (string | undefined)[] = [];
		const reply = (
			_context: Context,
			options: SimpleStreamOptions | undefined,
		) => {
			ids.push(options?.sessionId);
			return fauxAssistantMessage("done");
		};
		f.faux.setResponses([reply, reply]);
		await f.session.prompt(prompt());
		await f.session.dispose();
		await f.session.dispose();
		expect(cleaned).toEqual([ids[0]]);
		await expect(f.session.prompt(prompt())).rejects.toThrow("disposed");
		await expect(other.prompt(prompt())).resolves.toBe("completed");
		await other.dispose();
		expect(cleaned).toEqual(ids);
		expect(ids[0]).toBeTruthy();
		expect(ids[1]).not.toBe(ids[0]);
	});
});
