// Behavioural tests for the `install` adapter verb. We pin the
// regression fixes from the audit (empty version override, success
// notice gating, ENOENT translation, npm-argv shape) and the pure
// seams of `planInstall` and `readInstalledVersion`. The verb name
// and the adapter package name are sourced from the verb registry
// and the `ADAPTERS` table respectively so this fixture cannot
// silently drift from production.

import { runCommand } from "citty";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADAPTERS } from "../src/utils/data.ts";
import { readInstalledVersion } from "../src/utils/helpers.ts";
import {
	executeInstall,
	materializeAgents,
	planInstall,
	type PlannedInstall,
} from "../src/verbs/install.ts";
import { ALL_VERBS } from "../src/verbs/registry.ts";

// Sourced from the verb registry to keep the test honest about
// which command this file actually exercises.
const INSTALL_VERB = ALL_VERBS.find((v) => v.name === "install");
if (!INSTALL_VERB) {
	throw new Error("registry has no install verb");
}

const piPkg = (): string => {
	const entry = ADAPTERS.pi;
	if (!entry) {
		throw new Error("ADAPTERS table is missing the pi entry");
	}
	return entry.pkg;
};

interface ExitSpyState {
	exitCalled: number | null;
	stderr: string[];
	stdout: string[];
}

const installExitSpies = (): ExitSpyState => {
	const state: ExitSpyState = { exitCalled: null, stderr: [], stdout: [] };
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		state.exitCalled = code ?? 0;
		throw new Error(`exit:${code ?? 0}`);
	}) as never);
	vi.spyOn(process.stderr, "write").mockImplementation(((
		chunk: string | Uint8Array,
	) => {
		state.stderr.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
		);
		return true;
	}) as never);
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		state.stdout.push(parts.map((p) => String(p)).join(" "));
	});
	return state;
};

describe("install / planInstall", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the pinned version when no override is supplied", () => {
		const plan = planInstall("pi");
		expect(plan.id).toBe("pi");
		expect(plan.entry.pkg).toBe(piPkg());
		// The pinned version is whatever cli/package.json carries; just
		// assert the plan reflects it (npm-argv shape pins the rest).
		expect(plan.version).toBeTruthy();
	});

	it("falls back to the pinned version when the override is empty", () => {
		const baseline = planInstall("pi");
		const empty = planInstall("pi@");
		expect(empty.version).toBe(baseline.version);
		expect(empty.npmArgs).toEqual(baseline.npmArgs);
	});

	it("honours an explicit version override", () => {
		const plan = planInstall("pi@9.9.9");
		expect(plan.version).toBe("9.9.9");
		expect(plan.npmArgs.at(-1)).toBe(`${piPkg()}@9.9.9`);
	});

	it("emits a plain `<pkg>@<ver>` spec with no `npm:` alias prefix", () => {
		const plan = planInstall("pi@1.2.3");
		expect(plan.npmArgs).toEqual([
			"install",
			"--prefix",
			plan.target,
			`${piPkg()}@1.2.3`,
		]);
		for (const arg of plan.npmArgs) {
			expect(arg.startsWith("npm:")).toBe(false);
		}
	});

	it("dies on an unknown adapter id", () => {
		const state = installExitSpies();
		expect(() => planInstall("nope")).toThrow("exit:1");
		expect(state.exitCalled).toBe(1);
		expect(state.stderr.join("")).toContain("unknown adapter 'nope'");
	});
});

describe("install / readInstalledVersion", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "d3r-install-read-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns null when the package is not installed", () => {
		expect(readInstalledVersion(dir, piPkg())).toBeNull();
	});

	it("reads the installed version from node_modules/<pkg>/package.json", () => {
		const pkgDir = join(dir, "node_modules", piPkg());
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: piPkg(), version: "4.5.6" }),
		);
		expect(readInstalledVersion(dir, piPkg())).toBe("4.5.6");
		// idempotent: a second call against the same fixture yields the
		// same answer with no observable side effect.
		expect(readInstalledVersion(dir, piPkg())).toBe("4.5.6");
	});

	it("returns null on an unparseable package.json", () => {
		const pkgDir = join(dir, "node_modules", piPkg());
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), "not json");
		expect(readInstalledVersion(dir, piPkg())).toBeNull();
	});
});

describe("install / executeInstall", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dry-run prints the argv and never invokes the runner", async () => {
		const state = installExitSpies();
		const runner = vi.fn();
		await executeInstall(
			"pi@1.2.3",
			{ dryRun: true },
			{ runner, readInstalled: () => null },
		);
		expect(runner).not.toHaveBeenCalled();
		expect(state.stdout.join("\n")).toContain(`${piPkg()}@`);
	});

	it("resolves workspace specs to the on-disk package directory", async () => {
		const state = installExitSpies();
		const runner = vi.fn().mockResolvedValue(0);
		const materialize = vi.fn().mockResolvedValue(0);
		// `cli/package.json` pins `@d3r/adapter-pi` at `workspace:*`. npm
		// rejects the `workspace:` protocol with EUNSUPPORTEDPROTOCOL, so
		// the verb must translate dev pins to the resolved adapter
		// directory before invoking npm. We assert the runner sees an
		// absolute path that ends in the adapter package layout, not the
		// raw `workspace:*` token.
		await executeInstall(
			"pi",
			{},
			{ runner, readInstalled: () => null, materialize },
		);
		expect(runner).toHaveBeenCalledOnce();
		const args = runner.mock.calls[0][1] as readonly string[];
		const spec = args[args.length - 1];
		expect(spec.startsWith("/")).toBe(true);
		expect(spec).toMatch(/adapters[\\/]pi$/);
		expect(args.some((a) => a.includes("workspace:"))).toBe(false);
		expect(state.stderr.join("")).not.toContain("dev install detected");
	});

	it("short-circuits when the requested version is already installed", async () => {
		const state = installExitSpies();
		const runner = vi.fn();
		await executeInstall(
			"pi@1.2.3",
			{},
			{ runner, readInstalled: () => "1.2.3" },
		);
		expect(runner).not.toHaveBeenCalled();
		expect(state.stdout.join("\n")).toContain("already installed at 1.2.3");
	});

	it("--force re-runs even when the version matches", async () => {
		installExitSpies();
		const runner = vi.fn(async () => 0);
		const materialize = vi.fn().mockResolvedValue(0);
		await executeInstall(
			"pi@1.2.3",
			{ force: true },
			{ runner, readInstalled: () => "1.2.3", materialize },
		);
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("prints the upgrade notice only after a successful npm exit", async () => {
		const state = installExitSpies();
		const runner = vi.fn(async () => 0);
		const materialize = vi.fn().mockResolvedValue(0);
		await executeInstall(
			"pi@1.2.3",
			{},
			{ runner, readInstalled: () => "0.0.1", materialize },
		);
		expect(runner).toHaveBeenCalledTimes(1);
		expect(state.stdout.join("\n")).toContain("upgraded 0.0.1 -> 1.2.3");
	});

	it("materializes adapter agents into <piConfigDir>/agents after a successful npm install", async () => {
		const MATERIALIZED_COUNT = 7;
		const state = installExitSpies();
		const runner = vi.fn(async () => 0);
		const materialize = vi.fn().mockResolvedValue(MATERIALIZED_COUNT);
		await executeInstall(
			"pi@1.2.3",
			{},
			{ runner, readInstalled: () => null, materialize },
		);
		expect(materialize).toHaveBeenCalledTimes(1);
		const plan = materialize.mock.calls[0][0] as PlannedInstall;
		expect(plan.entry.pkg).toBe(piPkg());
		expect(state.stdout.join("\n")).toContain(
			`materialized ${MATERIALIZED_COUNT} agents into ${plan.configDir}`,
		);
	});

	it("skips materialize and the notice when npm exits non-zero", async () => {
		const NPM_FAIL_CODE = 2;
		const state = installExitSpies();
		const runner = vi.fn(async () => NPM_FAIL_CODE);
		const materialize = vi.fn();
		await expect(
			executeInstall(
				"pi@1.2.3",
				{},
				{ runner, readInstalled: () => null, materialize },
			),
		).rejects.toThrow(`exit:${NPM_FAIL_CODE}`);
		expect(materialize).not.toHaveBeenCalled();
		expect(state.stdout.join("\n")).not.toContain("materialized");
	});

	it("translates a materialize failure into the standard die() shape", async () => {
		const state = installExitSpies();
		const runner = vi.fn(async () => 0);
		const materialize = vi.fn().mockRejectedValue(new Error("disk full"));
		await expect(
			executeInstall(
				"pi@1.2.3",
				{},
				{ runner, readInstalled: () => null, materialize },
			),
		).rejects.toThrow("exit:1");
		expect(state.stderr.join("")).toContain(
			"failed to materialize agents: disk full",
		);
	});

	it("suppresses the materialize notice when zero agents land", async () => {
		const state = installExitSpies();
		const runner = vi.fn(async () => 0);
		const materialize = vi.fn().mockResolvedValue(0);
		await executeInstall(
			"pi@1.2.3",
			{},
			{ runner, readInstalled: () => null, materialize },
		);
		expect(state.stdout.join("\n")).not.toContain("materialized");
	});

	it("suppresses the upgrade notice when npm exits non-zero", async () => {
		const NPM_FAIL_CODE = 2;
		const state = installExitSpies();
		const runner = vi.fn(async () => NPM_FAIL_CODE);
		await expect(
			executeInstall("pi@1.2.3", {}, { runner, readInstalled: () => "0.0.1" }),
		).rejects.toThrow(`exit:${NPM_FAIL_CODE}`);
		expect(state.stdout.join("\n")).not.toContain("upgraded");
	});

	it("translates ENOENT from the spawn-error path into the standard die() shape", async () => {
		const state = installExitSpies();
		const runner = vi.fn(async () => {
			const err: NodeJS.ErrnoException = Object.assign(
				new Error("spawn npm ENOENT"),
				{ code: "ENOENT" },
			);
			throw err;
		});
		await expect(
			executeInstall("pi@1.2.3", {}, { runner, readInstalled: () => null }),
		).rejects.toThrow("exit:1");
		const err = state.stderr.join("");
		expect(err.startsWith("error: ")).toBe(true);
		expect(err).toContain("npm not found on PATH");
	});

	it("defaults the adapter positional to `pi` when invoked bare", async () => {
		const state = installExitSpies();
		const command = await INSTALL_VERB.load();
		await runCommand(command, { rawArgs: ["--dry-run"] });
		// dry-run prints the planned argv; for workspace pins this is the
		// resolved on-disk adapter directory, which proves the pi adapter
		// was selected without the user typing it.
		expect(state.stdout.join("\n")).toMatch(/adapters[\\/]pi/);
	});

	it("still resolves an explicit `pi` positional", async () => {
		const state = installExitSpies();
		const command = await INSTALL_VERB.load();
		await runCommand(command, { rawArgs: ["pi", "--dry-run"] });
		expect(state.stdout.join("\n")).toMatch(/adapters[\\/]pi/);
	});

	it("still honours an explicit version override on the positional", async () => {
		const state = installExitSpies();
		const command = await INSTALL_VERB.load();
		await runCommand(command, { rawArgs: ["pi@1.2.3", "--dry-run"] });
		expect(state.stdout.join("\n")).toContain(`${piPkg()}@1.2.3`);
	});

	it("translates non-ENOENT spawn errors into the standard die() shape", async () => {
		const state = installExitSpies();
		const runner = vi.fn(async () => {
			throw new Error("unrelated");
		});
		await expect(
			executeInstall("pi@1.2.3", {}, { runner, readInstalled: () => null }),
		).rejects.toThrow("exit:1");
		expect(state.stderr.join("")).toContain("failed to spawn npm");
	});
});

describe("install / materializeAgents", () => {
	let root = "";

	const makePlan = (
		overrides: Partial<PlannedInstall> = {},
	): PlannedInstall => {
		const entry = ADAPTERS.pi;
		if (!entry) {
			throw new Error("ADAPTERS.pi missing");
		}
		const configDir = join(root, "piconf");
		const target = entry.target(configDir);
		return {
			entry,
			id: "pi",
			version: "1.2.3",
			target,
			configDir,
			npmCmd: "npm",
			npmArgs: [],
			isDev: false,
			...overrides,
		};
	};

	const seedAdapterAgents = (plan: PlannedInstall, names: string[]): string => {
		const pkgDir = join(plan.target, "node_modules", plan.entry.pkg);
		const agentsSrc = join(pkgDir, "dist", "agents");
		mkdirSync(agentsSrc, { recursive: true });
		for (const name of names) {
			writeFileSync(join(agentsSrc, name), `# ${name}\n`);
		}
		return agentsSrc;
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "d3r-install-mat-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("copies every adapter agent into <configDir>/agents for published installs", async () => {
		const MD_COUNT = 2; // README.txt is filtered out
		const plan = makePlan({ isDev: false });
		seedAdapterAgents(plan, ["orchestrator.md", "researcher.md", "README.txt"]);

		const count = await materializeAgents(plan);

		expect(count).toBe(MD_COUNT);
		const dst = join(plan.configDir, "agents");
		expect(readdirSync(dst).toSorted()).toEqual([
			"orchestrator.md",
			"researcher.md",
		]);
		for (const name of ["orchestrator.md", "researcher.md"]) {
			const stat = lstatSync(join(dst, name));
			expect(stat.isSymbolicLink()).toBe(false);
			expect(readFileSync(join(dst, name), "utf8")).toBe(`# ${name}\n`);
		}
	});

	it("symlinks every adapter agent into <configDir>/agents for dev installs", async () => {
		const plan = makePlan({ isDev: true });
		const src = seedAdapterAgents(plan, ["orchestrator.md"]);

		const count = await materializeAgents(plan);

		expect(count).toBe(1);
		const link = join(plan.configDir, "agents", "orchestrator.md");
		const stat = lstatSync(link);
		expect(stat.isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(join(src, "orchestrator.md"));
	});

	it("replaces a pre-existing entry with the same basename (idempotent upgrade)", async () => {
		const plan = makePlan({ isDev: false });
		seedAdapterAgents(plan, ["orchestrator.md"]);
		// Pre-seed a stale file from a prior install at the destination.
		const dst = join(plan.configDir, "agents");
		mkdirSync(dst, { recursive: true });
		writeFileSync(join(dst, "orchestrator.md"), "STALE\n");

		await materializeAgents(plan);

		expect(readFileSync(join(dst, "orchestrator.md"), "utf8")).toBe(
			"# orchestrator.md\n",
		);
	});

	it("replaces a pre-existing symlink at the destination on upgrade", async () => {
		const plan = makePlan({ isDev: true });
		const src = seedAdapterAgents(plan, ["orchestrator.md"]);
		const dst = join(plan.configDir, "agents");
		mkdirSync(dst, { recursive: true });
		// Pre-seed a dangling symlink that an earlier dev install left behind.
		const link = join(dst, "orchestrator.md");
		const { symlinkSync } = await import("node:fs");
		symlinkSync("/nowhere/old.md", link);

		await materializeAgents(plan);

		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(join(src, "orchestrator.md"));
	});

	it("is a no-op when the adapter ships no dist/agents directory", async () => {
		const plan = makePlan();
		// Note: do NOT seed an agents/ source. Adapter has nothing to mirror.
		mkdirSync(join(plan.target, "node_modules", plan.entry.pkg), {
			recursive: true,
		});

		const count = await materializeAgents(plan);

		expect(count).toBe(0);
		// Destination must not be created when there's nothing to write.
		expect(() => readdirSync(join(plan.configDir, "agents"))).toThrow();
	});

	it("is a no-op when dist/agents exists but contains no markdown", async () => {
		const plan = makePlan();
		seedAdapterAgents(plan, ["README.txt"]);

		const count = await materializeAgents(plan);

		expect(count).toBe(0);
	});
});
