import { open, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { z } from "zod";

/** Bound every OS/serialized string, including procfs files whose reported size is zero. */
const LIMITS = {
	metadataBytes: 4096,
	decimalDigits: 20,
	uuid: 36,
	machineId: 32,
	pidNamespace: 26,
	host: 255,
	platform: 32,
	errorCode: 32,
	statFields: 64,
} as const;
/** Linux field 22, relative to the numeric suffix starting at field 4. */
const START_TIME_INDEX = 18;
/** PIDs must never become process-group probes or lose integer precision. */
const pidSchema = z.number().int().positive().safe();
/** Keep kernel counters as decimal strings, including values beyond Number's precision. */
const ticksSchema = z
	.string()
	.min(1)
	.max(LIMITS.decimalDigits)
	.regex(/^[0-9]+$/);
/** Namespace inode numbers are meaningful only within the same boot. */
const linuxSchema = z
	.object({
		bootId: z.string().max(LIMITS.uuid).uuid().toLowerCase(),
		machineId: z
			.string()
			.length(LIMITS.machineId)
			.regex(/^[a-f0-9]+$/i)
			.toLowerCase()
			.optional(),
		pidNamespace: z
			.string()
			.max(LIMITS.pidNamespace)
			.regex(/^pid:\[[0-9]{1,20}\]$/),
		startTime: ticksSchema,
	})
	.strict();

/** Local trusted-filesystem ownership evidence, not credentials or an ACL guarantee. */
export const LockOwner = z
	.object({
		version: z.literal(1),
		host: z.string().min(1).max(LIMITS.host),
		platform: z.string().min(1).max(LIMITS.platform),
		pid: pidSchema,
		linux: linuxSchema.optional(),
	})
	.strict();
/** Persist only this allowlisted, versioned metadata in an adapter-owned lock. */
export type LockOwner = z.infer<typeof LockOwner>;

/** No environment, command lines, or credential files enter the observation seam. */
type MetadataPath =
	| "/proc/self/stat"
	| "/proc/self/status"
	| "/proc/sys/kernel/random/boot_id"
	| "/etc/machine-id"
	| `/proc/${number}/stat`;
/** @internal Adapter unit-test seam; never wire this through runtime/client configuration. */
interface ObservationIO {
	readonly host: string;
	readonly platform: NodeJS.Platform;
	readonly pid: number;
	readonly readFile: (path: MetadataPath) => Promise<string>;
	readonly readLink: (path: "/proc/self/ns/pid") => Promise<string>;
	readonly probe: (pid: number) => void;
}

/** Bound allocation and reads, rather than trusting procfs's zero st_size. */
const readMetadata = async (path: MetadataPath): Promise<string> => {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(LIMITS.metadataBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			// oxlint-disable-next-line no-await-in-loop -- Short reads advance one shared file offset.
			const { bytesRead } = await file.read(
				buffer,
				length,
				buffer.length - length,
				null,
			);
			if (bytesRead === 0) {
				return buffer.subarray(0, length).toString("utf8");
			}
			length += bytesRead;
		}
		throw new Error("Lock owner metadata exceeds its size limit");
	} finally {
		await file.close();
	}
};
/** Capture each observation afresh; there is no cached process or host identity. */
const systemIO = (): ObservationIO => ({
	host: hostname(),
	platform: process.platform,
	pid: process.pid,
	readFile: readMetadata,
	readLink: readlink,
	probe: (pid) => {
		process.kill(pid, 0);
	},
});
/** Apply the same raw-input bound to native reads and injected observations. */
const metadataText = z.string().max(LIMITS.metadataBytes);
/** The numeric suffix excludes comm, whose spaces and parentheses are not delimiters. */
const statNumbers = z
	.array(
		z
			.string()
			.min(1)
			.max(LIMITS.decimalDigits + 1)
			.regex(/^-?[0-9]+$/),
	)
	.min(START_TIME_INDEX + 1)
	.max(LIMITS.statFields);
/** Validate stat syntax without treating the thread-group leader's state as proof of death. */
const statSchema = z.object({
	pid: pidSchema,
	state: z.enum(["R", "S", "D", "Z", "T", "t", "X", "x", "K", "W", "P", "I"]),
	startTime: ticksSchema,
});
/** Field 22 is offset 18 after state; greedy comm matching tolerates even embedded newlines. */
const parseStat = (raw: string, expectedPid: number) => {
	const match = /^([1-9][0-9]*) \([\s\S]*\) ([A-Za-z]) ([^\r\n]+)\n?$/.exec(
		metadataText.parse(raw),
	);
	if (!match) {
		throw new Error("Invalid lock owner proc stat");
	}
	const [, pid, state, suffix] = match;
	const fields = statNumbers.parse(suffix.trim().split(/\s+/));
	const stat = statSchema.parse({
		pid: Number(pid),
		state,
		startTime: fields[START_TIME_INDEX],
	});
	if (stat.pid !== expectedPid) {
		throw new Error("Lock owner procfs PID numbering is inconsistent");
	}
	return stat;
};
/** A coincidentally matching stat PID is insufficient when procfs exposes ancestor namespaces. */
const parseNamespacePid = (raw: string, expectedPid: number): number => {
	const [line] = z
		.array(z.string())
		.length(1)
		.parse(
			metadataText
				.parse(raw)
				.split("\n")
				.filter((entry) => entry.startsWith("NSpid:")),
		);
	const [pid] = z.tuple([ticksSchema.transform(Number).pipe(pidSchema)]).parse(
		line
			.slice("NSpid:".length)
			.trim()
			.split(/[ \t]+/),
	);
	if (pid !== expectedPid) {
		throw new Error(
			"Lock owner procfs PID namespace visibility is inconsistent",
		);
	}
	return pid;
};
/** Missing, denied, or malformed identity is absence of evidence, never evidence of death. */
const optionalObservation = async <T>(
	read: () => Promise<T>,
): Promise<T | undefined> => {
	try {
		return await read();
	} catch {
		return undefined;
	}
};
/** Strip file terminators only after bounding raw input, then parse the kernel identifier. */
const readIdentifier = async <T>(
	read: () => Promise<string>,
	schema: z.ZodType<T>,
): Promise<T> => schema.parse(metadataText.parse(await read()).trim());

/**
 * Describe this process only. Linux evidence requires both self stat and a single NSpid
 * equal to process.pid, proving procfs is mounted in our PID namespace. Machine ID is
 * optional and only required to prove the same host across boots. Invalid base OS metadata
 * rejects publication.
 */
export const currentLockOwner = async (
	io: ObservationIO = systemIO(),
): Promise<LockOwner> => {
	const owner = LockOwner.parse({
		version: 1,
		host: io.host,
		platform: io.platform,
		pid: io.pid,
	});
	if (owner.platform !== "linux") {
		return owner;
	}
	const [bootId, machineId, pidNamespace, stat, namespacePid] =
		await Promise.all([
			optionalObservation(() =>
				readIdentifier(
					() => io.readFile("/proc/sys/kernel/random/boot_id"),
					linuxSchema.shape.bootId,
				),
			),
			optionalObservation(() =>
				readIdentifier(
					() => io.readFile("/etc/machine-id"),
					linuxSchema.shape.machineId.unwrap(),
				),
			),
			optionalObservation(() =>
				readIdentifier(
					() => io.readLink("/proc/self/ns/pid"),
					linuxSchema.shape.pidNamespace,
				),
			),
			optionalObservation(async () =>
				parseStat(await io.readFile("/proc/self/stat"), owner.pid),
			),
			optionalObservation(async () =>
				parseNamespacePid(await io.readFile("/proc/self/status"), owner.pid),
			),
		]);
	if (!bootId || !pidNamespace || !stat || !namespacePid) {
		return owner;
	}
	return LockOwner.parse({
		...owner,
		linux: {
			bootId,
			...(machineId ? { machineId } : {}),
			pidNamespace,
			startTime: stat.startTime,
		},
	});
};

/** Error objects are another untyped OS boundary; unknown codes cannot justify reclamation. */
const errorCode = (error: unknown): string | undefined => {
	const parsed = z
		.object({ code: z.string().max(LIMITS.errorCode) })
		.safeParse(error);
	return parsed.success ? parsed.data.code : undefined;
};
/** Signal zero observes existence without sending a signal; EPERM is deliberately unknown. */
const probeStatus = (
	io: ObservationIO,
	pid: number,
): "live" | "dead" | "unknown" => {
	try {
		io.probe(pid);
		return "live";
	} catch (error) {
		return errorCode(error) === "ESRCH" ? "dead" : "unknown";
	}
};
/**
 * Only `dead` permits attempting stale-lock reclamation; `live` and `unknown` stay busy.
 * This is evidence, not a lock operation: the caller must still serialize/recheck ownership.
 * No TTL or wall clock is involved. Non-Linux PID reuse remains conservatively live.
 */
export const lockOwnerStatus = async (
	owner: LockOwner,
	io?: ObservationIO,
): Promise<"live" | "dead" | "unknown"> => {
	const parsed = LockOwner.safeParse(owner);
	if (!parsed.success) {
		return "unknown";
	}
	const recorded = parsed.data;
	const localIO = io ?? (await optionalObservation(async () => systemIO()));
	if (!localIO) {
		return "unknown";
	}
	const current = await optionalObservation(() => currentLockOwner(localIO));
	if (
		!current ||
		recorded.host !== current.host ||
		recorded.platform !== current.platform
	) {
		return "unknown";
	}
	if (current.platform !== "linux") {
		return recorded.linux ? "unknown" : probeStatus(localIO, recorded.pid);
	}
	const prior = recorded.linux;
	const local = current.linux;
	if (!prior || !local) {
		return "unknown";
	}
	if (
		prior.machineId &&
		local.machineId &&
		prior.machineId !== local.machineId
	) {
		return "unknown";
	}
	if (prior.bootId !== local.bootId) {
		// Namespace inode numbers may be reused after reboot; only persistent host proof survives.
		return prior.machineId && prior.machineId === local.machineId
			? "dead"
			: "unknown";
	}
	if (prior.pidNamespace !== local.pidNamespace) {
		return "unknown";
	}
	const presence = probeStatus(localIO, recorded.pid);
	if (presence !== "live") {
		return presence;
	}
	try {
		const stat = parseStat(
			await localIO.readFile(`/proc/${recorded.pid}/stat`),
			recorded.pid,
		);
		// A zombie/exiting thread-group leader can still have other threads writing.
		return BigInt(stat.startTime) !== BigInt(prior.startTime) ? "dead" : "live";
	} catch (error) {
		const code = errorCode(error);
		// hidepid can produce ENOENT for a live process. Corroborate absence with signal zero.
		return (code === "ENOENT" || code === "ESRCH") &&
			probeStatus(localIO, recorded.pid) === "dead"
			? "dead"
			: "unknown";
	}
};
