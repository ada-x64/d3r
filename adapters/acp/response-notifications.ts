import {
	type AnyMessage,
	type AnyNotification,
	type JsonRpcId,
	type Stream,
} from "@agentclientprotocol/sdk";
import { waitFor } from "./errors.ts";

/** Keep session discovery behind its response without timers or a second SDK write queue. */
export const responseNotifications = (stream: Stream) => {
	const pending = new Map<
		JsonRpcId,
		{ notification: AnyNotification; signal: AbortSignal }
	>();
	const lifetime = new AbortController();
	const close = (reason: unknown = new Error("ACP output closed")): void => {
		pending.clear();
		lifetime.abort(reason);
	};
	const writable = new WritableStream<AnyMessage>({
		write: async (message) => {
			try {
				lifetime.signal.throwIfAborted();
				const responseId = "method" in message ? undefined : message.id;
				// The peer may reuse an ID once it receives this response, before its write settles.
				const row =
					responseId === undefined ? undefined : pending.get(responseId);
				if (responseId !== undefined) {
					pending.delete(responseId);
				}
				const writer = stream.writable.getWriter();
				try {
					await waitFor(writer.write(message), lifetime.signal);
					if (row && "result" in message && !row.signal.aborted) {
						lifetime.signal.throwIfAborted();
						await waitFor(writer.write(row.notification), lifetime.signal);
					}
				} finally {
					writer.releaseLock();
				}
			} catch (error) {
				close(error);
				throw error;
			}
		},
		close: async () => {
			close();
			await stream.writable.close();
		},
		abort: async (reason) => {
			close(reason);
			await stream.writable.abort(reason);
		},
	});
	return {
		stream: { readable: stream.readable, writable },
		defer: (
			requestId: JsonRpcId,
			notification: AnyNotification,
			signal: AbortSignal,
		): void => {
			if (!lifetime.signal.aborted && !signal.aborted) {
				pending.set(requestId, {
					notification: structuredClone(notification),
					signal,
				});
			}
		},
		pendingCount: () => pending.size,
		close,
	};
};
