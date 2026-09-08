import {
	RequestError,
	type AgentContext,
	type AgentRequestContext,
	type PromptResponse,
	type StopReason,
} from "@agentclientprotocol/sdk";
import {
	type RuntimePrompt,
	type RuntimeSession,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { type PromptParams } from "./params.ts";

/** Live session resources owned by exactly one ACP connection. */
export interface Session {
	readonly id: string;
	readonly runtime: RuntimeSession;
	pending: AbortController | null;
	active: Promise<PromptResponse> | null;
}

/** Translate loop outcomes without leaking provider-specific stop reasons. */
const STOP_REASONS: Record<RuntimeStopReason, StopReason> = {
	completed: "end_turn",
	token_limit: "max_tokens",
	request_limit: "max_turn_requests",
	refused: "refusal",
	cancelled: "cancelled",
};

/** A blocked client write must not keep a cancelled runtime alive indefinitely. */
const waitForOutput = (
	pending: Promise<void>,
	signal: AbortSignal,
): Promise<void> =>
	new Promise((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// Observe late rejection even when cancellation already released the wait.
		pending.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) {
			onAbort();
		}
	});

/** Run one prompt and flush its updates before acknowledging completion. */
const runPrompt = async (
	session: Session,
	{ content, signal }: Omit<RuntimePrompt, "emit">,
	client: AgentContext,
): Promise<PromptResponse> => {
	let accepting = true;
	try {
		const result = await session.runtime.prompt({
			content,
			signal,
			emit: async (chunk) => {
				if (!accepting || signal.aborted) {
					return;
				}
				await waitForOutput(
					client.notify("session/update", {
						sessionId: session.id,
						update: {
							sessionUpdate:
								chunk.kind === "text"
									? "agent_message_chunk"
									: "agent_thought_chunk",
							messageId: chunk.messageId,
							content: { type: "text", text: chunk.text },
						},
					}),
					signal,
				);
			},
		});
		return { stopReason: signal.aborted ? "cancelled" : STOP_REASONS[result] };
	} catch {
		if (signal.aborted) {
			return { stopReason: "cancelled" };
		}
		// Provider failures can include credentials or request bodies.
		throw RequestError.internalError(undefined, "Agent runtime failed");
	} finally {
		accepting = false;
		session.pending = null;
		session.active = null;
	}
};

/** Reject overlapping prompts in one session; separate sessions run independently. */
export const promptSession = (
	session: Session,
	{ params, signal: requestSignal, client }: AgentRequestContext<PromptParams>,
): Promise<PromptResponse> => {
	if (session.pending) {
		throw RequestError.invalidRequest(
			undefined,
			"Session already has an active prompt",
		);
	}
	const content = params.prompt;
	const controller = new AbortController();
	session.pending = controller;
	const signal = AbortSignal.any([controller.signal, requestSignal]);
	// Defer invocation so even a synchronous runtime throw sees active assigned.
	session.active = Promise.resolve().then(() =>
		runPrompt(session, { content, signal }, client),
	);
	return session.active;
};

/** Cancel work, wait for settlement, and release every runtime on disconnect. */
export const disposeSessions = async (
	sessions: Iterable<Session>,
): Promise<void> => {
	const rows = [...sessions];
	rows.forEach((session) => session.pending?.abort());
	await Promise.allSettled(rows.map((session) => session.active));
	const results = await Promise.allSettled(
		rows.map(async (session) => session.runtime.dispose()),
	);
	if (results.some((result) => result.status === "rejected")) {
		throw new Error("Failed to dispose agent runtimes");
	}
};
