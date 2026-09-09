import { randomUUID } from "node:crypto";
import fs, { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
	type AuthOperationOptions,
	type Credential,
	type CredentialStore,
} from "@earendil-works/pi-ai";

/** Only this leaf and newly created parents belong to the credential store. */
const DIRECTORY_MODE = 0o700;
/** Credentials are plaintext, protected by filesystem permissions, not encryption. */
const FILE_MODE = 0o600;
/** Include special bits when checking an existing private file or directory. */
const MODE_MASK = 0o7777;
/** Bounded contention with a heartbeat long enough for Pi's token refresh. */
const LOCK_STALE_MS = 60_000;
/** Refresh the lease well before it can be recovered by another process. */
const LOCK_UPDATE_MS = 10_000;
/** Waiting is abortable; an active callback retains its lease until settlement. */
const LOCK_WAIT_MS = 30_000;
/** Avoid proper-lockfile's non-abortable internal retry queue. */
const LOCK_RETRY_MS = 25;
/** Refuse unexpectedly large input before decoding it. */
const MAX_FILE_BYTES = 4_194_304;
/** Prevent unbounded or path-like provider keys. */
const MAX_PROVIDER_ID_LENGTH = 128;
/** Provider IDs are keys, never filenames or executable configuration. */
const providerIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9._-]*$/)
	.max(MAX_PROVIDER_ID_LENGTH);
/** Match Pi's canonical credentials, including provider-specific OAuth fields. */
const credentialSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("api_key"),
			key: z.string().optional(),
			env: z.record(z.string()).optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("oauth"),
			refresh: z.string(),
			access: z.string(),
			expires: z.number().finite(),
		})
		.passthrough(),
]);
/** An explicit version prevents silently interpreting another application's auth.json. */
const documentSchema = z
	.object({
		version: z.literal(1),
		credentials: z.record(providerIdSchema, credentialSchema),
	})
	.strict();
/** Parsed disk state; never shared across operations or instances. */
type CredentialDocument = z.infer<typeof documentSchema>;

/** Never retain a filesystem, parser, provider or abort error as a cause. */
const storageFailure = (): Error =>
	new Error(
		"Private credential operation failed; check the state directory, permissions and credential file",
	);

/** Error codes are safe to inspect, unlike messages, paths and parser input. */
const hasCode = (error: unknown, code: string): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === code;

/** Missing entries are distinct from unreadable or malformed entries. */
const statIfPresent = async (path: string): Promise<Stats | undefined> => {
	try {
		return await lstat(path);
	} catch (error) {
		if (hasCode(error, "ENOENT")) {
			return undefined;
		}
		throw storageFailure();
	}
};

/** POSIX modes cannot attest to a Windows ACL; reject before reading or creating state. */
const requireSupportedPlatform = (): void => {
	if (process.platform === "win32") {
		throw new Error(
			"Private credential storage is disabled on Windows: user-only ACL verification is not implemented",
		);
	}
};

/** Only POSIX ownership and exact private modes are currently supported. */
const requirePrivate = (stat: Stats, mode: number): void => {
	if (stat.uid !== process.getuid?.() || (stat.mode & MODE_MASK) !== mode) {
		throw storageFailure();
	}
};

/** Refuse links and Git worktrees before creating anything; never chmod ancestors. */
const prepareDirectory = async (path: string): Promise<void> => {
	const parent = dirname(path);
	if (parent !== path) {
		await prepareDirectory(parent);
	}
	if (await statIfPresent(join(path, ".git"))) {
		throw storageFailure();
	}
	let stat = await statIfPresent(path);
	if (!stat) {
		await mkdir(path, { mode: DIRECTORY_MODE }).catch((error: unknown) => {
			if (!hasCode(error, "EEXIST")) {
				throw storageFailure();
			}
		});
		stat = await lstat(path);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw storageFailure();
	}
};

/** Recheck the private boundary before every operation, including after waiting. */
const checkDirectory = async (stateDir: string): Promise<void> => {
	await prepareDirectory(stateDir);
	requirePrivate(await lstat(stateDir), DIRECTORY_MODE);
};

/** Reject links, hard links, special files and permissive existing credentials. */
const checkFile = async (path: string): Promise<Stats | undefined> => {
	const stat = await statIfPresent(path);
	if (stat) {
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
			throw storageFailure();
		}
		requirePrivate(stat, FILE_MODE);
	}
	return stat;
};

/** Read only an inspected regular file; O_NOFOLLOW also closes the final-link race on POSIX. */
const readDocument = async (path: string): Promise<CredentialDocument> => {
	const before = await checkFile(path);
	if (!before) {
		return { version: 1, credentials: {} };
	}
	const handle = await open(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const stat = await handle.stat();
		requirePrivate(stat, FILE_MODE);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.ino !== before.ino ||
			stat.dev !== before.dev ||
			stat.size > MAX_FILE_BYTES
		) {
			throw storageFailure();
		}
		const parsed = documentSchema.safeParse(
			JSON.parse(await handle.readFile("utf8")),
		);
		if (!parsed.success) {
			throw storageFailure();
		}
		return parsed.data;
	} finally {
		await handle.close();
	}
};

/** Rename within one directory; a failed write never truncates the previous credential. */
const writeDocument = async (
	path: string,
	document: CredentialDocument,
	assertActive: () => void,
): Promise<void> => {
	const contents = JSON.stringify(documentSchema.parse(document));
	if (Buffer.byteLength(contents) > MAX_FILE_BYTES) {
		throw storageFailure();
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", FILE_MODE);
	try {
		try {
			await handle.writeFile(contents, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await checkFile(path);
		assertActive();
		await rename(temporary, path);
		const directory = await open(dirname(path), constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!hasCode(error, "ENOENT")) {
				throw storageFailure();
			}
		});
	}
};

/** proper-lockfile's mkdir must also be private, without a process-wide umask change. */
const privateLockFs = {
	...fs,
	mkdir: (path: fs.PathLike, callback: fs.NoParamCallback): void => {
		fs.mkdir(path, { mode: DIRECTORY_MODE }, callback);
	},
};

/** A stable lock pathname survives credential-file replacement and deletion. */
const acquireLock = async (
	path: string,
	signal: AbortSignal | undefined,
	lease: { onCompromised: () => void; deadline: number },
): Promise<() => Promise<void>> => {
	signal?.throwIfAborted();
	const existing = await statIfPresent(`${path}.lock`);
	if (existing) {
		if (existing.isSymbolicLink() || !existing.isDirectory()) {
			throw storageFailure();
		}
		requirePrivate(existing, DIRECTORY_MODE);
	}
	try {
		return await lockfile.lock(path, {
			realpath: false,
			retries: 0,
			stale: LOCK_STALE_MS,
			update: LOCK_UPDATE_MS,
			fs: privateLockFs,
			onCompromised: lease.onCompromised,
		});
	} catch (error) {
		if (!hasCode(error, "ELOCKED") || Date.now() >= lease.deadline) {
			throw storageFailure();
		}
		await delay(LOCK_RETRY_MS, undefined, { signal });
		return acquireLock(path, signal, lease);
	}
};

/**
 * File-backed Pi 0.85.1 CredentialStore. A single cross-process lease serializes
 * the whole document, including OAuth refresh callbacks and logout. Every read
 * reloads disk; there is no stale per-process credential cache. Undefined from
 * modify means unchanged, NOT delete. Use delete for logout.
 *
 * stateDir must be an absolute, non-versioned, non-symlink user-private path.
 * Existing POSIX permissions must be 0700/0600; no existing path is chmodded.
 * Windows is refused before filesystem access: Node modes cannot verify a
 * user-only ACL, and this implementation has no ACL verifier. Precreating the
 * directory, chmod or an environment flag cannot bypass this restriction.
 * Same-user hostile path replacement, network filesystems and a process
 * suspended beyond the lock lease are outside this protection.
 * No workspace config or Pi global credential/config file is read or imported.
 */
export const createCredentialStore = async ({
	stateDir,
}: {
	readonly stateDir: string;
}): Promise<CredentialStore> => {
	requireSupportedPlatform();
	if (!isAbsolute(stateDir)) {
		throw storageFailure();
	}
	const directory = resolve(stateDir);
	const path = join(directory, "credentials.json");
	const transaction = async <T>(
		operation: (
			document: CredentialDocument,
			assertActive: () => void,
		) => Promise<T>,
		options?: AuthOperationOptions,
	): Promise<T> => {
		requireSupportedPlatform();
		try {
			await checkDirectory(directory);
			let compromised = false;
			const release = await acquireLock(path, options?.signal, {
				deadline: Date.now() + LOCK_WAIT_MS,
				onCompromised: () => {
					compromised = true;
				},
			});
			const assertActive = (): void => {
				options?.signal?.throwIfAborted();
				if (compromised) {
					throw storageFailure();
				}
			};
			try {
				assertActive();
				await checkDirectory(directory);
				const result = await operation(await readDocument(path), assertActive);
				assertActive();
				return result;
			} finally {
				await release();
			}
		} catch {
			throw storageFailure();
		}
	};
	// Fail closed on malformed existing state even if the first caller only lists models.
	await transaction(async () => undefined);
	return {
		read: (providerId, options) =>
			transaction(async (document) => {
				providerIdSchema.parse(providerId);
				return Object.hasOwn(document.credentials, providerId)
					? document.credentials[providerId]
					: undefined;
			}, options),
		list: (options) =>
			transaction(
				async (document) =>
					Object.entries(document.credentials).map(
						([providerId, credential]) => ({
							providerId,
							type: credential.type,
						}),
					),
				options,
			),
		modify: (providerId, fn, options) =>
			transaction(async (document, assertActive) => {
				providerIdSchema.parse(providerId);
				const current = Object.hasOwn(document.credentials, providerId)
					? document.credentials[providerId]
					: undefined;
				const next = await fn(
					structuredClone(current) as Credential | undefined,
				);
				assertActive();
				if (next === undefined) {
					return current;
				}
				const parsed = credentialSchema.parse(next);
				const credentials = { ...document.credentials, [providerId]: parsed };
				await writeDocument(path, { version: 1, credentials }, assertActive);
				return structuredClone(parsed);
			}, options),
		delete: (providerId, options) =>
			transaction(async (document, assertActive) => {
				providerIdSchema.parse(providerId);
				if (!Object.hasOwn(document.credentials, providerId)) {
					return;
				}
				delete document.credentials[providerId];
				await writeDocument(path, document, assertActive);
			}, options),
	};
};
