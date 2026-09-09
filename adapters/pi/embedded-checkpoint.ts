import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, type ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";

/** JSON-only arguments exclude executable values at the persisted transcript boundary. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Pi exports no complete message validator in 0.85.1; this is our narrow wire boundary. */
const json: z.ZodType<Json> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(json),
		z.record(json),
	]),
);

/** Provider signatures are necessary for continued conversations, unlike request credentials. */
const text = z.object({
	type: z.literal("text"),
	text: z.string(),
	textSignature: z.string().optional(),
});

/** Images remain inline; restoring a checkpoint never fetches an attachment. */
const image = z.object({
	type: z.literal("image"),
	data: z.string(),
	mimeType: z.string().min(1),
});

/** Reject non-finite counters before they can poison accounting or serialization. */
const counter = z.number().finite().nonnegative();

/** Usage fields mirror the pinned Pi message contract, not provider request options. */
const usage = z.object({
	input: counter,
	output: counter,
	cacheRead: counter,
	cacheWrite: counter,
	cacheWrite1h: counter.optional(),
	reasoning: counter.optional(),
	totalTokens: counter,
	cost: z.object({
		input: counter,
		output: counter,
		cacheRead: counter,
		cacheWrite: counter,
		total: counter,
	}),
});

/** Tool details are our own presentation data, not arbitrary Pi extension state. */
export const toolResultSchema = z.object({
	text: z.string(),
	isError: z.boolean().optional(),
	content: z
		.array(
			z.discriminatedUnion("type", [
				z.object({ type: z.literal("text"), text: z.string() }),
				z.object({
					type: z.literal("diff"),
					path: z.string(),
					oldText: z.string().nullable(),
					newText: z.string(),
				}),
				z.object({ type: z.literal("terminal"), terminalId: z.string() }),
			]),
		)
		.optional(),
	locations: z
		.array(
			z.object({
				path: z.string(),
				line: z.number().int().positive().optional(),
			}),
		)
		.optional(),
});

/** A settled transcript cannot contain pending/deferred requests or custom extension roles. */
const message = z.discriminatedUnion("role", [
	z.object({
		role: z.literal("user"),
		content: z.union([z.string(), z.array(z.union([text, image]))]),
		timestamp: counter,
	}),
	z.object({
		role: z.literal("assistant"),
		content: z.array(
			z.discriminatedUnion("type", [
				text,
				z.object({
					type: z.literal("thinking"),
					thinking: z.string(),
					thinkingSignature: z.string().optional(),
					redacted: z.boolean().optional(),
				}),
				z.object({
					type: z.literal("toolCall"),
					id: z.string().min(1),
					name: z.string().min(1),
					arguments: z.record(json),
					thoughtSignature: z.string().optional(),
					namespace: z.string().optional(),
				}),
			]),
		),
		api: z.string().min(1),
		provider: z.string().min(1),
		model: z.string().min(1),
		responseModel: z.string().optional(),
		responseId: z.string().optional(),
		providerThinkingLevel: z.string().optional(),
		usage,
		stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
		timestamp: counter,
	}),
	z.object({
		role: z.literal("toolResult"),
		toolCallId: z.string().min(1),
		toolName: z.string().min(1),
		content: z.array(z.union([text, image])),
		details: z.union([toolResultSchema, z.object({}).strict()]).optional(),
		usage: usage.optional(),
		isError: z.boolean(),
		timestamp: counter,
	}),
]);

/** Require closed tool batches; restoring must never queue unfinished effects for execution. */
const transcript = z.array(message).superRefine((messages, ctx) => {
	const pending = new Map<string, string>();
	for (const entry of messages) {
		if (entry.role === "toolResult") {
			if (pending.get(entry.toolCallId) !== entry.toolName) {
				ctx.addIssue({ code: "custom", message: "Unmatched tool result" });
			}
			pending.delete(entry.toolCallId);
		} else if (pending.size > 0) {
			ctx.addIssue({ code: "custom", message: "Unfinished tool batch" });
		}
		if (entry.role === "assistant") {
			for (const block of entry.content) {
				if (block.type === "toolCall") {
					if (pending.has(block.id)) {
						ctx.addIssue({ code: "custom", message: "Duplicate tool call ID" });
					}
					pending.set(block.id, block.name);
				}
			}
		}
	}
	if (pending.size > 0) {
		ctx.addIssue({ code: "custom", message: "Unfinished tool batch" });
	}
});

/** Checkpoints contain identity and conversation data only; auth and system prompts stay injected. */
export const checkpointSchema = z
	.object({
		version: z.literal(1),
		format: z.literal("d3r.pi.embedded"),
		model: z
			.object({ provider: z.string().min(1), id: z.string().min(1) })
			.strict(),
		thinkingLevel: z.enum([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]),
		messages: transcript,
	})
	.strict();

/** Bound recursive JSON parsing and reject cycles/accessors without evaluating them. */
const assertPlainData = (input: unknown): void => {
	const maxDepth = 100;
	const maxNodes = 1_000_000;
	const ancestors = new Set<object>();
	const pending: {
		readonly value: unknown;
		readonly depth: number;
		readonly exit?: boolean;
	}[] = [{ value: input, depth: 0 }];
	let nodes = 0;
	while (pending.length > 0) {
		const entry = pending.pop();
		if (!entry) {
			break;
		}
		nodes += 1;
		if (entry.depth > maxDepth || nodes > maxNodes) {
			throw new Error("Checkpoint exceeds data limits");
		}
		if (entry.value !== null && typeof entry.value === "object" && entry.exit) {
			ancestors.delete(entry.value);
		} else if (entry.value === null || typeof entry.value !== "object") {
			if (
				!["undefined", "string", "boolean", "number"].includes(
					typeof entry.value,
				) &&
				entry.value !== null
			) {
				throw new Error("Checkpoint must contain plain data");
			}
		} else {
			if (
				ancestors.has(entry.value) ||
				(!Array.isArray(entry.value) &&
					Object.getPrototypeOf(entry.value) !== Object.prototype &&
					Object.getPrototypeOf(entry.value) !== null)
			) {
				throw new Error("Checkpoint must contain an acyclic plain-data tree");
			}
			ancestors.add(entry.value);
			pending.push({ value: entry.value, depth: entry.depth, exit: true });
			for (const descriptor of Object.values(
				Object.getOwnPropertyDescriptors(entry.value),
			)) {
				if (!("value" in descriptor)) {
					throw new Error("Checkpoint accessors are not supported");
				}
				pending.push({ value: descriptor.value, depth: entry.depth + 1 });
			}
		}
	}
};

/** Parse fully before changing any session state, returning detached, allowlisted data. */
export const parseCheckpoint = (
	input: unknown,
): z.infer<typeof checkpointSchema> => {
	assertPlainData(input);
	return checkpointSchema.parse(input);
};

/** Close unstarted calls after cancellation; no restore path executes transcript tool calls. */
export const closeToolBatches = (
	messages: readonly AgentMessage[],
): Message[] => {
	const result: Message[] = [];
	const pending = new Map<string, ToolCall>();
	const close = (): void => {
		for (const call of pending.values()) {
			result.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [
					{
						type: "text",
						text: "Tool call interrupted; no completed result is available. Do not automatically repeat effects.",
					},
				],
				isError: true,
				timestamp: Date.now(),
			});
		}
		pending.clear();
	};
	for (const entry of messages) {
		if (
			entry.role !== "user" &&
			entry.role !== "assistant" &&
			entry.role !== "toolResult"
		) {
			throw new Error("Unsupported embedded transcript role");
		}
		if (entry.role !== "toolResult") {
			close();
		}
		// Retain conversation/effect evidence, not backend diagnostics that may contain
		// credential values or private auth-store paths. This also protects live resume,
		// which must be as restrictive as the checkpoint's allowlisted fields.
		result.push(
			entry.role === "assistant"
				? {
						...entry,
						errorMessage: undefined,
						diagnostics: undefined,
						rawStopReason: undefined,
					}
				: entry,
		);
		if (entry.role === "assistant") {
			entry.content.forEach((block) => {
				if (block.type === "toolCall") {
					pending.set(block.id, block);
				}
			});
		} else if (entry.role === "toolResult") {
			pending.delete(entry.toolCallId);
		}
	}
	close();
	return result;
};
