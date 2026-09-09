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
import {
	appendRoleChunk,
	createRoleTranscript,
	isTerminalToolStatus,
	roleTranscriptUpdate,
	updateRoleTool,
	type RoleTranscript,
} from "./role-transcripts.ts";

/** Pending output owns one drain, not a queue of progressively larger snapshots. */
interface RoleOutput {
	readonly transcript: RoleTranscript;
	dirty: boolean;
	pending?: Promise<void>;
	recordIndex?: number;
}

/** Initial tool events establish identity before any progress updates. */
const activityUpdate = (
	session: Session,
	event: RuntimeActivity,
):
	| (ToolCall & { sessionUpdate: "tool_call" })
	| (ToolCall & { sessionUpdate: "tool_call_update" })
	| Extract<SessionUpdate, { sessionUpdate: "plan" | "usage_update" }> => {
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
	const callbacks = new Set<Promise<void>>();
	const delivery: { failure?: { error: unknown } } = {};
	const announced = new Map<string, ToolCall>();
	const roles = new Map<string, RoleOutput>();
	const track = (pending: Promise<void>): Promise<void> => {
		callbacks.add(pending);
		void pending.then(
			() => callbacks.delete(pending),
			(error: unknown) => {
				callbacks.delete(pending);
				delivery.failure ??= { error };
			},
		);
		return pending;
	};
	const send = (update: SessionUpdate, retain = true): Promise<void> => {
		if (signal.aborted) {
			return Promise.resolve();
		}
		if (session.store && retain) {
			session.records.push({ kind: "update", update: structuredClone(update) });
		}
		return track(
			waitFor(
				client.notify("session/update", { sessionId: session.id, update }),
				signal,
			),
		);
	};
	const retainRole = (role: RoleOutput, update: SessionUpdate): void => {
		if (!session.store) {
			return;
		}
		const record: SessionRecord = {
			kind: "update",
			update: structuredClone(update),
		};
		if (role.recordIndex === undefined) {
			role.recordIndex = session.records.length;
			session.records.push(record);
		} else {
			// This index was allocated in this turn; earlier checkpoints and other tools are untouched.
			session.records[role.recordIndex] = record;
		}
	};
	const flushRole = (role: RoleOutput): Promise<void> => {
		if (!role.pending && !delivery.failure && !signal.aborted) {
			role.pending = track(
				(async () => {
					try {
						while (role.dirty && !signal.aborted) {
							role.dirty = false;
							const update = roleTranscriptUpdate(role.transcript);
							retainRole(role, update);
							// oxlint-disable-next-line no-await-in-loop -- One in-flight snapshot per role bounds output and preserves status ordering.
							await send(update, false);
						}
					} finally {
						role.pending = undefined;
					}
				})(),
			);
		}
		return role.pending ?? Promise.resolve();
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
	let reason: RuntimeStopReason = "cancelled";
	try {
		reason = await session.runtime.prompt({
			content: params.prompt.map(runtimeContent),
			signal: runtimeSignal,
			emit: async (chunk) => {
				if (!accepting || runtimeSignal.aborted) {
					return;
				}
				if (chunk.parentToolCallId === undefined) {
					return send({
						sessionUpdate:
							chunk.kind === "text"
								? "agent_message_chunk"
								: "agent_thought_chunk",
						messageId: chunk.messageId,
						content: { type: "text", text: chunk.text },
					});
				}
				const tool = announced.get(chunk.parentToolCallId);
				if (!tool) {
					throw new Error(
						"Role transcript parent tool was not announced in this turn",
					);
				}
				if (delivery.failure) {
					throw delivery.failure.error;
				}
				let role = roles.get(tool.toolCallId);
				if (!role) {
					role = { transcript: createRoleTranscript(tool), dirty: false };
					roles.set(tool.toolCallId, role);
				}
				if (appendRoleChunk(role.transcript, chunk)) {
					role.dirty = true;
					// Acceptance is not transport backpressure: a child must still be able to request permission.
					void flushRole(role);
				}
			},
			activity: (event) => {
				if (!accepting) {
					return Promise.resolve();
				}
				const previous =
					event.kind === "tool"
						? (roles.get(event.toolCallId)?.transcript.tool ??
							announced.get(event.toolCallId))
						: undefined;
				// Runtime cleanup may finish announced tools after abort. Retain only terminal evidence,
				// without reopening finished siblings or dispatching more output.
				if (
					runtimeSignal.aborted &&
					(event.kind !== "tool" ||
						!previous ||
						!isTerminalToolStatus(event.status) ||
						isTerminalToolStatus(previous.status))
				) {
					return Promise.resolve();
				}
				const update = activityUpdate(session, event);
				if (
					update.sessionUpdate === "tool_call" ||
					update.sessionUpdate === "tool_call_update"
				) {
					const { sessionUpdate: _sessionUpdate, ...tool } = update;
					const current = {
						...announced.get(tool.toolCallId),
						...tool,
					};
					announced.set(tool.toolCallId, current);
					let role = roles.get(tool.toolCallId);
					if (!role && runtimeSignal.aborted) {
						// A role can be cancelled before its first text chunk.
						role = { transcript: createRoleTranscript(current), dirty: false };
						roles.set(tool.toolCallId, role);
					}
					if (role) {
						updateRoleTool(role.transcript, current);
						role.dirty = true;
						return runtimeSignal.aborted ? Promise.resolve() : flushRole(role);
					}
				}
				return send(update);
			},
		});
	} finally {
		accepting = false;
		lifetime.abort();
		// Drains may send their latest snapshot after runtime settlement, but never after this turn settles.
		// Client cancellation releases stalled output through send's existing waitFor boundary.
		await Promise.allSettled(callbacks);
		for (const role of roles.values()) {
			if (
				(signal.aborted || reason === "cancelled") &&
				!isTerminalToolStatus(role.transcript.tool.status)
			) {
				// No terminal callback is guaranteed on disconnect; failure closes the display, not the outcome.
				role.transcript.tool = { ...role.transcript.tool, status: "failed" };
				role.dirty = true;
			}
			if (role.dirty) {
				retainRole(role, roleTranscriptUpdate(role.transcript));
			}
		}
	}
	if (delivery.failure) {
		throw delivery.failure.error;
	}
	return reason;
};
