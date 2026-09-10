/* oxlint-disable no-await-in-loop -- Ancestors and bounded file chunks must be checked in order. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { type RuntimeClientServices } from "@d3r/core/runtime";

/** Shared bounds apply to disk, editor buffers, and embedded file resources. */
export const MAX_TEXT_BYTES = 1_048_576;

/** Access is scoped explicitly; neither home nor parent workspaces are inferred. */
export interface WorkspaceAccess {
	readonly cwd: string;
	readonly roots: readonly string[];
	/** Host-owned private stores, excluded even inside an approved workspace or vault. */
	readonly excludedDirectories?: readonly string[];
	readonly signal: AbortSignal;
	readonly client?: RuntimeClientServices;
}

/** An inaccessible entry is distinct from an absent optional resource. */
export class ResourceAccessError extends Error {
	override name = "ResourceAccessError";
}

/** Test containment by path components, not string prefixes. */
export const isWithinRoot = (root: string, path: string): boolean => {
	const suffix = relative(root, path);
	return (
		suffix === "" ||
		(!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
	);
};

/** Exclude private storage paths, not source files or directories named for security concepts. */
export const isSensitivePath = (
	path: string,
	excludedDirectories: readonly string[] = [],
): boolean => {
	const absolute = resolve(path);
	if (
		excludedDirectories.some((directory) =>
			isWithinRoot(resolve(directory), absolute),
		)
	) {
		return true;
	}
	const parts = absolute
		.split(/[\\/]+/)
		.map((part) => part.toLowerCase().replace(/[ .]+$/, ""));
	const stores = new Set([
		".git",
		".ssh",
		".gnupg",
		".aws",
		".azure",
		".kube",
		".config",
		".local",
		".npm",
		".docker",
		".password-store",
		".pi",
		".codex",
		".claude",
	]);
	return parts.some(
		(part, index) =>
			stores.has(part) ||
			part.startsWith(".env") ||
			part.endsWith(".env") ||
			/\.(?:pem|key|p12|pfx|keystore|jks)$/.test(part) ||
			/^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|authorized_keys|known_hosts)$/.test(
				part,
			) ||
			(part === "d3r" &&
				parts[index - 1] === ".agents" &&
				parts[index + 1] === "private") ||
			(parts[index - 1] === ".agents" &&
				/^(?:sessions?|history|state|cache|private|auth|credentials|keys)$/.test(
					part,
				)),
	);
};

/** Only ENOENT means absent; permission and malformed-path errors propagate. */
export const isMissing = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "ENOENT";

/** Trust roots must already be canonical; never bless a newly substituted root symlink. */
export const checkedWorkspaceRoot = async (
	path: string,
	signal: AbortSignal,
): Promise<{ path: string; dev: number; ino: number }> => {
	signal.throwIfAborted();
	const root = resolve(path);
	const before = await lstat(root);
	if (
		before.isSymbolicLink() ||
		!before.isDirectory() ||
		(await realpath(root)) !== root
	) {
		throw new ResourceAccessError(
			`Workspace root must be a canonical directory, not a symlink: ${root}`,
		);
	}
	const after = await lstat(root);
	if (
		after.isSymbolicLink() ||
		before.dev !== after.dev ||
		before.ino !== after.ino
	) {
		throw new ResourceAccessError(`Workspace root identity changed: ${root}`);
	}
	signal.throwIfAborted();
	return { path: root, dev: after.dev, ino: after.ino };
};

/** Resolve existing ancestors and reject symlinks, including aliases inside a root. */
// oxlint-disable-next-line max-statements -- Keep containment and race checks together at the filesystem boundary.
export const workspacePath = async (
	path: string,
	access: WorkspaceAccess,
	allowMissing = false,
): Promise<string> => {
	access.signal.throwIfAborted();
	if (!path || path.includes("\0")) {
		throw new ResourceAccessError("Invalid workspace path");
	}
	const absolute = resolve(access.cwd, path);
	if (
		process.platform === "win32" &&
		absolute
			.slice(parse(absolute).root.length)
			.split(/[\\/]/)
			.some((part) => /[:*?<>|]/.test(part) || /[ .]$/.test(part))
	) {
		throw new ResourceAccessError(
			"Windows stream, wildcard, or ambiguous path denied",
		);
	}
	if (isSensitivePath(absolute, access.excludedDirectories)) {
		throw new ResourceAccessError(`Sensitive path denied: ${absolute}`);
	}
	const roots = await Promise.all(
		access.roots.map((root) =>
			checkedWorkspaceRoot(resolve(access.cwd, root), access.signal),
		),
	);
	const [root] = roots
		.filter((candidate) => isWithinRoot(candidate.path, absolute))
		.toSorted((a, b) => b.path.length - a.path.length);
	if (!root) {
		throw new ResourceAccessError(`Path outside allowed roots: ${absolute}`);
	}
	const suffix = relative(root.path, absolute);
	const canonical = resolve(root.path, suffix);
	if (isSensitivePath(canonical, access.excludedDirectories)) {
		throw new ResourceAccessError(`Sensitive path denied: ${canonical}`);
	}
	let cursor = root.path;
	const parts = suffix ? suffix.split(sep) : [];
	for (const part of parts) {
		access.signal.throwIfAborted();
		cursor = join(cursor, part);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink()) {
				throw new ResourceAccessError(`Symlink access denied: ${cursor}`);
			}
			if (!info.isDirectory() && !info.isFile()) {
				throw new ResourceAccessError(
					`Not a regular file or directory: ${cursor}`,
				);
			}
			if (info.isFile() && info.nlink > 1) {
				throw new ResourceAccessError(
					`Hard-linked file access denied: ${cursor}`,
				);
			}
		} catch (error) {
			if (allowMissing && isMissing(error)) {
				break;
			}
			throw error;
		}
	}
	// Re-resolve the nearest existing ancestor to catch a replaced parent link.
	let ancestor = canonical;
	for (;;) {
		try {
			const actual = await realpath(ancestor);
			if (actual !== ancestor || !isWithinRoot(root.path, actual)) {
				throw new ResourceAccessError(
					`Path changed or escaped its root: ${canonical}`,
				);
			}
			break;
		} catch (error) {
			if (!allowMissing || !isMissing(error)) {
				throw error;
			}
			const parent = resolve(ancestor, "..");
			if (parent === ancestor || ancestor === parse(ancestor).root) {
				throw error;
			}
			ancestor = parent;
		}
	}
	const finalRoot = await checkedWorkspaceRoot(root.path, access.signal);
	if (finalRoot.dev !== root.dev || finalRoot.ino !== root.ino) {
		throw new ResourceAccessError(
			`Workspace root identity changed: ${root.path}`,
		);
	}
	// Node path APIs cannot eliminate swaps between the last inode check and IO.
	// Root trust is supplied by the caller; never re-canonicalize a substituted alias.
	access.signal.throwIfAborted();
	return canonical;
};

/** Reject binary/invalid UTF-8 rather than returning lossy resource content. */
export const checkedText = (value: string | Uint8Array): string => {
	if (Buffer.byteLength(value) > MAX_TEXT_BYTES) {
		throw new ResourceAccessError(`Text exceeds ${MAX_TEXT_BYTES} bytes`);
	}
	const text =
		typeof value === "string"
			? value
			: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					value,
				);
	if (
		typeof value === "string" &&
		Buffer.from(value).toString("utf8") !== value
	) {
		throw new ResourceAccessError("Text contains invalid Unicode surrogates");
	}
	if (text.includes("\0")) {
		throw new ResourceAccessError("Binary files are not supported");
	}
	return text;
};

/** Read a fixed-size buffer, so a growing file cannot cause an unbounded read. */
export const readDiskText = async (
	path: string,
	signal: AbortSignal,
	trustedPackage = false,
): Promise<string> => {
	signal.throwIfAborted();
	const handle = await open(
		path,
		constants.O_RDONLY |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0),
	);
	try {
		const info = await handle.stat();
		if (!info.isFile() || (!trustedPackage && info.nlink > 1)) {
			throw new ResourceAccessError(`Not a private regular file: ${path}`);
		}
		if (info.size > MAX_TEXT_BYTES) {
			throw new ResourceAccessError(`Text exceeds ${MAX_TEXT_BYTES} bytes`);
		}
		const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.length - length,
				length,
			);
			if (!bytesRead) {
				break;
			}
			length += bytesRead;
		}
		signal.throwIfAborted();
		return checkedText(buffer.subarray(0, length));
	} finally {
		await handle.close();
	}
};

/** Negotiated editor reads are authoritative; a failure never falls back to stale disk. */
export const readWorkspaceText = async (
	path: string,
	access: WorkspaceAccess,
): Promise<{ path: string; text: string }> => {
	const canonical = await workspacePath(
		path,
		access,
		Boolean(access.client?.readTextFile),
	);
	const text = access.client?.readTextFile
		? checkedText(await access.client.readTextFile(canonical, access.signal))
		: await readDiskText(canonical, access.signal);
	await workspacePath(canonical, access, Boolean(access.client?.readTextFile));
	access.signal.throwIfAborted();
	return { path: canonical, text };
};
