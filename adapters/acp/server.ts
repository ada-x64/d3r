import { randomUUID } from "node:crypto";
import {
	agent,
	PROTOCOL_VERSION,
	RequestError,
	type AgentConnection,
	type AgentContext,
	type AuthMethod,
	type ClientCapabilities,
	type Implementation,
	type Stream,
} from "@agentclientprotocol/sdk";
import { type OpenRuntimeSession } from "@d3r/core/runtime";
import { runtimeError } from "./errors.ts";
import { createNativeSession } from "./lifecycle.ts";
import {
	parseAuthenticate,
	parseConfig,
	parseEmpty,
	parseInitialize,
	parseListSessions,
	parseLoadSession,
	parseNewSession,
	parsePrompt,
	parseResumeSession,
	parseSessionId,
	type SessionParams,
} from "./params.ts";
import { responseNotifications } from "./response-notifications.ts";
import {
	commandUpdate,
	configureSession,
	disposeSession,
	disposeSessions,
	promptSession,
	sessionMetadata,
	type Session,
} from "./session.ts";
import { type SessionStore } from "./store.ts";

export { nativeAuthRequired, type NativeAuthRequiredError } from "./errors.ts";
export {
	createSessionStore,
	type SessionStore,
	type StoredSession,
	type SessionRecord,
} from "./store.ts";
export { runNativeStdio, type NativeStdioDeps } from "./stdio.ts";

/** The composition root owns auth, MCP connections, backend behavior, and shipped metadata. */
export interface NativeServerDeps {
	readonly version: string;
	readonly agentInfo?: Omit<Implementation, "version">;
	readonly createSession: OpenRuntimeSession;
	/** Supplying a store requires every created runtime to support snapshot and restore. */
	readonly store?: SessionStore;
	/** A noninteractive credential check before session requests, not startup or terminal login. */
	readonly authenticate?: () => Promise<void>;
	/** Only terminal entries are advertised, and only to clients that negotiated terminal auth. */
	readonly authMethods?: AuthMethod[];
	readonly logout?: () => Promise<void>;
}
/** Closing the transport aborts work; closed also waits for asynchronous creation and disposal. */
export interface NativeServer {
	readonly connection: AgentConnection;
	readonly closed: Promise<void>;
}

/** Connect the native v1 server without changing the legacy launcher. */
export const connectNativeServer = (
	stream: Stream,
	deps: NativeServerDeps,
): NativeServer => {
	const state = {
		initialized: false,
		closed: false,
		loggingOut: false,
		authEpoch: 0,
		capabilities: {} as ClientCapabilities,
	};
	const output = responseNotifications(stream);
	const sessions = new Map<string, Session>();
	const opening = new Map<
		string,
		{ controller: AbortController; task: Promise<Session> }
	>();
	const operations = new Set<Promise<unknown>>();
	const track = <T>(task: Promise<T>): Promise<T> => {
		operations.add(task);
		void task.finally(() => operations.delete(task)).catch(() => {});
		return task;
	};
	const requireReady = () => {
		if (!state.initialized || state.closed || state.loggingOut) {
			throw RequestError.invalidRequest(
				undefined,
				"Connection is not initialized or is closed",
			);
		}
	};
	const authorize = async () => {
		requireReady();
		const epoch = state.authEpoch;
		try {
			await deps.authenticate?.();
		} catch (error) {
			throw runtimeError(error, "Could not check authentication");
		}
		requireReady();
		if (epoch !== state.authEpoch) {
			throw RequestError.authRequired();
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
	const requireStore = (): SessionStore => {
		if (!deps.store) {
			throw RequestError.methodNotFound("session persistence");
		}
		return deps.store;
	};
	const openSession = (
		id: string,
		params: SessionParams,
		{
			client,
			signal: requestSignal,
			mode,
		}: {
			client: AgentContext;
			signal: AbortSignal;
			mode: "new" | "load" | "resume";
		},
	): Promise<Session> => {
		if (sessions.has(id) || opening.has(id)) {
			throw RequestError.invalidRequest(undefined, "Session is already open");
		}
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			requestSignal,
			connection.signal,
		]);
		const task = Promise.resolve()
			.then(async () => {
				const session = await createNativeSession(
					{
						id,
						params,
						mode,
						client,
						signal,
						connectionSignal: connection.signal,
						capabilities: state.capabilities,
					},
					deps,
				);
				if (signal.aborted) {
					await disposeSession(session);
					throw RequestError.requestCancelled();
				}
				sessions.set(id, session);
				return session;
			})
			.finally(() => opening.delete(id));
		opening.set(id, { controller, task });
		return task;
	};
	const closeSession = async (id: string): Promise<void> => {
		const creating = opening.get(id);
		if (creating) {
			creating.controller.abort();
			await creating.task.catch(() => {});
			return;
		}
		const session = getSession(id);
		try {
			await disposeSession(session);
		} catch {
			throw RequestError.internalError(undefined, "Could not close session");
		} finally {
			sessions.delete(id);
		}
	};
	const connection = agent({ name: deps.agentInfo?.name ?? "d3r" })
		.onRequest("initialize", parseInitialize, ({ params }) => {
			if (state.initialized || state.closed) {
				throw RequestError.invalidRequest(
					undefined,
					"Connection is already initialized or closed",
				);
			}
			state.initialized = true;
			state.capabilities = params.clientCapabilities ?? {};
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentInfo: {
					...(deps.agentInfo ?? { name: "d3r", title: "D3R" }),
					version: deps.version,
				},
				agentCapabilities: {
					promptCapabilities: { image: true, embeddedContext: true },
					mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {
						close: {},
						additionalDirectories: {},
						...(deps.store ? { list: {}, resume: {}, delete: {} } : {}),
					},
					...(deps.store ? { loadSession: true } : {}),
					...(deps.logout ? { auth: { logout: {} } } : {}),
				},
				authMethods: state.capabilities.auth?.terminal
					? (deps.authMethods ?? []).filter(
							(method) => "type" in method && method.type === "terminal",
						)
					: [],
			};
		})
		.onRequest("authenticate", parseAuthenticate, () => {
			requireReady();
			throw RequestError.invalidParams(
				undefined,
				"Terminal authentication must be launched separately by the client",
			);
		})
		.onRequest("logout", parseEmpty, () =>
			track(
				(async () => {
					requireReady();
					if (!deps.logout) {
						throw RequestError.methodNotFound("logout");
					}
					state.loggingOut = true;
					state.authEpoch += 1;
					try {
						opening.forEach((row) => row.controller.abort());
						await Promise.allSettled(
							[...opening.values()].map((row) => row.task),
						);
						await disposeSessions(sessions.values());
						sessions.clear();
						await deps.logout();
						return {};
					} catch (error) {
						throw runtimeError(error, "Could not log out");
					} finally {
						state.loggingOut = false;
					}
				})(),
			),
		)
		.onRequest(
			"session/new",
			parseNewSession,
			({ params, client, signal, requestId }) =>
				track(
					(async () => {
						await authorize();
						const session = await openSession(randomUUID(), params, {
							client,
							signal,
							mode: "new",
						});
						try {
							const response = {
								sessionId: session.id,
								...sessionMetadata(session),
							};
							const update = commandUpdate(session.runtime);
							signal.throwIfAborted();
							if (update) {
								// Clients register a new ID from the response, so earlier updates are lost.
								output.defer(
									requestId,
									{
										jsonrpc: "2.0",
										method: "session/update",
										params: { sessionId: session.id, update },
									},
									signal,
								);
							}
							return response;
						} catch (error) {
							sessions.delete(session.id);
							await disposeSession(session);
							if (signal.aborted) {
								throw RequestError.requestCancelled();
							}
							throw runtimeError(error, "Could not create agent runtime");
						}
					})(),
				),
		)
		.onRequest("session/load", parseLoadSession, ({ params, client, signal }) =>
			track(
				(async () => {
					await authorize();
					requireStore();
					return sessionMetadata(
						await openSession(params.sessionId, params, {
							client,
							signal,
							mode: "load",
						}),
					);
				})(),
			),
		)
		.onRequest(
			"session/resume",
			parseResumeSession,
			({ params, client, signal }) =>
				track(
					(async () => {
						await authorize();
						requireStore();
						return sessionMetadata(
							await openSession(params.sessionId, params, {
								client,
								signal,
								mode: "resume",
							}),
						);
					})(),
				),
		)
		.onRequest("session/list", parseListSessions, ({ params }) =>
			track(
				(async () => {
					await authorize();
					return requireStore().list(params);
				})(),
			),
		)
		.onRequest("session/close", parseSessionId, ({ params }) =>
			track(
				(async () => {
					requireReady();
					await closeSession(params.sessionId);
					return {};
				})(),
			),
		)
		.onRequest("session/delete", parseSessionId, ({ params }) =>
			track(
				(async () => {
					await authorize();
					const store = requireStore();
					if (sessions.has(params.sessionId) || opening.has(params.sessionId)) {
						await closeSession(params.sessionId);
					}
					const release = await store.acquire(params.sessionId);
					try {
						if (!(await store.delete(params.sessionId))) {
							throw RequestError.invalidParams(undefined, "Unknown session");
						}
						return {};
					} finally {
						await release();
					}
				})(),
			),
		)
		.onRequest(
			"session/set_config_option",
			parseConfig,
			({ params, client, signal }) =>
				track(
					(async () => {
						await authorize();
						return configureSession(
							getSession(params.sessionId),
							{ id: params.configId, value: params.value },
							{ client, signal },
						);
					})(),
				),
		)
		.onRequest("session/prompt", parsePrompt, (context) =>
			track(
				promptSession(getSession(context.params.sessionId), context, authorize),
			),
		)
		.onNotification("session/cancel", parseSessionId, ({ params }) => {
			sessions.get(params.sessionId)?.pending?.abort();
			opening.get(params.sessionId)?.controller.abort();
		})
		.connect(output.stream);
	const abort = () => {
		state.closed = true;
		output.close(connection.signal.reason);
		opening.forEach((row) => row.controller.abort());
		sessions.forEach((session) => session.pending?.abort());
	};
	connection.signal.addEventListener("abort", abort, { once: true });
	if (connection.signal.aborted) {
		abort();
	}
	const closed = connection.closed.then(async () => {
		await Promise.allSettled(operations);
		try {
			await disposeSessions(sessions.values());
		} finally {
			sessions.clear();
		}
	});
	return { connection, closed };
};
