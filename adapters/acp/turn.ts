import { randomUUID } from "node:crypto";
import {
	type AgentContext,
	type SessionUpdate,
	type ToolCall,
} from "@agentclientprotocol/sdk";
import {
	type RuntimeActivity,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { waitFor } from "./errors.ts";
import { runtimeContent, type PromptParams } from "./params.ts";
import { type Session } from "./session.ts";
import { type SessionRecord } from "./store.ts";
import { toolCallPresentation } from "./presentation.ts";

/** Initial tool events establish identity before any progress updates. */
const activityUpdate = (
	session: Session,
	event: RuntimeActivity,
): SessionUpdate => {
	if (event.kind === "plan") {
		return {
			sessionUpdate: "plan",
			entries: event.entries.map((entry) => ({ ...entry })),
		};
	}
	if (event.kind === "usage") {
		return {
			sessionUpdate: "usage_update",
			used: event.used,
			size: event.size,
			...(event.cost ? { cost: { ...event.cost } } : {}),
		};
	}
	const sessionUpdate = session.tools.has(event.toolCallId)
		? "tool_call_update"
		: "tool_call";
	session.tools.add(event.toolCallId);
	const presentation = toolCallPresentation(
		{ title: event.title, kind: event.toolKind, input: event.rawInput },
		{ secrets: session.secrets },
	);
	const permission = session.services.permissionPresentation(event.toolCallId);
	const preview =
		permission?.content ??
		(event.rawInput === undefined ? [] : (presentation.content ?? []));
	const tool: ToolCall = {
		toolCallId: event.toolCallId,
		title: permission?.title ?? presentation.title,
		kind: event.toolKind,
		status: event.status,
		...(preview.length || event.content
			? {
					content: [
						...preview,
						...(event.content ?? []).map((item) =>
							item.type === "text"
								? {
										type: "content" as const,
										content: { type: "text" as const, text: item.text },
									}
								: { ...item },
						),
					],
				}
			: {}),
		...(event.locations
			? { locations: event.locations.map((location) => ({ ...location })) }
			: {}),
		...(presentation.rawInput === undefined
			? {}
			: { rawInput: presentation.rawInput }),
		...(event.rawOutput === undefined ? {} : { rawOutput: event.rawOutput }),
	};
	return sessionUpdate === "tool_call"
		? { ...tool, sessionUpdate: "tool_call" }
		: { ...tool, sessionUpdate: "tool_call_update" };
};
/** Runtime callback shutdown is not a client cancellation and must not determine the stop reason. */
export const runTurn = async (
	session: Session,
	{
		params,
		signal,
		client,
	}: { params: PromptParams; signal: AbortSignal; client: AgentContext },
): Promise<RuntimeStopReason> => {
	const lifetime = new AbortController();
	const runtimeSignal = AbortSignal.any([signal, lifetime.signal]);
	let accepting = true;
	const callbacks: Promise<void>[] = [];
	const send = (update: SessionUpdate): Promise<void> => {
		if (!accepting || runtimeSignal.aborted) {
			return Promise.resolve();
		}
		if (session.store) {
			session.records.push({ kind: "update", update: structuredClone(update) });
		}
		const pending = waitFor(
			client.notify("session/update", { sessionId: session.id, update }),
			signal,
		);
		callbacks.push(pending);
		void pending.catch(() => {});
		return pending;
	};
	const messageId = randomUUID();
	if (session.store) {
		session.records.push(
			...params.prompt.map(
				(content): SessionRecord => ({
					kind: "update",
					update: { sessionUpdate: "user_message_chunk", messageId, content },
				}),
			),
		);
	}
	try {
		return await session.runtime.prompt({
			content: params.prompt.map(runtimeContent),
			signal: runtimeSignal,
			emit: (chunk) =>
				send({
					sessionUpdate:
						chunk.kind === "text"
							? "agent_message_chunk"
							: "agent_thought_chunk",
					messageId: chunk.messageId,
					content: { type: "text", text: chunk.text },
				}),
			activity: (event) =>
				!accepting || runtimeSignal.aborted
					? Promise.resolve()
					: send(activityUpdate(session, event)),
		});
	} finally {
		accepting = false;
		lifetime.abort();
		// Accepted writes still flush before completion, but client cancellation releases stalled output.
		await Promise.all(callbacks);
	}
};
