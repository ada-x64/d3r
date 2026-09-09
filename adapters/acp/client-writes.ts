import { type AgentContext } from "@agentclientprotocol/sdk";
import { waitFor } from "./errors.ts";

/** Issued filesystem mutations retain ownership until the peer settles them or disconnects. */
export const createClientWrites = (
	sessionId: string,
	client: AgentContext,
	connectionSignal: AbortSignal,
) => {
	const pending = new Set<Promise<void>>();
	const state = { unknown: false };
	const disconnected = () => {
		if (pending.size) {
			state.unknown = true;
		}
	};
	connectionSignal.addEventListener("abort", disconnected, { once: true });
	return {
		write: (
			path: string,
			content: string,
			signal: AbortSignal,
		): Promise<void> => {
			signal.throwIfAborted();
			connectionSignal.throwIfAborted();
			// Request cancellation is cooperative. Only disconnect may abandon the response wait.
			const request = client.request(
				"fs/write_text_file",
				{ sessionId, path, content },
				{ cancellationSignal: signal },
			);
			const active = waitFor(request, connectionSignal)
				.then(
					() => {},
					(error: unknown) => {
						if (connectionSignal.aborted) {
							state.unknown = true;
						}
						throw error;
					},
				)
				.finally(() => pending.delete(active));
			pending.add(active);
			void active.catch(() => {});
			return active;
		},
		settle: async (): Promise<void> => {
			await Promise.allSettled(pending);
		},
		hasUnknownOutcome: () => state.unknown,
		dispose: () => {
			connectionSignal.removeEventListener("abort", disconnected);
		},
	};
};
