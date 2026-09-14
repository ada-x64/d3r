import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { currentLockOwner, LockOwner, lockOwnerStatus } from "./lock-owner.ts";

/** A directory of immutable, uniquely named claims avoids fixed-path stale-unlink ABA races. */
const Claim = z.object({ id: z.string().uuid(), owner: LockOwner }).strict();
/** Private local storage is small and bounded; age is never evidence of a dead owner. */
const LIMITS = {
	claims: 128,
	bytes: 4096,
	fileMode: 0o600,
	directoryMode: 0o700,
};
/** Unknown filesystem errors must never justify deleting another claimant's metadata. */
const hasCode = (error: unknown, code: string): boolean =>
	z.object({ code: z.literal(code) }).safeParse(error).success;
/** Metadata failures require inspection, not a time-based takeover. */
const recoveryRequired = () =>
	RequestError.invalidRequest(
		undefined,
		"Session lock ownership could not be verified. Stop the previous D3R agent and inspect the session lock before retrying; no work was resumed.",
	);
/** Inspect the registry itself without following a symlink or interpreting an old empty file. */
const directoryIdentity = async (path: string): Promise<Stats> => {
	const info = await lstat(path);
	if (info.isFile()) {
		throw RequestError.invalidRequest(
			undefined,
			"Session has a legacy lock without owner information. After confirming the previous D3R process has stopped, remove that session's old .lock file and retry.",
		);
	}
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw recoveryRequired();
	}
	return info;
};
/** Protocol participants never remove the registry directory, so its identity must remain stable. */
const checkDirectory = async (path: string, expected: Stats): Promise<void> => {
	const current = await directoryIdentity(path);
	if (current.dev !== expected.dev || current.ino !== expected.ino) {
		throw recoveryRequired();
	}
};
/** A disappeared immutable claim was withdrawn by its owner or another proven-death collector. */
const readClaim = async (
	path: string,
	name: string,
): Promise<z.infer<typeof Claim> | null> => {
	if (
		!name.endsWith(".json") ||
		!z.string().uuid().safeParse(name.slice(0, -".json".length)).success
	) {
		throw recoveryRequired();
	}
	const file = await open(
		join(path, name),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	).catch((error: unknown) => {
		if (hasCode(error, "ENOENT")) {
			return null;
		}
		throw error;
	});
	if (!file) {
		return null;
	}
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > LIMITS.bytes) {
			throw recoveryRequired();
		}
		const buffer = Buffer.alloc(LIMITS.bytes + 1);
		let length = 0;
		while (length < buffer.length) {
			// oxlint-disable-next-line no-await-in-loop -- Parse only complete metadata, including a possible invalid trailer after a short read.
			const { bytesRead } = await file.read(
				buffer,
				length,
				buffer.length - length,
				null,
			);
			if (bytesRead === 0) {
				break;
			}
			length += bytesRead;
		}
		if (length > LIMITS.bytes) {
			throw recoveryRequired();
		}
		const parsed = Claim.safeParse(
			JSON.parse(buffer.subarray(0, length).toString("utf8")),
		);
		if (!parsed.success || `${parsed.data.id}.json` !== name) {
			throw recoveryRequired();
		}
		return parsed.data;
	} finally {
		await file.close();
	}
};
/** Unlink only a never-reused claim basename; another owner's new claim has a different path. */
const withdraw = async (path: string): Promise<void> => {
	await unlink(path).catch((error: unknown) => {
		if (!hasCode(error, "ENOENT")) {
			throw error;
		}
	});
};

/** Only proven-dead, immutable claims are collected; retained competitors must stay exclusive. */
const collectClaims = async (
	path: string,
	identity: Stats,
	name: string,
): Promise<void> => {
	const directory = await opendir(path);
	let count = 0;
	for await (const entry of directory) {
		if (++count > LIMITS.claims || entry.isSymbolicLink() || !entry.isFile()) {
			throw recoveryRequired();
		}
		if (entry.name !== name) {
			// oxlint-disable-next-line no-await-in-loop -- Ownership observations precede collection of each immutable claim.
			const previous = await readClaim(path, entry.name);
			if (previous) {
				// oxlint-disable-next-line no-await-in-loop -- Never substitute a timeout for process identity.
				const status = await lockOwnerStatus(previous.owner);
				if (status !== "dead") {
					throw status === "live"
						? RequestError.invalidRequest(
								undefined,
								`Session is open in a live D3R process (PID ${previous.owner.pid}). Close that agent connection and retry.`,
							)
						: recoveryRequired();
				}
				// oxlint-disable-next-line no-await-in-loop -- Reclamation cannot target a substituted registry.
				await checkDirectory(path, identity);
				// oxlint-disable-next-line no-await-in-loop -- The UUID is never reused by a new owner.
				await withdraw(join(path, entry.name));
			}
		}
	}
};

/** Fully write and close metadata before publishing its immutable claim name. */
const stageClaim = async (
	path: string,
	claim: z.infer<typeof Claim>,
): Promise<void> => {
	const file = await open(path, "wx", LIMITS.fileMode);
	try {
		await file.writeFile(JSON.stringify(claim));
		await file.sync();
	} finally {
		await file.close();
	}
};

/**
 * Local coherent filesystems only: publish before scanning, and retain the claim for the whole lease.
 * The later publisher observes any successful earlier owner. Concurrent contenders may both lose,
 * but cannot both win. Empty registries remain in place to avoid directory removal/recreation races.
 */
export const acquireSessionLock = async (
	path: string,
): Promise<() => Promise<void>> => {
	const id = randomUUID();
	const name = `${id}.json`;
	const claimPath = join(path, name);
	const temporary = join(dirname(path), `${basename(path)}.${id}.tmp`);
	let identity: Stats | undefined = undefined;
	let published = false;
	try {
		await mkdir(path, { mode: LIMITS.directoryMode }).catch(
			(error: unknown) => {
				if (!hasCode(error, "EEXIST")) {
					throw error;
				}
			},
		);
		identity = await directoryIdentity(path);
		const claim = Claim.parse({ id, owner: await currentLockOwner() });
		await stageClaim(temporary, claim);
		await checkDirectory(path, identity);
		await rename(temporary, claimPath);
		published = true;
		await checkDirectory(path, identity);
		await collectClaims(path, identity, name);
		await checkDirectory(path, identity);
		const retained = await readClaim(path, name);
		if (!retained || retained.id !== id) {
			throw recoveryRequired();
		}
		let released = false;
		const ownedDirectory = identity;
		return async () => {
			if (released) {
				return;
			}
			await checkDirectory(path, ownedDirectory);
			await withdraw(claimPath);
			released = true;
		};
	} catch (error) {
		if (published && identity) {
			await checkDirectory(path, identity)
				.then(() => withdraw(claimPath))
				.catch(() => {});
		}
		if (error instanceof RequestError) {
			throw error;
		}
		throw recoveryRequired();
	} finally {
		await withdraw(temporary).catch(() => {});
	}
};
