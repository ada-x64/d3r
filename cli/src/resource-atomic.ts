import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	checkedText,
	isMissing,
	readDiskText,
	workspacePath,
	type WorkspaceAccess,
} from "./resource-paths.ts";

/** Inject filesystem faults without weakening the normal workspace write path. */
export interface AtomicWriteIo {
	readonly open: typeof open;
	readonly rename: typeof rename;
	readonly link: typeof link;
	readonly unlink: typeof unlink;
}

/** Preserve all existing permission bits, including executable permissions. */
const MODES = { private: 0o600, mask: 0o7777 };

/** Metadata changes invalidate the final preimage check even if text is identical. */
const unchanged = (before: Stats, after: Stats): boolean =>
	before.dev === after.dev &&
	before.ino === after.ino &&
	before.mode === after.mode &&
	before.size === after.size &&
	before.mtimeMs === after.mtimeMs &&
	before.ctimeMs === after.ctimeMs;

/** Absence is the only recoverable stat failure. */
const optionalStat = async (path: string): Promise<Stats | null> => {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	}
};

/** Publish only a complete, synced sibling; never truncate or modify the preimage. */
// oxlint-disable-next-line max-statements -- Keep staging, final conflict checks and publication in one cleanup boundary.
export const atomicWorkspaceWrite = async (
	{
		path,
		oldText,
		newText,
	}: { path: string; oldText: string | null; newText: string },
	access: WorkspaceAccess,
	io: AtomicWriteIo = { open, rename, link, unlink },
): Promise<void> => {
	checkedText(newText);
	await workspacePath(path, access, oldText === null);
	const parent = await workspacePath(dirname(path), access);
	const directory = await lstat(parent);
	const before = await optionalStat(path);
	if ((oldText === null) !== (before === null)) {
		throw new Error("Stale snapshot: file existence changed");
	}
	if (
		before &&
		(!before.isFile() ||
			before.nlink !== 1 ||
			(await readDiskText(path, access.signal)) !== oldText)
	) {
		throw new Error("Stale snapshot: file changed before staging");
	}
	const staged = join(parent, `.d3r-write-${randomUUID()}.tmp`);
	access.signal.throwIfAborted();
	const handle = await io.open(
		staged,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			(constants.O_NOFOLLOW ?? 0),
		MODES.private,
	);
	try {
		let stageIdentity: Stats | undefined = undefined;
		try {
			access.signal.throwIfAborted();
			await handle.writeFile(newText, {
				encoding: "utf8",
				signal: access.signal,
			});
			await handle.chmod(before ? before.mode & MODES.mask : MODES.private);
			await handle.sync();
			stageIdentity = await handle.stat();
		} finally {
			await handle.close();
		}
		await workspacePath(path, access, oldText === null);
		const current = await optionalStat(path);
		if (
			before
				? !current ||
					!unchanged(before, current) ||
					(await readDiskText(path, access.signal)) !== oldText
				: current !== null
		) {
			throw new Error("Stale snapshot: file changed before publication");
		}
		const currentDirectory = await lstat(parent);
		if (
			directory.dev !== currentDirectory.dev ||
			directory.ino !== currentDirectory.ino
		) {
			throw new Error("Workspace directory changed before publication");
		}
		await workspacePath(parent, access);
		const stageNow = await lstat(staged);
		if (
			!stageIdentity ||
			!stageNow.isFile() ||
			stageNow.nlink !== 1 ||
			!unchanged(stageIdentity, stageNow)
		) {
			throw new Error("Staging file identity changed before publication");
		}
		const finalTarget = await optionalStat(path);
		if (
			before
				? !finalTarget || !unchanged(before, finalTarget)
				: finalTarget !== null
		) {
			throw new Error("Stale snapshot: final file identity changed");
		}
		access.signal.throwIfAborted();
		// Node has no directory-relative rename/CAS primitive. These checks and the
		// caller's exclusive lock protect cooperating writers, not hostile inode swaps.
		// Linking a new file is atomic and cannot overwrite a concurrently created path.
		await (before ? io.rename(staged, path) : io.link(staged, path));
	} finally {
		await io.unlink(staged).catch((error: unknown) => {
			if (!isMissing(error)) {
				throw error;
			}
		});
	}
};
