import {
	RequestError,
	type AgentContext,
	type AgentRequestContext,
	type PromptResponse,
	type SessionUpdate,
	type StopReason,
} from "@agentclientprotocol/sdk";
import { type RuntimeSession, type RuntimeStopReason } from "@d3r/core/runtime";
import { type ClientServices } from "./client.ts";
import { configOptions, readRuntimeConfig } from "./config.ts";

import { runtimeError, waitFor } from "./errors.ts";
import { type PromptParams } from "./params.ts";
import { runTurn } from "./turn.ts";
import { beginSessionMutation, storedSession } from "./persistence.ts";
import {
	redactSessionData,
	type SessionRecord,
	type SessionStore,
} from "./store.ts";

export { configOptions } from "./config.ts";

/** Live resources and the ordered transcript are owned by exactly one connection/lease. */
export interface Session {
	readonly id: string;
	readonly cwd: string;
	readonly additionalDirectories: readonly string[];
	readonly runtime: RuntimeSession;
	readonly services: ClientServices;
	readonly store?: SessionStore;
	readonly release?: () => Promise<void>;
	readonly secrets: readonly string[];
	records: SessionRecord[];
	readonly tools: Set<string>;
	pending: AbortController | null;
	active: Promise<unknown> | null;
	closing: boolean;
	failed: boolean;
	disposal?: Promise<void>;
}
/** Translate loop outcomes without leaking provider-specific stop reasons. */
const STOP_REASONS: Record<RuntimeStopReason, StopReason> = {
	completed: "end_turn",
	token_limit: "max_tokens",
	request_limit: "max_turn_requests",
	refused: "refusal",
	cancelled: "cancelled",
};

/** No configuration metadata is advertised when the runtime does not provide it. */
export const sessionMetadata = (session: Session) => {
	const config = readRuntimeConfig(session.runtime);
	return config ? { configOptions: configOptions(config) } : {};
};
/** Append a detached checkpoint only after runtime mutation and callbacks have settled. */
export const checkpointSession = async (session: Session): Promise<void> => {
	await session.services.settleWrites();
	if (session.services.hasUnknownWrites()) {
		session.failed = true;
		throw RequestError.internalError(
			undefined,
			"Cannot checkpoint an unknown client write outcome",
		);
	}
	if (!session.store) {
		return;
	}
	try {
		const snapshot = session.runtime.snapshot!();
		if (snapshot === undefined) {
			throw new Error("Missing runtime checkpoint");
		}
		const records: SessionRecord[] = session.records.map((record) =>
			record.kind === "update"
				? { kind: "update", update: session.services.forReplay(record.update) }
				: record,
		);
		records.push({
			kind: "checkpoint",
			state: {
				runtime: snapshot,
				config:
					readRuntimeConfig(session.runtime)?.map(({ id, value }) => ({
						id,
						value,
					})) ?? [],
			},
		});
		const safe = redactSessionData(records, session.secrets);
		await session.store.save({ ...storedSession(session), records: safe });
		session.records = safe;
	} catch {
		session.failed = true;
		throw RequestError.internalError(undefined, "Could not checkpoint session");
	}
};
/** Detach the runtime's command menu using the same mapping for setup and later turns. */
export const commandUpdate = (
	runtime: RuntimeSession,
): SessionUpdate | undefined =>
	runtime.getCommands
		? {
				sessionUpdate: "available_commands_update",
				availableCommands: runtime
					.getCommands()
					.map(({ name, description, inputHint }) => ({
						name,
						description,
						...(inputHint === undefined ? {} : { input: { hint: inputHint } }),
					})),
			}
		: undefined;
/** Load/resume already have a known ID; new sessions publish only after their response. */
export const publishCommands = async (
	session: Session,
	client: AgentContext,
	signal: AbortSignal,
): Promise<void> => {
	if (signal.aborted) {
		return;
	}
	const update = commandUpdate(session.runtime);
	if (!update) {
		return;
	}
	await waitFor(
		client.notify("session/update", { sessionId: session.id, update }),
		signal,
	);
};

/** Phase/model selectors may change autonomously during the turn, not only through set_config_option. */
const publishConfig = async (
	session: Session,
	client: AgentContext,
	signal: AbortSignal,
): Promise<void> => {
	const config = readRuntimeConfig(session.runtime);
	if (!config) {
		return;
	}
	const update: SessionUpdate = {
		sessionUpdate: "config_option_update",
		configOptions: configOptions(config),
	};
	if (session.store) {
		session.records.push({ kind: "update", update });
	}
	try {
		// Even a cancelled turn can change phase. Queue metadata before its response without stalling cancellation.
		await waitFor(
			client.notify("session/update", { sessionId: session.id, update }),
			signal,
		);
	} catch (error) {
		if (!signal.aborted) {
			throw error;
		}
	}
};

/** Reserve mutation synchronously so overlapping prompt/config/close requests cannot race. */
export const exclusiveSession = <T>(
	session: Session,
	requestSignal: AbortSignal,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
	if (session.closing || session.failed || session.active) {
		throw RequestError.invalidRequest(
			undefined,
			"Session is busy, closed, or needs recovery",
		);
	}
	const controller = new AbortController();
	session.pending = controller;
	const signal = AbortSignal.any([controller.signal, requestSignal]);
	const active = Promise.resolve()
		.then(() => operation(signal))
		.finally(() => {
			controller.abort();
			session.pending = null;
			session.active = null;
		});
	session.active = active;
	return active;
};
/** Run a turn, retain its complete transcript, and stop accepting callbacks before checkpointing. */
export const promptSession = (
	session: Session,
	{ params, signal: requestSignal, client }: AgentRequestContext<PromptParams>,
	authorize?: () => Promise<void>,
): Promise<PromptResponse> =>
	exclusiveSession(session, requestSignal, async (signal) => {
		try {
			if (authorize) {
				await waitFor(authorize(), signal);
			}
		} catch (error) {
			if (signal.aborted) {
				return { stopReason: "cancelled" };
			}
			throw error;
		}
		if (signal.aborted) {
			return { stopReason: "cancelled" };
		}
		await beginSessionMutation(session, "prompt");
		let outcome: { reason: RuntimeStopReason } | { error: unknown } = {
			reason: "cancelled",
		};
		try {
			if (!signal.aborted) {
				outcome = {
					reason: await runTurn(session, { params, signal, client }),
				};
				await publishCommands(session, client, signal);
			}
		} catch (error) {
			outcome = { error };
		} finally {
			await session.services.finishTurn();
			try {
				await publishConfig(session, client, signal);
			} finally {
				await checkpointSession(session);
			}
		}
		if (signal.aborted) {
			return { stopReason: "cancelled" };
		}
		if ("error" in outcome) {
			throw runtimeError(outcome.error, "Agent runtime failed");
		}
		return { stopReason: STOP_REASONS[outcome.reason] };
	});
/** Strictly check IDs and enumerated values before the backend can mutate anything. */
export const configureSession = (
	session: Session,
	{ id, value }: { id: string; value: string },
	{
		client,
		signal: requestSignal,
	}: { client: AgentContext; signal: AbortSignal },
) =>
	exclusiveSession(session, requestSignal, async (signal) => {
		const current = readRuntimeConfig(session.runtime);
		const option = current?.find((row) => row.id === id);
		if (
			!session.runtime.setConfig ||
			!option ||
			!option.options.some((row) => row.value === value)
		) {
			throw RequestError.invalidParams(
				undefined,
				"Unknown configuration option or value",
			);
		}
		signal.throwIfAborted();
		await beginSessionMutation(session, "config");
		try {
			signal.throwIfAborted();
			const config = await session.runtime.setConfig(id, value);
			const update: SessionUpdate = {
				sessionUpdate: "config_option_update",
				configOptions: configOptions(config),
			};
			if (session.store) {
				session.records.push({ kind: "update", update });
			}
			await waitFor(
				client.notify("session/update", { sessionId: session.id, update }),
				signal,
			);
			return { configOptions: update.configOptions };
		} catch (error) {
			throw runtimeError(error, "Could not update session configuration");
		} finally {
			await checkpointSession(session);
		}
	});
/** Disposal is idempotent and waits for the last checkpoint before releasing the lease. */
export const disposeSession = (session: Session): Promise<void> => {
	session.closing = true;
	session.pending?.abort();
	session.disposal ??= (async () => {
		await Promise.allSettled([session.active]);
		try {
			try {
				await session.services.dispose();
			} finally {
				await session.runtime.dispose();
			}
		} finally {
			await session.release?.();
		}
	})();
	return session.disposal;
};
/** Cancel every session first, then release idle and active runtimes after settlement. */
export const disposeSessions = async (
	sessions: Iterable<Session>,
): Promise<void> => {
	const rows = [...sessions];
	rows.forEach((session) => session.pending?.abort());
	const results = await Promise.allSettled(rows.map(disposeSession));
	if (results.some((result) => result.status === "rejected")) {
		throw new Error("Failed to dispose agent runtimes");
	}
};
