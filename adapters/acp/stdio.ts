import { Readable, type Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { connectNativeServer, type NativeServerDeps } from "./server.ts";

/** Optional Node streams and signal emitter make the CLI shell testable without global mutation. */
export interface NativeStdioDeps extends NativeServerDeps {
	readonly stdin?: Readable;
	readonly stdout?: Writable;
	readonly signals?: {
		readonly on: (
			signal: "SIGINT" | "SIGTERM",
			listener: () => void,
		) => unknown;
		readonly off: (
			signal: "SIGINT" | "SIGTERM",
			listener: () => void,
		) => unknown;
	};
}
/** Conventional shell exit statuses for handled process signals. */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;
/** Serve real NDJSON only on stdout; the caller owns logging, startup auth, and process.exitCode. */
export const runNativeStdio = async (
	deps: NativeStdioDeps,
): Promise<number> => {
	const input = deps.stdin ?? process.stdin;
	const output = deps.stdout ?? process.stdout;
	const signals = deps.signals ?? process;
	let code = 0;
	const bytes = new WritableStream<Uint8Array>({
		write: (chunk) =>
			new Promise<void>((resolve, reject) => {
				output.write(chunk, (error) => (error ? reject(error) : resolve()));
			}),
	});
	const stream = ndJsonStream(bytes, Readable.toWeb(input));
	const reader = stream.readable.getReader();
	const server = connectNativeServer(
		{
			writable: stream.writable,
			readable: new ReadableStream({
				pull: async (controller) => {
					try {
						const result = await reader.read();
						if (result.done) {
							controller.close();
						} else {
							controller.enqueue(result.value);
						}
					} catch (error) {
						if (code === 0) {
							code = 1;
						}
						controller.error(error);
					}
				},
				cancel: async () => {
					await reader.cancel().catch(() => {});
				},
			}),
		},
		deps,
	);
	const failed = () => {
		if (code === 0) {
			code = 1;
		}
		server.connection.close();
	};
	const interrupt = () => {
		code = SIGNAL_EXIT.SIGINT;
		server.connection.close();
	};
	const terminate = () => {
		code = SIGNAL_EXIT.SIGTERM;
		server.connection.close();
	};
	input.on("error", failed);
	output.on("error", failed);
	signals.on("SIGINT", interrupt);
	signals.on("SIGTERM", terminate);
	try {
		await server.closed;
	} catch {
		code = 1;
	} finally {
		input.off("error", failed);
		output.off("error", failed);
		signals.off("SIGINT", interrupt);
		signals.off("SIGTERM", terminate);
		input.pause();
	}
	return code;
};
