import { RequestError } from "@agentclientprotocol/sdk";
import { type Session } from "./session.ts";
import {
	type SessionMutation,
	type SessionStore,
	type StoredSession,
} from "./store.ts";

/** Persist only allowlisted session data, never transient runtime or MCP connection inputs. */
export const storedSession = (session: Session): StoredSession => ({
	version: 1,
	sessionId: session.id,
	cwd: session.cwd,
	additionalDirectories: session.additionalDirectories,
	updatedAt: new Date().toISOString(),
	records: session.records,
});
/** Acknowledgement of this write is required before any effectful backend invocation. */
export const writeMutationIntent = async (
	store: SessionStore,
	stored: StoredSession,
	operation: SessionMutation,
): Promise<StoredSession> => {
	const pending: StoredSession = {
		...stored,
		updatedAt: new Date().toISOString(),
		records: [...stored.records, { kind: "intent", operation }],
	};
	await store.save(pending);
	return pending;
};
/** A failed intent write must neither start the mutation nor be replaced by a stale checkpoint. */
export const beginSessionMutation = async (
	session: Session,
	operation: SessionMutation,
): Promise<void> => {
	if (!session.store) {
		return;
	}
	try {
		const pending = await writeMutationIntent(
			session.store,
			storedSession(session),
			operation,
		);
		session.records = [...pending.records];
	} catch {
		session.failed = true;
		throw RequestError.internalError(
			undefined,
			"Could not persist session mutation intent",
		);
	}
};
