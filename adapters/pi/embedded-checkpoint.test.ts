import {
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { closeToolBatches, parseCheckpoint } from "./embedded-checkpoint.ts";

/** Minimal persisted data deliberately excludes model objects and injected services. */
const checkpoint = (messages: readonly Message[] = []): unknown => ({
	format: "d3r.pi.embedded",
	version: 1,
	model: { provider: "test", id: "test-model" },
	thinkingLevel: "off",
	messages,
});

/** The narrow boundary must fail before any state change or provider request. */
describe("embedded checkpoint boundary", () => {
	it("round trips a detached transcript and strips unrecognized provider metadata", () => {
		const assistant = {
			...fauxAssistantMessage("hello"),
			errorMessage: "private detail",
			headers: { Authorization: "secret" },
		};
		const saved = parseCheckpoint(checkpoint([assistant]));
		expect(JSON.stringify(saved)).not.toMatch(
			/private detail|secret|Authorization/,
		);
		expect(saved.messages[0]).not.toBe(assistant);
		assistant.content.length = 0;
		expect(saved.messages[0].content).toEqual([
			{ type: "text", text: "hello" },
		]);
	});

	it("strips backend error metadata on live resume while preserving tool-call evidence", () => {
		const privateDiagnostic = "/private/d3r/credentials.json fake-auth-secret";
		const assistant = {
			...fauxAssistantMessage(
				fauxToolCall("write", { path: "workspace-file" }),
			),
			errorMessage: privateDiagnostic,
			rawStopReason: privateDiagnostic,
		};
		const messages = closeToolBatches([assistant]);
		expect(JSON.stringify(messages)).not.toContain(privateDiagnostic);
		expect(messages[0].content).toEqual(assistant.content);
		expect(assistant.errorMessage).toBe(privateDiagnostic);
		expect(() => parseCheckpoint(checkpoint(messages))).not.toThrow();
	});

	it("accepts shared immutable provider usage but rejects ancestor cycles", () => {
		const first = fauxAssistantMessage("first");
		const second = { ...fauxAssistantMessage("second"), usage: first.usage };
		expect(() => parseCheckpoint(checkpoint([first, second]))).not.toThrow();
		const cycle: unknown[] = [];
		cycle.push(cycle);
		expect(() => parseCheckpoint(checkpoint(cycle as Message[]))).toThrow(
			"acyclic",
		);
	});

	it("does not evaluate checkpoint accessors", () => {
		const getter = vi.fn(() => 1);
		expect(() =>
			parseCheckpoint(Object.defineProperty({}, "version", { get: getter })),
		).toThrow("accessors");
		expect(getter).not.toHaveBeenCalled();
	});

	it.each([0, "1", undefined])("rejects unsupported versions %s", (version) => {
		const saved = parseCheckpoint(checkpoint());
		expect(() => parseCheckpoint({ ...saved, version })).toThrow();
	});

	it.each(["pending", "deferred", "unknown"])(
		"rejects unsettled or unknown stop reasons %s",
		(stopReason) => {
			const saved = parseCheckpoint(checkpoint());
			expect(() =>
				parseCheckpoint({
					...saved,
					messages: [{ ...fauxAssistantMessage(""), stopReason }],
				}),
			).toThrow();
		},
	);

	it("closes only missing results without erasing a completed effect", () => {
		const assistant = fauxAssistantMessage([
			fauxToolCall("write", { path: "a" }, { id: "done" }),
			fauxToolCall("write", { path: "b" }, { id: "unstarted" }),
		]);
		const completed: Message = {
			role: "toolResult",
			toolCallId: "done",
			toolName: "write",
			content: [{ type: "text", text: "effect completed" }],
			isError: false,
			timestamp: 0,
		};
		const messages = closeToolBatches([
			assistant,
			completed,
			fauxAssistantMessage("", { stopReason: "aborted" }),
		]);
		const saved = parseCheckpoint(checkpoint(messages));
		expect(
			saved.messages.filter((entry) => entry.role === "toolResult"),
		).toEqual([
			completed,
			expect.objectContaining({
				toolCallId: "unstarted",
				isError: true,
				content: [
					{
						type: "text",
						text: expect.stringContaining(
							"Check current state before deciding whether to retry",
						),
					},
				],
			}),
		]);
	});

	it("rejects orphan, duplicate, mismatched and unfinished tool records", () => {
		const assistant = fauxAssistantMessage(
			fauxToolCall("write", {}, { id: "call" }),
		);
		const result: Message = {
			role: "toolResult",
			toolCallId: "call",
			toolName: "write",
			content: [],
			details: {},
			isError: true,
			timestamp: 0,
		};
		expect(() =>
			parseCheckpoint(checkpoint([assistant, result])),
		).not.toThrow();
		expect(() => parseCheckpoint(checkpoint([result]))).toThrow("Unmatched");
		expect(() => parseCheckpoint(checkpoint([assistant]))).toThrow(
			"Unfinished",
		);
		expect(() =>
			parseCheckpoint(
				checkpoint([assistant, { ...result, toolName: "wrong" }]),
			),
		).toThrow("Unmatched");
		expect(() =>
			parseCheckpoint(checkpoint([assistant, result, result])),
		).toThrow("Unmatched");
		expect(() =>
			parseCheckpoint(
				checkpoint([
					{
						...assistant,
						content: [...assistant.content, ...assistant.content],
					},
					result,
				]),
			),
		).toThrow("Duplicate");
	});

	it("rejects executable arguments and bounds recursive input depth", () => {
		const assistant = fauxAssistantMessage(
			fauxToolCall("write", { run: () => {} }),
		);
		expect(() => parseCheckpoint(checkpoint([assistant]))).toThrow(
			"plain data",
		);
		const excessiveDepth = 110;
		const nested = Array.from({ length: excessiveDepth }).reduce<unknown>(
			(value) => [value],
			null,
		);
		expect(() => parseCheckpoint(nested)).toThrow("data limits");
	});
});
