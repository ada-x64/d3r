import {
	type AgentContext,
	type ClientCapabilities,
	type SessionUpdate,
	type TerminalOutputResponse,
	type WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { type RuntimeClientServices } from "@d3r/core/runtime";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { waitFor } from "./errors.ts";
import { createClientWrites } from "./client-writes.ts";
import { createSecretCollection } from "./secrets.ts";

/** Terminal cleanup must not block shutdown on a non-cooperating client. */
const CLEANUP_TIMEOUT_MS = 1000;
/** Bound retained terminal output without depending on client defaults. */
const OUTPUT_BYTE_LIMIT = 1_048_576;
/** Only an accepted form with the expected string field is an answer. */
const answerSchema = z.object({
	action: z.literal("accept"),
	content: z.object({ answer: z.string() }),
});
/** A terminal stays alive until the turn ends so tool updates can embed it before release. */
interface TerminalState {
	readonly id: string;
	exited: boolean;
	cleanup?: Promise<void>;
}
/** Client services retain terminal output as text for replay on a different connection. */
export const createClientServices = (
	sessionId: string,
	client: AgentContext,
	{
		capabilities,
		connectionSignal,
		secrets = [],
	}: {
		capabilities: ClientCapabilities;
		connectionSignal: AbortSignal;
		secrets?: readonly string[];
	},
) => {
	const lifetime = new AbortController();
	const writes = createClientWrites(sessionId, client, connectionSignal);
	const secretCollection = createSecretCollection(secrets);
	const terminals = new Set<TerminalState>();
	const output = new Map<string, string>();
	const signalFor = (signal: AbortSignal) =>
		AbortSignal.any([signal, lifetime.signal, connectionSignal]);
	const checkPath = (path: string) => {
		if (!isAbsolute(path) || path.includes("\0")) {
			throw new Error("Client file paths must be absolute");
		}
	};
	const cleanup = (terminal: TerminalState): Promise<void> => {
		terminal.cleanup ??= (async () => {
			const signal = AbortSignal.any([
				connectionSignal,
				AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
			]);
			const params = { sessionId, terminalId: terminal.id };
			try {
				if (!terminal.exited) {
					await waitFor(
						client.request("terminal/kill", params, {
							cancellationSignal: signal,
						}),
						signal,
					).catch(() => {});
				}
				if (!output.has(terminal.id) && !signal.aborted) {
					const result = await waitFor(
						client.request<TerminalOutputResponse>("terminal/output", params, {
							cancellationSignal: signal,
						}),
						signal,
					).catch(() => null);
					if (result) {
						output.set(terminal.id, result.output);
					}
				}
			} finally {
				// Use a fresh bound so a stalled kill cannot suppress release.
				const releaseSignal = AbortSignal.any([
					connectionSignal,
					AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
				]);
				await waitFor(
					client.request("terminal/release", params, {
						cancellationSignal: releaseSignal,
					}),
					releaseSignal,
				).catch(() => {});
				terminals.delete(terminal);
			}
		})();
		return terminal.cleanup;
	};
	const services: RuntimeClientServices &
		Pick<typeof secretCollection, "registerSecrets"> = {
		registerSecrets: secretCollection.registerSecrets,
		requestPermission: async (request, originalSignal) => {
			const signal = signalFor(originalSignal);
			if (signal.aborted) {
				return false;
			}
			try {
				const result = await waitFor(
					client.request(
						"session/request_permission",
						{
							sessionId,
							toolCall: {
								toolCallId: request.toolCallId,
								title: request.title,
								kind: request.kind,
								rawInput: request.input,
								status: "pending",
							},
							options: [
								{ optionId: "allow", name: "Allow once", kind: "allow_once" },
								{ optionId: "reject", name: "Reject", kind: "reject_once" },
							],
						},
						{ cancellationSignal: signal },
					),
					signal,
				);
				return (
					!signal.aborted &&
					result.outcome.outcome === "selected" &&
					result.outcome.optionId === "allow"
				);
			} catch {
				return false;
			}
		},
		...(capabilities.fs?.readTextFile
			? {
					readTextFile: async (path: string, originalSignal: AbortSignal) => {
						checkPath(path);
						const signal = signalFor(originalSignal);
						signal.throwIfAborted();
						const result = await waitFor(
							client.request(
								"fs/read_text_file",
								{ sessionId, path },
								{ cancellationSignal: signal },
							),
							signal,
						);
						return result.content;
					},
				}
			: {}),
		...(capabilities.fs?.writeTextFile
			? {
					writeTextFile: async (
						path: string,
						content: string,
						originalSignal: AbortSignal,
					) => {
						checkPath(path);
						const signal = signalFor(originalSignal);
						signal.throwIfAborted();
						await writes.write(path, content, signal);
					},
				}
			: {}),
		...(capabilities.terminal
			? {
					runCommand: async (
						command: Parameters<
							NonNullable<RuntimeClientServices["runCommand"]>
						>[0],
						originalSignal: AbortSignal,
					) => {
						checkPath(command.cwd);
						const signal = signalFor(originalSignal);
						signal.throwIfAborted();
						// Retain the actual reply: cancellation may win before the client allocates the terminal.
						const creating = client
							.request(
								"terminal/create",
								{
									sessionId,
									command: command.command,
									args: [...command.args],
									cwd: command.cwd,
									outputByteLimit: OUTPUT_BYTE_LIMIT,
								},
								{ cancellationSignal: signal },
							)
							.then((result) => {
								const terminal: TerminalState = {
									id: result.terminalId,
									exited: false,
								};
								terminals.add(terminal);
								if (signal.aborted) {
									void cleanup(terminal);
								}
								return terminal;
							});
						const terminal = await waitFor(creating, signal);
						try {
							const params = { sessionId, terminalId: terminal.id };
							const exit = await waitFor(
								client.request<WaitForTerminalExitResponse>(
									"terminal/wait_for_exit",
									params,
									{ cancellationSignal: signal },
								),
								signal,
							);
							terminal.exited = true;
							const result = await waitFor(
								client.request<TerminalOutputResponse>(
									"terminal/output",
									params,
									{ cancellationSignal: signal },
								),
								signal,
							);
							output.set(terminal.id, result.output);
							return {
								output: result.output,
								exitCode: exit.exitCode ?? null,
								terminalId: terminal.id,
							};
						} catch (error) {
							await cleanup(terminal);
							throw error;
						}
					},
				}
			: {}),
		ask: async (message, originalSignal) => {
			const signal = signalFor(originalSignal);
			if (!capabilities.elicitation?.form || signal.aborted) {
				return null;
			}
			try {
				const result = answerSchema.safeParse(
					await waitFor(
						client.request(
							"elicitation/create",
							{
								sessionId,
								mode: "form",
								message,
								requestedSchema: {
									type: "object",
									properties: { answer: { type: "string", title: "Answer" } },
									required: ["answer"],
								},
							},
							{ cancellationSignal: signal },
						),
						signal,
					),
				);
				return !signal.aborted && result.success
					? result.data.content.answer
					: null;
			} catch {
				return null;
			}
		},
	};
	const finishTurn = async () => {
		await Promise.all([writes.settle(), ...[...terminals].map(cleanup)]);
	};
	return {
		services,
		secrets: secretCollection.values,
		settleWrites: writes.settle,
		hasUnknownWrites: writes.hasUnknownOutcome,
		finishTurn,
		dispose: async () => {
			lifetime.abort();
			await finishTurn();
			writes.dispose();
		},
		forReplay: (update: SessionUpdate): SessionUpdate => {
			if (
				update.sessionUpdate !== "tool_call" &&
				update.sessionUpdate !== "tool_call_update"
			) {
				return update;
			}
			return {
				...update,
				...(update.content
					? {
							content: update.content.map((item) =>
								item.type === "terminal"
									? {
											type: "content" as const,
											content: {
												type: "text" as const,
												text:
													output.get(item.terminalId) ??
													"[Terminal output unavailable]",
											},
										}
									: item,
							),
						}
					: {}),
			};
		},
	};
};
/** Session-owned bridge state is not persisted. */
export type ClientServices = ReturnType<typeof createClientServices>;
