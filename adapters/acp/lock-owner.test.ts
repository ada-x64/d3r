/* oxlint-disable no-magic-numbers -- Explicit OS metadata and safety-boundary fixtures. */
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { currentLockOwner, LockOwner, lockOwnerStatus } from "./lock-owner.ts";

/** Exercise raw observations without exporting an owner-selection API from the adapter. */
type ObservationIO = NonNullable<Parameters<typeof currentLockOwner>[0]>;
/** Preserve the real errno boundary instead of manufacturing classifier results. */
const osError = (code: string): Error =>
	Object.assign(new Error(code), { code });
/** Field 22 and its neighbors differ so an off-by-one parser cannot accidentally pass. */
const procStat = ({
	pid = 41,
	comm = "worker ) R 0 (nested)\n) runner",
	state = "S",
	startTime = "9007199254740992",
}: {
	pid?: number;
	comm?: string;
	state?: string;
	startTime?: string;
} = {}): string =>
	`${pid} (${comm}) ${state} ${Array.from({ length: 18 }, (_, index) => String(index + 1)).join(" ")} ${startTime} 4096 1 9223372036854775807\n`;
/** Independent persisted fixture: never derive expected death evidence from currentLockOwner. */
const ownerFixture = (): LockOwner => ({
	version: 1,
	host: "test-host",
	platform: "linux",
	pid: 41,
	linux: {
		bootId: "7d39e8a1-6b8f-4c27-86a1-59328cc73189",
		machineId: "0123456789abcdef0123456789abcdef",
		pidNamespace: "pid:[4026531836]",
		startTime: "9007199254740992",
	},
});
/** A small procfs fake supplies bytes/errors, leaving all parsing and classification intact. */
const observation = ({
	files = {},
	namespace = "pid:[4026531836]",
	...overrides
}: Partial<Omit<ObservationIO, "readFile" | "readLink">> & {
	files?: Partial<
		Record<Parameters<ObservationIO["readFile"]>[0], string | Error>
	>;
	namespace?: string | Error;
} = {}): ObservationIO => {
	const metadata: Partial<
		Record<Parameters<ObservationIO["readFile"]>[0], string | Error>
	> = {
		"/proc/self/stat": procStat({ pid: 73 }),
		"/proc/self/status": "Name:\tnode\nPid:\t73\nNSpid:\t73\nThreads:\t4\n",
		"/proc/41/stat": procStat(),
		"/proc/sys/kernel/random/boot_id": "7d39e8a1-6b8f-4c27-86a1-59328cc73189\n",
		"/etc/machine-id": "0123456789abcdef0123456789abcdef\n",
		...files,
	};
	return {
		host: "test-host",
		platform: "linux",
		pid: 73,
		probe: () => {},
		...overrides,
		readFile: async (path) => {
			const value = metadata[path];
			if (typeof value !== "string") {
				throw value ?? osError("ENOENT");
			}
			return value;
		},
		readLink: async () => {
			if (typeof namespace !== "string") {
				throw namespace;
			}
			return namespace;
		},
	};
};
/** Ownership evidence tests do not claim registry integration, Zed recovery, or Windows ACLs. */
describe("lock owner", () => {
	it("observes this real process without credentials and keeps its lock busy", async () => {
		const owner = await currentLockOwner();
		expect(owner).toMatchObject({
			version: 1,
			host: hostname(),
			platform: process.platform,
			pid: process.pid,
		});
		const persisted = JSON.stringify(owner);
		expect(LockOwner.parse(JSON.parse(persisted))).toEqual(owner);
		if (process.platform === "linux") {
			expect(owner.linux).toBeDefined();
		}
		await expect(lockOwnerStatus(owner)).resolves.toBe("live");
	});

	it("rejects unversioned, extra, oversized, and unsafe ownership metadata", () => {
		const owner = ownerFixture();
		for (const invalid of [
			{ ...owner, version: 2 },
			{ ...owner, token: "not-allowed" },
			{ ...owner, linux: { ...owner.linux, startWallClock: "2026-01-01" } },
			{ ...owner, host: "h".repeat(256) },
			{ ...owner, platform: "p".repeat(33) },
			{ ...owner, pid: 0 },
			{ ...owner, pid: Number.MAX_SAFE_INTEGER + 1 },
			{ ...owner, linux: { ...owner.linux, pidNamespace: "pid:[1]/stat" } },
			{ ...owner, linux: { ...owner.linux, startTime: "9".repeat(21) } },
			{ ...owner, linux: { ...owner.linux, bootId: "not-a-uuid" } },
			{ ...owner, linux: { ...owner.linux, machineId: "not-a-machine-id" } },
		]) {
			expect(LockOwner.safeParse(invalid).success).toBe(false);
		}
	});

	it("publishes lossless field 22 through complex comm parsing and tolerates missing machine ID", async () => {
		const io = observation({ files: { "/etc/machine-id": osError("ENOENT") } });
		const owner = await currentLockOwner(io);
		expect(owner).toEqual({
			version: 1,
			host: "test-host",
			platform: "linux",
			pid: 73,
			linux: {
				bootId: "7d39e8a1-6b8f-4c27-86a1-59328cc73189",
				pidNamespace: "pid:[4026531836]",
				startTime: "9007199254740992",
			},
		});
		await expect(lockOwnerStatus(ownerFixture(), io)).resolves.toBe("live");
	});

	it("never trusts ESRCH without complete, PID-consistent local Linux evidence", async () => {
		const absent = () => {
			throw osError("ESRCH");
		};
		const results = await Promise.all(
			[
				observation({
					files: { "/proc/self/stat": procStat({ pid: 1 }) },
					probe: absent,
				}),
				observation({
					files: { "/proc/self/stat": "73 (truncated) S 1\n" },
					probe: absent,
				}),
				observation({
					files: { "/proc/self/stat": "x".repeat(4097) },
					probe: absent,
				}),
				observation({
					files: { "/proc/sys/kernel/random/boot_id": osError("EACCES") },
					probe: absent,
				}),
				observation({ namespace: osError("EPERM"), probe: absent }),
			].map(async (io) => ({
				owner: await currentLockOwner(io),
				status: await lockOwnerStatus(ownerFixture(), io),
			})),
		);
		for (const result of results) {
			expect(result.owner.linux).toBeUndefined();
			expect(result.status).toBe("unknown");
		}
		const { linux: _linux, ...legacy } = ownerFixture();
		await expect(
			lockOwnerStatus(legacy, observation({ probe: absent })),
		).resolves.toBe("unknown");
	});

	it("requires exactly one consistent NSpid before trusting any Linux death evidence", async () => {
		let probes = 0;
		const results = await Promise.all(
			[
				"Name:\tnode\nPid:\t73\n",
				"NSpid:\t73\t73\n",
				"NSpid:\t1\n",
				"NSpid:\t73\nNSpid:\t73\n",
				"NSpid:\tnot-a-pid\n",
				`NSpid:\t${"9".repeat(21)}\n`,
				`NSpid:\t73\n${"x".repeat(4097)}`,
				osError("EACCES"),
			].map(async (status) => {
				const io = observation({
					files: { "/proc/self/status": status },
					probe: () => {
						probes++;
						throw osError("ESRCH");
					},
				});
				return {
					owner: await currentLockOwner(io),
					status: await lockOwnerStatus(ownerFixture(), io),
				};
			}),
		);
		for (const result of results) {
			expect(result.owner.linux).toBeUndefined();
			expect(result.status).toBe("unknown");
		}
		expect(probes).toBe(0);
	});

	it("keeps a matching running identity live but detects adjacent, unsafe-in-Number start ticks", async () => {
		await expect(lockOwnerStatus(ownerFixture(), observation())).resolves.toBe(
			"live",
		);
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({
					files: {
						"/proc/41/stat": procStat({ startTime: "9007199254740993" }),
					},
				}),
			),
		).resolves.toBe("dead");
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({
					files: {
						"/proc/41/stat": procStat({ startTime: "09007199254740992" }),
					},
				}),
			),
		).resolves.toBe("live");
	});

	it("keeps zombie and exiting leaders live because other threads may still write", async () => {
		const statuses = await Promise.all(
			["Z", "X", "x"].map((state) =>
				lockOwnerStatus(
					ownerFixture(),
					observation({ files: { "/proc/41/stat": procStat({ state }) } }),
				),
			),
		);
		expect(statuses).toEqual(["live", "live", "live"]);
	});

	it("requires signal-zero proof of absence and handles exit between probe and stat", async () => {
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({
					probe: () => {
						throw osError("ESRCH");
					},
					files: { "/proc/41/stat": osError("ENOENT") },
				}),
			),
		).resolves.toBe("dead");
		let probes = 0;
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({
					probe: () => {
						if (probes++ > 0) {
							throw osError("ESRCH");
						}
					},
					files: { "/proc/41/stat": osError("ENOENT") },
				}),
			),
		).resolves.toBe("dead");
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({
					files: { "/proc/41/stat": osError("ENOENT") },
				}),
			),
		).resolves.toBe("unknown");
	});

	it("requires persistent same-host proof for a changed boot, regardless of namespace reuse", async () => {
		const files = {
			"/proc/sys/kernel/random/boot_id":
				"45dfe630-2ba0-4cf7-bb4a-dd8b2aa43bf5\n",
		} as const;
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({ files, namespace: "pid:[999]" }),
			),
		).resolves.toBe("dead");
		await expect(
			lockOwnerStatus(ownerFixture(), observation({ files })),
		).resolves.toBe("dead");
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({
					files: { ...files, "/etc/machine-id": osError("ENOENT") },
				}),
			),
		).resolves.toBe("unknown");
		const owner = ownerFixture();
		delete owner.linux!.machineId;
		await expect(lockOwnerStatus(owner, observation({ files }))).resolves.toBe(
			"unknown",
		);
		await expect(
			lockOwnerStatus(
				ownerFixture(),
				observation({ files, host: "other-host" }),
			),
		).resolves.toBe("unknown");
	});

	it("never probes foreign hosts, machines, namespaces, or platforms", async () => {
		let probes = 0;
		const probe = () => {
			probes++;
			throw osError("ESRCH");
		};
		const statuses = await Promise.all(
			[
				observation({ host: "foreign-host", probe }),
				observation({ platform: "darwin", probe }),
				observation({ namespace: "pid:[999]", probe }),
				observation({
					files: { "/etc/machine-id": "ffffffffffffffffffffffffffffffff" },
					probe,
				}),
				observation({
					files: {
						"/etc/machine-id": "ffffffffffffffffffffffffffffffff",
						"/proc/sys/kernel/random/boot_id":
							"45dfe630-2ba0-4cf7-bb4a-dd8b2aa43bf5",
					},
					probe,
				}),
			].map((io) => lockOwnerStatus(ownerFixture(), io)),
		);
		expect(statuses).toEqual([
			"unknown",
			"unknown",
			"unknown",
			"unknown",
			"unknown",
		]);
		expect(probes).toBe(0);
	});

	it("keeps denied, inaccessible, malformed, and PID-inconsistent target observations unknown", async () => {
		const statuses = await Promise.all(
			[
				observation({
					probe: () => {
						throw osError("EPERM");
					},
					files: { "/proc/41/stat": procStat({ state: "Z" }) },
				}),
				observation({ files: { "/proc/41/stat": osError("EACCES") } }),
				observation({ files: { "/proc/41/stat": "41 (truncated) Z 1\n" } }),
				observation({
					files: { "/proc/41/stat": procStat({ pid: 42, state: "Z" }) },
				}),
				observation({
					files: { "/proc/41/stat": procStat({ startTime: "not-digits" }) },
				}),
			].map((io) => lockOwnerStatus(ownerFixture(), io)),
		);
		expect(statuses).toEqual([
			"unknown",
			"unknown",
			"unknown",
			"unknown",
			"unknown",
		]);
	});

	it("uses conservative signal-zero status on non-Linux without touching procfs", async () => {
		const owner: LockOwner = {
			version: 1,
			host: "test-host",
			platform: "win32",
			pid: 41,
		};
		let reads = 0;
		const io: ObservationIO = {
			...observation({ platform: "win32" }),
			readFile: async () => {
				reads++;
				throw new Error("No procfs on Windows");
			},
			readLink: async () => {
				reads++;
				throw new Error("No procfs on Windows");
			},
		};
		expect(await currentLockOwner(io)).toEqual({ ...owner, pid: 73 });
		await expect(lockOwnerStatus(owner, io)).resolves.toBe("live");
		await expect(
			lockOwnerStatus(owner, {
				...io,
				probe: () => {
					throw osError("ESRCH");
				},
			}),
		).resolves.toBe("dead");
		await expect(
			lockOwnerStatus(owner, {
				...io,
				probe: () => {
					throw osError("EPERM");
				},
			}),
		).resolves.toBe("unknown");
		await expect(
			lockOwnerStatus({ ...owner, host: "other-host" }, io),
		).resolves.toBe("unknown");
		expect(reads).toBe(0);
	});
});
