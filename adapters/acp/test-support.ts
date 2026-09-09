import {
	client,
	ndJsonStream,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	connectNativeServer,
	type NativeServerDeps,
} from "@d3r/adapter-acp/server";
import {
	type OpenRuntimeSession,
	type RuntimeSession,
} from "@d3r/core/runtime";
import { resolve } from "node:path";

/** Host-native absolute paths keep protocol tests portable. */
export const CWD = resolve("workspace-a");
/** Minimal persistent backend, with no model or external service dependencies. */
export const runtime = (): RuntimeSession => ({
	prompt: async () => "completed",
	dispose: async () => {},
	snapshot: () => ({ messages: [] }),
	restore: () => {},
});
/** Build a cancellable fake that cannot settle before the caller aborts it. */
export const waitForAbort = (signal: AbortSignal): Promise<never> =>
	new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
		} else {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		}
	});
/** Control asynchronous boundaries without wall-clock sleeps. */
export const deferred = <T>() => {
	const callbacks: {
		resolve?: (value: T) => void;
		reject?: (error: unknown) => void;
	} = {};
	const promise = new Promise<T>((resolveValue, reject) => {
		callbacks.resolve = resolveValue;
		callbacks.reject = reject;
	});
	return {
		promise,
		resolve: (value: T) => callbacks.resolve!(value),
		reject: (error: unknown) => callbacks.reject!(error),
	};
};
/** Exercise handlers through real newline-delimited byte streams and the SDK. */
export const fixture = (
	createSession: OpenRuntimeSession,
	beforeWrite: () => Promise<void> = async () => {},
	{
		deps = {},
		clientApp = client(),
	}: {
		deps?: Partial<NativeServerDeps>;
		clientApp?: ReturnType<typeof client>;
	} = {},
) => {
	const incoming = new TransformStream<Uint8Array>();
	const outgoing = new TransformStream<Uint8Array>();
	const updates: SessionNotification[] = [];
	const transport = ndJsonStream(outgoing.writable, incoming.readable);
	const writer = transport.writable.getWriter();
	const server = connectNativeServer(
		{
			readable: transport.readable,
			writable: new WritableStream({
				write: async (message) => {
					await beforeWrite();
					await writer.write(message);
				},
			}),
		},
		{ version: "test-version", createSession, ...deps },
	);
	const peer = clientApp
		.onNotification("session/update", ({ params }) => {
			updates.push(params);
		})
		.connect(ndJsonStream(incoming.writable, outgoing.readable));
	return {
		server,
		peer,
		updates,
		initialize: () => peer.agent.request("initialize", { protocolVersion: 1 }),
		newSession: (cwd = CWD) =>
			peer.agent.request("session/new", { cwd, mcpServers: [] }),
		prompt: (sessionId: string) =>
			peer.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "hello" }],
			}),
		close: async () => {
			peer.close();
			server.connection.close();
			await server.closed;
		},
	};
};
