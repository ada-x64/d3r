import {
	client,
	RequestError,
	type AgentContext,
} from "@agentclientprotocol/sdk";
import {
	createSessionStore,
	type StoredSession,
} from "@d3r/adapter-acp/server";
import {
	createRuntimeFailure,
	readRuntimeFailure,
	type RuntimePrompt,
	type RuntimeSessionInput,
} from "@d3r/core/runtime";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ClientServices,
	type createClientServices as CreateClientServices,
} from "./client.ts";
import {
	type Session,
	type checkpointSession as CheckpointSession,
	type promptSession as PromptSession,
} from "./session.ts";
import { CWD, deferred, fixture, runtime } from "./test-support.ts";

/** These are synthetic secrets, never loaded from credentials or private sessions. */
const CANARY = "Bearer synthetic-finalization-secret /private/synthetic-config";
/** All durability failures use the same public precedence, regardless of secondary diagnostics. */
const FINALIZATION_MESSAGE =
	"Internal error: Could not finalize session; session needs recovery";

/** Include the nonenumerable message when checking the actual ACP error surface. */
const expectSafeError = (error: unknown): void => {
	expect(error).toBeInstanceOf(RequestError);
	const response = error as RequestError;
	expect(
		JSON.stringify({ message: response.message, data: response.data }),
	).not.toMatch(
		/synthetic-finalization-secret|\/private\/synthetic-config|Bearer|stack|headers/,
	);
};

/** Optional undefined properties disappear at the JSON-RPC boundary. */
const wireFailure = (primary: unknown): unknown =>
	Object.fromEntries(
		Object.entries(readRuntimeFailure(primary)!).filter(
			([, value]) => value !== undefined,
		),
	);

/** Keep rejection capture separate from assertions so a failed assertion cannot become a result. */
const captureError = (error: unknown): unknown => error;

/** Use real ACP writes and durable intents; inject faults only at owned finalization boundaries. */
describe("native session finalization failures", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const directories: string[] = [];
	let implementation:
		| [
				{ createClientServices: typeof CreateClientServices },
				{
					checkpointSession: typeof CheckpointSession;
					promptSession: typeof PromptSession;
				},
		  ]
		| undefined = undefined;
	beforeAll(async ({ file }) => {
		expect(["src", "dist"]).toContain(file.projectName);
		// Relative imports are not covered by the fixture's package aliases. Match both
		// the factory spy and direct boundary calls to the project's server graph.
		implementation = await (file.projectName === "dist"
			? Promise.all([import("./dist/client.js"), import("./dist/session.js")])
			: Promise.all([import("./client.ts"), import("./session.ts")]));
	});
	const setup = async (
		fault: "metadata" | "config" | "snapshot" | "save" | "none",
		outcome: "classified" | "unclassified" | "completed" = "classified",
		detached = false,
	) => {
		const dir = await mkdtemp(join(tmpdir(), "d3r-finalization-"));
		directories.push(dir);
		const store = createSessionStore(dir);
		const file = join(dir, "effect.txt");
		const writeGate = deferred<void>();
		const issued = deferred<void>();
		const saveGate = deferred<void>();
		const saving = deferred<void>();
		const events: string[] = [];
		let effects = 0;
		let prompted = false;
		let metadataPending = true;
		const primary = createRuntimeFailure({
			stage: "model_request",
			category: "access",
			httpStatus: 403,
			code: "permission_error",
			provider: "configured-provider",
			model: "configured-model",
			toolsStarted: true,
		});
		const [clientServices, { checkpointSession, promptSession }] =
			implementation!;
		const createServices = clientServices.createClientServices;
		let owned: ClientServices | undefined = undefined;
		let peerClient: AgentContext | undefined = undefined;
		const factory = vi
			.spyOn(clientServices, "createClientServices")
			.mockImplementation((...args) => {
				[, peerClient] = args;
				owned = createServices(...args);
				return owned;
			});
		const snapshot = vi.fn(() => {
			events.push("snapshot");
			if (prompted && fault === "snapshot") {
				throw new Error(CANARY);
			}
			return { effects };
		});
		const backend = (input: RuntimeSessionInput) => ({
			...runtime(),
			snapshot,
			getConfig: () => {
				if (
					prompted &&
					(fault === "config" || (fault === "metadata" && metadataPending))
				) {
					metadataPending = false;
					throw new Error(CANARY);
				}
				return [];
			},
			prompt: async (request: RuntimePrompt) => {
				const writing = input.client!.writeTextFile!(
					file,
					"effect\n",
					request.signal,
				);
				if (detached) {
					void writing.catch(() => {});
				} else {
					await writing;
				}
				prompted = true;
				if (outcome !== "completed") {
					throw outcome === "classified" ? primary : new Error(CANARY);
				}
				return "completed" as const;
			},
		});
		const f = fixture(backend, async () => {}, {
			deps: {
				store: {
					...store,
					save: async (row) => {
						if (prompted && row.records.at(-1)?.kind === "checkpoint") {
							events.push("save");
							if (fault === "save") {
								saving.resolve();
								await saveGate.promise;
								throw new Error(CANARY);
							}
						}
						await store.save(row);
					},
				},
			},
			clientApp: client().onRequest(
				"fs/write_text_file",
				async ({ params }) => {
					issued.resolve();
					await writeGate.promise;
					await appendFile(params.path, params.content);
					effects += 1;
					events.push("write");
					return {};
				},
			),
		});
		cleanup.push(async () => {
			writeGate.resolve();
			saveGate.resolve();
			await f.close();
		});
		await f.peer.agent.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { writeTextFile: true } },
		});
		const { sessionId } = await f.newSession();
		expect(factory).toHaveBeenCalledTimes(1);
		events.length = 0;
		snapshot.mockClear();
		return {
			f,
			store,
			dir,
			file,
			sessionId,
			primary,
			owned: owned!,
			peerClient: peerClient!,
			checkpointSession,
			promptSession,
			snapshot,
			events,
			writeGate,
			issued,
			saveGate,
			saving,
		};
	};
	const sessionState = (s: Awaited<ReturnType<typeof setup>>): Session => ({
		id: s.sessionId,
		cwd: CWD,
		additionalDirectories: [],
		runtime: runtime(),
		services: s.owned,
		secrets: [],
		records: [],
		tools: new Set(),
		pending: null,
		active: null,
		closing: false,
		failed: false,
	});
	const expectIncomplete = async (s: Awaited<ReturnType<typeof setup>>) => {
		await expect(s.store.get(s.sessionId)).rejects.toMatchObject({
			code: -32_603,
		});
		const disk: StoredSession = JSON.parse(
			await readFile(join(s.dir, `${s.sessionId}.json`), "utf8"),
		);
		expect(disk.records.at(-1)).toEqual({
			kind: "intent",
			operation: "prompt",
		});
		expect(JSON.stringify(disk)).not.toContain("synthetic-finalization-secret");
		await expect(s.f.prompt(s.sessionId)).rejects.toMatchObject({
			code: -32_600,
			message: expect.stringContaining("needs recovery"),
		});
	};
	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((close) => close()));
		vi.restoreAllMocks();
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it.each(["classified", "unclassified", "completed"] as const)(
		"checkpoints effects despite a metadata getter failure after a %s turn",
		async (outcome) => {
			const s = await setup("metadata", outcome);
			const pending = s.f.prompt(s.sessionId).catch((error: unknown) => error);
			await s.issued.promise;
			s.writeGate.resolve();
			const error = await pending;
			expectSafeError(error);
			expect(error).toMatchObject({
				code: -32_603,
				message: {
					classified: `Internal error: ${s.primary.message}`,
					completed: "Internal error: Could not publish session configuration",
					unclassified: "Internal error: Agent runtime failed",
				}[outcome],
			});
			if (outcome === "classified") {
				expect(error).toMatchObject({
					data: { failure: wireFailure(s.primary) },
				});
			}
			expect(s.events).toEqual(["write", "snapshot", "save"]);
			expect(await readFile(s.file, "utf8")).toBe("effect\n");
			const saved = await s.store.get(s.sessionId);
			expect(saved?.records.at(-1)).toMatchObject({
				kind: "checkpoint",
				state: { runtime: { effects: 1 }, config: [] },
			});
			// The failure was reporting-only: a later explicit prompt is not rejected as recovery-only.
			const next = await s.f.prompt(s.sessionId).catch(captureError);
			if (outcome === "completed") {
				expect(next).toEqual({ stopReason: "end_turn" });
			} else {
				expect(next).toMatchObject({ code: -32_603 });
			}
		},
	);

	it.each([false, true])(
		"sanitizes a metadata output rejection after checkpointing (primary=%s)",
		async (hasPrimary) => {
			const s = await setup("none");
			const before = await s.store.get(s.sessionId);
			const state: Session = {
				...sessionState(s),
				store: s.store,
				records: [...before!.records],
				runtime: {
					...runtime(),
					getConfig: () => [],
					prompt: async () => {
						if (hasPrimary) {
							throw s.primary;
						}
						return "completed";
					},
					snapshot: () => ({ finalized: true }),
				},
			};
			const notify = vi
				.spyOn(s.peerClient, "notify")
				.mockRejectedValueOnce(new Error(CANARY));
			const error = await s
				.promptSession(state, {
					requestId: "output-failure",
					params: {
						sessionId: s.sessionId,
						prompt: [{ type: "text", text: "hello" }],
					},
					signal: new AbortController().signal,
					client: s.peerClient,
				})
				.catch(captureError);
			expectSafeError(error);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(error).toMatchObject({
				code: -32_603,
				message: hasPrimary
					? `Internal error: ${s.primary.message}`
					: "Internal error: Could not publish session configuration",
			});
			if (hasPrimary) {
				expect(error).toMatchObject({
					data: { failure: wireFailure(s.primary) },
				});
			}
			expect(state.failed).toBe(false);
			const saved = await s.store.get(s.sessionId);
			expect(saved?.records.slice(0, before!.records.length)).toEqual(
				before!.records,
			);
			expect(saved?.records.at(-1)).toMatchObject({
				kind: "checkpoint",
				state: { runtime: { finalized: true } },
			});
		},
	);

	it("honors cancellation after safe checkpointing despite a metadata failure", async () => {
		const s = await setup("metadata");
		const settled = vi.fn();
		const pending = s.f.prompt(s.sessionId).then((response) => {
			settled();
			return response;
		});
		await s.issued.promise;
		await s.f.peer.agent.notify("session/cancel", { sessionId: s.sessionId });
		await s.f.peer.agent.request("session/list", {});
		expect(settled).not.toHaveBeenCalled();
		expect(s.snapshot).not.toHaveBeenCalled();
		s.writeGate.resolve();
		await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
		expect(await readFile(s.file, "utf8")).toBe("effect\n");
		const saved = await s.store.get(s.sessionId);
		expect(saved?.records.at(-1)).toMatchObject({
			kind: "checkpoint",
			state: { runtime: { effects: 1 } },
		});
	});

	it.each(["snapshot", "config", "save"] as const)(
		"prioritizes a %s checkpoint failure over the classified primary and retains intent after effects",
		async (fault) => {
			const s = await setup(fault);
			s.saveGate.resolve();
			const pending = s.f.prompt(s.sessionId).catch((error: unknown) => error);
			await s.issued.promise;
			s.writeGate.resolve();
			const error = await pending;
			expectSafeError(error);
			expect(error).toMatchObject({
				code: -32_603,
				message: FINALIZATION_MESSAGE,
				data: { failure: wireFailure(s.primary) },
			});
			expect(s.snapshot).toHaveBeenCalledTimes(1);
			expect(await readFile(s.file, "utf8")).toBe("effect\n");
			await expectIncomplete(s);
		},
	);

	it.each(["session", "request"] as const)(
		"does not turn failed durability into a normal %s cancellation result",
		async (mode) => {
			const s = await setup("save");
			const controller = new AbortController();
			const pending = s.f.peer.agent
				.request(
					"session/prompt",
					{ sessionId: s.sessionId, prompt: [{ type: "text", text: "hello" }] },
					{ cancellationSignal: controller.signal },
				)
				.catch(captureError);
			await s.issued.promise;
			s.writeGate.resolve();
			await s.saving.promise;
			if (mode === "session") {
				await s.f.peer.agent.notify("session/cancel", {
					sessionId: s.sessionId,
				});
			} else {
				controller.abort();
			}
			await s.f.peer.agent.request("session/list", {});
			s.saveGate.resolve();
			const error = await pending;
			expectSafeError(error);
			expect(error).toMatchObject({
				code: -32_603,
				message: FINALIZATION_MESSAGE,
			});
			await expectIncomplete(s);
		},
	);

	it("joins an owned write after finishTurn rejects, but never completes the unsafe checkpoint even on cancellation", async () => {
		const s = await setup("metadata", "classified", true);
		const finishing = deferred<void>();
		vi.spyOn(s.owned, "finishTurn").mockImplementationOnce(async () => {
			finishing.resolve();
			throw new Error(CANARY);
		});
		const settle = vi.spyOn(s.owned, "settleWrites");
		const settled = vi.fn();
		const pending = s.f
			.prompt(s.sessionId)
			.catch((error: unknown) => error)
			.then((result) => {
				settled();
				return result;
			});
		await Promise.all([s.issued.promise, finishing.promise]);
		await s.f.peer.agent.notify("session/cancel", { sessionId: s.sessionId });
		await s.f.peer.agent.request("session/list", {});
		expect(settled).not.toHaveBeenCalled();
		expect(s.snapshot).not.toHaveBeenCalled();
		await expect(s.store.get(s.sessionId)).rejects.toMatchObject({
			code: -32_603,
		});
		s.writeGate.resolve();
		const error = await pending;
		expectSafeError(error);
		expect(error).toMatchObject({
			code: -32_603,
			message: FINALIZATION_MESSAGE,
			data: { failure: wireFailure(s.primary) },
		});
		expect(settle).toHaveBeenCalledTimes(1);
		expect(s.events).toEqual(["write"]);
		expect(await readFile(s.file, "utf8")).toBe("effect\n");
		await expectIncomplete(s);
	});

	it.each(["settlement", "unknown"] as const)(
		"does not checkpoint or acknowledge cancellation after a client-write %s failure",
		async (fault) => {
			const s = await setup("none", "classified", true);
			if (fault === "settlement") {
				vi.spyOn(s.owned, "settleWrites").mockRejectedValueOnce(
					new Error(CANARY),
				);
			} else {
				vi.spyOn(s.owned, "hasUnknownWrites").mockReturnValueOnce(true);
			}
			const pending = s.f.prompt(s.sessionId).catch((error: unknown) => error);
			await s.issued.promise;
			await s.f.peer.agent.notify("session/cancel", { sessionId: s.sessionId });
			await s.f.peer.agent.request("session/list", {});
			expect(s.snapshot).not.toHaveBeenCalled();
			s.writeGate.resolve();
			const error = await pending;
			expectSafeError(error);
			expect(error).toMatchObject({
				code: -32_603,
				message: FINALIZATION_MESSAGE,
			});
			expect(s.events).toEqual(["write"]);
			expect(await readFile(s.file, "utf8")).toBe("effect\n");
			await expectIncomplete(s);
		},
	);

	it.each(["settleWrites", "hasUnknownWrites"] as const)(
		"sanitizes %s throws at checkpointSession itself, including without a store",
		async (method) => {
			const s = await setup("none");
			vi.spyOn(s.owned, method).mockImplementation(() => {
				throw new Error(CANARY);
			});
			const session = sessionState(s);
			const error = await s.checkpointSession(session).catch(captureError);
			expectSafeError(error);
			expect(error).toMatchObject({
				code: -32_603,
				message:
					"Internal error: Could not settle client writes; session needs recovery",
			});
			expect(session.failed).toBe(true);
		},
	);
});
