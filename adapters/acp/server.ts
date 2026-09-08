import { randomUUID } from "node:crypto";

import {
	agent,
	PROTOCOL_VERSION,
	RequestError,
	type AgentConnection,
	type Stream,
} from "@agentclientprotocol/sdk";
import { type CreateRuntimeSession } from "@d3r/core/runtime";
import { disposeSessions, promptSession, type Session } from "./session.ts";
import { parseNewSession, parsePrompt } from "./params.ts";

/** The composition root supplies runtime behavior and the shipped version. */
export interface NativeServerDeps {
	readonly version: string;
	readonly createSession: CreateRuntimeSession;
}

/** Closing the transport aborts work; closed also waits for runtime disposal. */
export interface NativeServer {
	readonly connection: AgentConnection;
	readonly closed: Promise<void>;
}

/** Connect the experimental native server without changing the legacy launcher. */
export const connectNativeServer = (
	stream: Stream,
	deps: NativeServerDeps,
): NativeServer => {
	const state = { initialized: false, closed: false };
	const sessions = new Map<string, Session>();
	const requireReady = (): void => {
		if (!state.initialized || state.closed) {
			throw RequestError.invalidRequest(
				undefined,
				"Connection is not initialized or is closed",
			);
		}
	};
	const getSession = (id: string): Session => {
		requireReady();
		const session = sessions.get(id);
		if (!session) {
			throw RequestError.invalidParams(undefined, "Unknown session");
		}
		return session;
	};
	const connection = agent({ name: "d3r" })
		.onRequest("initialize", () => {
			if (state.initialized || state.closed) {
				throw RequestError.invalidRequest(
					undefined,
					"Connection is already initialized or closed",
				);
			}
			state.initialized = true;
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentInfo: { name: "d3r", title: "D3R", version: deps.version },
				agentCapabilities: {},
				authMethods: [],
			};
		})
		.onRequest("session/new", parseNewSession, ({ params }) => {
			requireReady();
			const sessionId = randomUUID();
			try {
				const runtime = deps.createSession({ sessionId, cwd: params.cwd });
				sessions.set(sessionId, {
					id: sessionId,
					runtime,
					pending: null,
					active: null,
				});
			} catch {
				throw RequestError.internalError(
					undefined,
					"Could not create agent runtime",
				);
			}
			return { sessionId };
		})
		.onRequest("session/prompt", parsePrompt, (context) =>
			promptSession(getSession(context.params.sessionId), context),
		)
		.onNotification("session/cancel", ({ params }) => {
			sessions.get(params.sessionId)?.pending?.abort();
		})
		.connect(stream);
	connection.signal.addEventListener(
		"abort",
		() => {
			state.closed = true;
			sessions.forEach((session) => session.pending?.abort());
		},
		{ once: true },
	);
	const closed = connection.closed.then(async () => {
		try {
			await disposeSessions(sessions.values());
		} finally {
			sessions.clear();
		}
	});
	return { connection, closed };
};
