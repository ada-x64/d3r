import {
	RequestError,
	type AgentContext,
	type ClientCapabilities,
} from "@agentclientprotocol/sdk";
import {
	type OpenRuntimeSession,
	type RuntimeSession,
} from "@d3r/core/runtime";
import { z } from "zod";
import { createClientServices, type ClientServices } from "./client.ts";
import { runtimeError, waitFor } from "./errors.ts";
import { type SessionParams } from "./params.ts";
import { writeMutationIntent } from "./persistence.ts";
import { mcpSecrets } from "./secrets.ts";
import { readRuntimeConfig, validateRestoreConfig } from "./config.ts";
import {
	checkpointSession,
	disposeSession,
	publishCommands,
	type Session,
} from "./session.ts";
import { type SessionStore, type StoredSession } from "./store.ts";

/** Session setup carries request cancellation separately from the connection lifetime. */
export interface SessionOpenRequest {
	readonly id: string;
	readonly params: SessionParams;
	readonly mode: "new" | "load" | "resume";
	readonly client: AgentContext;
	readonly signal: AbortSignal;
	readonly connectionSignal: AbortSignal;
	readonly capabilities: ClientCapabilities;
}
/** Resources acquired before session publication need the same rollback on every failure. */
interface OpeningResources {
	readonly services: ClientServices;
	readonly release?: () => Promise<void>;
	runtime?: RuntimeSession;
	history?: StoredSession;
	session?: Session;
}
/** Checkpoint envelopes separate runtime/model state from optional selector values. */
const checkpointSchema = z.object({
	runtime: z.unknown().refine((value) => value !== undefined),
	config: z.array(z.object({ id: z.string(), value: z.string() })),
});
/** Only a final checkpoint can certify that all replayed updates belong to restored state. */
const finalCheckpoint = (stored: StoredSession) => {
	const last = stored.records.at(-1);
	if (last?.kind !== "checkpoint") {
		throw new Error("Stored session is incomplete");
	}
	return checkpointSchema.parse(last.state);
};
/** Lock and validate persisted state before starting a backend or emitting any replay. */
const acquireSession = async (
	request: SessionOpenRequest,
	store?: SessionStore,
) => {
	let release: (() => Promise<void>) | undefined = undefined;
	try {
		request.signal.throwIfAborted();
		release = await store?.acquire(request.id);
		const stored = request.mode === "new" ? null : await store?.get(request.id);
		if (
			request.mode !== "new" &&
			(!stored || stored.cwd !== request.params.cwd)
		) {
			throw RequestError.invalidParams(
				undefined,
				"Unknown session or cwd mismatch",
			);
		}
		if (stored) {
			finalCheckpoint(stored);
		}
		request.signal.throwIfAborted();
		return { release, stored };
	} catch (error) {
		await release?.();
		if (request.signal.aborted) {
			throw RequestError.requestCancelled();
		}
		if (error instanceof RequestError) {
			throw error;
		}
		throw runtimeError(error, "Could not read stored session");
	}
};
/** Optional backend preflight must reject incompatible checkpoints without applying effects. */
type RestorableRuntime = RuntimeSession & {
	readonly validateRestore?: (checkpoint: unknown) => void;
};
/** Restore state without rerunning historical prompts or tools. */
const restoreSession = async (
	runtime: RestorableRuntime,
	stored: StoredSession,
	{ signal, store }: { signal: AbortSignal; store?: SessionStore },
) => {
	const state = finalCheckpoint(stored);
	if (!runtime.restore || (state.config.length && !runtime.getConfig)) {
		throw new Error("Runtime cannot restore sessions");
	}
	signal.throwIfAborted();
	runtime.validateRestore?.(state.runtime);
	validateRestoreConfig(
		runtime,
		state.config,
		runtime.validateRestore ? "selectors" : "available",
	);
	signal.throwIfAborted();
	const history = store
		? await writeMutationIntent(store, stored, "restore")
		: stored;
	if (signal.aborted) {
		// No runtime mutation has begun; undo only our own intent, never a partially applied restore.
		if (store) {
			await store.save(stored);
		}
		signal.throwIfAborted();
	}
	runtime.restore(state.runtime);
	// Runtime snapshots may omit selector state; restore it through the runtime's own API.
	await state.config.reduce(async (previous, option) => {
		await previous;
		const current = readRuntimeConfig(runtime)?.find(
			(row) => row.id === option.id,
		);
		if (!current) {
			throw new Error("Stored configuration is unavailable");
		}
		if (current.value !== option.value) {
			if (
				!runtime.setConfig ||
				!current.options.some((row) => row.value === option.value)
			) {
				throw new Error("Stored configuration cannot be restored");
			}
			await runtime.setConfig(option.id, option.value);
		}
	}, Promise.resolve());
	validateRestoreConfig(runtime, state.config, "selected");
	return history;
};
/** Backend errors may contain credentials; sanitize them before setup rollback. */
const initializeRuntime = async (
	resources: OpeningResources,
	request: SessionOpenRequest,
	{
		createSession,
		store,
		stored,
	}: {
		createSession: OpenRuntimeSession;
		store?: SessionStore;
		stored?: StoredSession | null;
	},
): Promise<RuntimeSession> => {
	try {
		const runtime = await createSession({
			sessionId: request.id,
			cwd: request.params.cwd,
			signal: request.signal,
			additionalDirectories: request.params.additionalDirectories,
			mcpServers: request.params.mcpServers,
			client: resources.services.services,
		});
		resources.runtime = runtime;
		if (store && (!runtime.snapshot || !runtime.restore)) {
			throw new Error("Persistent runtimes require snapshot and restore");
		}
		readRuntimeConfig(runtime);
		request.signal.throwIfAborted();
		if (stored) {
			resources.history = await restoreSession(runtime, stored, {
				signal: request.signal,
				store,
			});
		}
		return runtime;
	} catch (error) {
		throw runtimeError(error, "Could not create or restore agent runtime");
	}
};
/** Commit settled restoration before replay, which may be cancelled without further mutations. */
const activateSession = async (
	session: Session,
	request: SessionOpenRequest,
) => {
	await checkpointSession(session);
	request.signal.throwIfAborted();
	if (request.mode === "load") {
		await session.records.reduce(async (previous, record) => {
			await previous;
			request.signal.throwIfAborted();
			if (record.kind === "update") {
				await waitFor(
					request.client.notify("session/update", {
						sessionId: session.id,
						update: record.update,
					}),
					request.signal,
				);
			}
		}, Promise.resolve());
	}
	await publishCommands(session, request.client, request.signal);
	request.signal.throwIfAborted();
};
/** Even setup failures release all resources, including a runtime whose restoration failed. */
const rollbackSession = async (resources: OpeningResources) => {
	if (resources.session) {
		await disposeSession(resources.session);
		return;
	}
	try {
		try {
			await resources.services.dispose();
		} finally {
			await resources.runtime?.dispose();
		}
	} finally {
		await resources.release?.();
	}
};
/** Open one isolated session; the server publishes it only after setup has fully settled. */
export const createNativeSession = async (
	request: SessionOpenRequest,
	deps: { createSession: OpenRuntimeSession; store?: SessionStore },
): Promise<Session> => {
	const initialSecrets = mcpSecrets(request.params);
	const { release, stored } = await acquireSession(request, deps.store);
	const { id, params, client, signal } = request;
	const services = createClientServices(id, client, {
		capabilities: request.capabilities,
		connectionSignal: request.connectionSignal,
		secrets: initialSecrets,
	});
	const resources: OpeningResources = { services, release };
	const cancelSetup = () => {
		void services.dispose().catch(() => {});
	};
	signal.addEventListener("abort", cancelSetup, { once: true });
	try {
		signal.throwIfAborted();

		const runtime = await initializeRuntime(resources, request, {
			...deps,
			stored,
		});
		signal.throwIfAborted();
		resources.session = {
			id,
			cwd: params.cwd,
			additionalDirectories: params.additionalDirectories,
			runtime,
			services,
			store: deps.store,
			release,
			secrets: services.secrets,
			records: [...(resources.history?.records ?? stored?.records ?? [])],
			tools: new Set(
				stored?.records.flatMap((record) =>
					record.kind === "update" &&
					record.update.sessionUpdate === "tool_call"
						? [record.update.toolCallId]
						: [],
				),
			),
			pending: null,
			active: null,
			closing: false,
			failed: false,
		};
		await activateSession(resources.session, request);
		return resources.session;
	} catch (error) {
		await rollbackSession(resources);
		if (signal.aborted) {
			throw RequestError.requestCancelled();
		}
		if (error instanceof RequestError) {
			throw error;
		}
		throw runtimeError(error, "Could not create or restore agent runtime");
	} finally {
		signal.removeEventListener("abort", cancelSetup);
	}
};
