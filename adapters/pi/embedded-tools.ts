import { randomUUID } from "node:crypto";
import {
	type Agent,
	type AgentEvent,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
	type RuntimeActivity,
	type RuntimeSessionInput,
	type RuntimeTool,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { toolResultSchema } from "./embedded-checkpoint.ts";

/** Model-visible schemas are hints; the originating Zod schema remains authoritative. */
export interface EmbeddedTool {
	readonly tool: RuntimeTool;
	readonly parameters: TSchema;
}

/** Convert once, without discovering tools, servers, credentials, or workspace files. */
export const compileTools = (
	tools: readonly RuntimeTool[] = [],
): readonly EmbeddedTool[] => {
	const names = new Set<string>();
	return tools.map((tool) => {
		if (!tool.name || names.has(tool.name)) {
			throw new Error("Runtime tool names must be nonempty and unique");
		}
		if (tool.permission !== "ask" && tool.permission !== "none") {
			throw new Error("Unknown runtime tool permission policy");
		}
		names.add(tool.name);
		const inputSchema =
			"inputSchema" in tool
				? z.record(z.unknown()).optional().parse(tool.inputSchema)
				: undefined;
		return {
			tool,
			// Pi accepts JSON Schema through TypeBox's explicitly unsafe schema constructor.
			// oxlint-disable-next-line new-cap
			parameters: Type.Unsafe(
				structuredClone(
					inputSchema ??
						zodToJsonSchema(tool.schema, {
							target: "jsonSchema7",
							$refStrategy: "none",
							effectStrategy: "input",
						}),
				),
			),
		};
	});
};

/** Pi's unknown-tool and preflight failures have text results but no D3R details. */
const piToolResult = z.object({
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

/** Approval and parsed inputs belong to one call, not a reusable permission cache. */
interface ToolState {
	readonly id: string;
	readonly name: string;
	readonly rawInput: unknown;
	args?: unknown;
	approved: boolean;
	result?: RuntimeToolResult;
}

/** Adapt Pi's awaited preflight and execution hooks into session-scoped D3R tools. */
export const createToolBridge = (
	definitions: readonly EmbeddedTool[],
	input: RuntimeSessionInput,
	{
		namespace,
		requestSignal,
		activity,
	}: {
		readonly namespace: string;
		readonly requestSignal: AbortSignal;
		readonly activity: (event: RuntimeActivity) => Promise<void>;
	},
) => {
	const calls = new Map<string, ToolState>();
	const execution = { started: false };
	const findTool = (name: string) =>
		definitions.find(({ tool }) => tool.name === name)?.tool;
	const toolActivity = async (
		call: ToolState,
		status: "pending" | "in_progress" | "completed" | "failed",
		result?: RuntimeToolResult,
	): Promise<void> => {
		await activity({
			kind: "tool",
			toolCallId: call.id,
			title: call.name,
			toolKind: findTool(call.name)?.kind ?? "other",
			status,
			rawInput: call.rawInput,
			...(result
				? {
						content: result.content ?? [{ type: "text", text: result.text }],
						locations: result.locations,
						rawOutput: result,
					}
				: {}),
		});
	};
	const beforeToolCall: NonNullable<Agent["beforeToolCall"]> = async (
		{ toolCall, assistantMessage },
		signal,
	) => {
		const tool = findTool(toolCall.name);
		const call = calls.get(toolCall.id);
		const activeSignal = AbortSignal.any([
			requestSignal,
			...(signal ? [signal] : []),
		]);
		activeSignal.throwIfAborted();
		if (
			!tool ||
			!call ||
			assistantMessage.content.filter(
				(block) => block.type === "toolCall" && block.id === toolCall.id,
			).length !== 1
		) {
			return { block: true, reason: "Unknown or ambiguous tool call" };
		}
		// Pi may coerce its copy of the JSON arguments. Validate the original input,
		// including refinements, and execute this exact parsed value only once.
		const parsed = await tool.schema
			.safeParseAsync(toolCall.arguments)
			.catch(() => null);
		if (!parsed?.success) {
			return { block: true, reason: "Tool arguments failed schema validation" };
		}
		activeSignal.throwIfAborted();
		call.args = parsed.data;
		if (tool.permission === "ask") {
			if (!input.client) {
				return {
					block: true,
					reason: "Tool requires a client permission service",
				};
			}
			try {
				const allowed = await input.client.requestPermission(
					{
						toolCallId: call.id,
						title: tool.name,
						kind: tool.kind,
						input: structuredClone(call.args),
						...(tool.permissionScope === undefined
							? {}
							: { scope: tool.permissionScope }),
					},
					activeSignal,
				);
				if (allowed !== true) {
					return { block: true, reason: "Tool permission denied" };
				}
			} catch {
				return { block: true, reason: "Tool permission request failed" };
			}
		} else if (tool.permission !== "none") {
			return { block: true, reason: "Unknown runtime tool permission policy" };
		}
		activeSignal.throwIfAborted();
		call.approved = true;
		return undefined;
	};
	const tools: AgentTool[] = definitions.map(({ tool, parameters }) => ({
		name: tool.name,
		description: tool.description,
		label: tool.name,
		parameters,
		replay: "never",
		execute: async (id, _args, signal) => {
			const call = calls.get(id);
			const activeSignal = AbortSignal.any([
				requestSignal,
				...(signal ? [signal] : []),
			]);
			if (!call?.approved || call.name !== tool.name) {
				throw new Error("Tool was not approved");
			}
			call.approved = false;
			activeSignal.throwIfAborted();
			await toolActivity(call, "in_progress");
			activeSignal.throwIfAborted();
			execution.started = true;
			try {
				call.result = toolResultSchema.parse(
					await tool.execute(call.args, {
						toolCallId: call.id,
						requestSignal,
						cwd: input.cwd,
						roots: [input.cwd, ...(input.additionalDirectories ?? [])],
						signal: activeSignal,
						client: input.client,
					}),
				);
			} catch {
				call.result = {
					text: activeSignal.aborted
						? "Tool execution cancelled. Check current state before retrying changes."
						: "Tool execution failed. Check current state before retrying changes. This error is not itself a permission denial.",
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: call.result.text }],
				details: call.result,
			};
		},
	}));
	const afterToolCall: NonNullable<Agent["afterToolCall"]> = async ({
		toolCall,
		isError,
	}) => ({
		isError: calls.get(toolCall.id)?.result?.isError ?? isError,
	});
	const observe = async (event: AgentEvent): Promise<void> => {
		if (event.type === "tool_execution_start") {
			const call: ToolState = {
				id: `${namespace}:tool:${randomUUID()}`,
				name: event.toolName,
				rawInput: structuredClone(event.args),
				approved: false,
			};
			calls.set(event.toolCallId, call);
			await toolActivity(call, "pending");
		} else if (event.type === "tool_execution_end") {
			const call = calls.get(event.toolCallId);
			if (call) {
				const parsed = piToolResult.safeParse(event.result);
				const result = call.result ?? {
					text: parsed.success
						? parsed.data.content.map((block) => block.text).join("\n")
						: "Tool result unavailable",
					isError: event.isError,
				};
				// Completion-order delivery can abort siblings on output failure; waiting
				// for transcript-order message_end could deadlock a sibling awaiting abort.
				await toolActivity(
					call,
					event.isError ? "failed" : "completed",
					result,
				);
			}
		}
	};
	return {
		tools,
		beforeToolCall,
		afterToolCall,
		observe,
		hasStartedTools: () => execution.started,
	};
};
