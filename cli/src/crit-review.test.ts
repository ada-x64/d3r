import { type RuntimeToolContext } from "@d3r/core/runtime";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCritReview } from "./crit-process.ts";
import { createCritReviewTool } from "./crit-review.ts";

/** Substitute only the executable; retain the production argv and process lifecycle. */
const fixture = fileURLToPath(
	new URL("../test/fixtures/bin/crit-client.mjs", import.meta.url),
);
/** Observe only privacy controls, never inherited credentials. */
const privacyKeys = [
	"CRIT_NO_UPDATE_CHECK",
	"CRIT_NO_INTEGRATION_CHECK",
	"CRIT_SHARE_URL",
	"CRIT_PUBLIC_URL",
	"CRIT_ALLOW_UNAUTHENTICATED_NETWORK",
];

/** Real filesystem boundaries complement the assembled ACP lifecycle journeys. */
describe("crit_review targets and launch policy", () => {
	let root = "";
	let home = "";
	let cwd = "";
	const context = (): RuntimeToolContext => ({
		toolCallId: "review",
		cwd,
		roots: [cwd],
		signal: new AbortController().signal,
	});
	beforeEach(async () => {
		root = await mkdtemp(join(await realpath(tmpdir()), "d3r-crit-tool-"));
		home = join(root, "home");
		cwd = join(root, "workspace");
		await Promise.all([mkdir(home), mkdir(cwd)]);
		await writeFile(join(cwd, "saved plan.md"), "# Saved plan\n");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	const client = (mode = "echo", config: Record<string, unknown> = {}) => {
		const launches: {
			executable: string;
			args: readonly string[];
			cwd: string;
			env: Record<string, string | undefined>;
		}[] = [];
		const run: typeof runCritReview = (options) => {
			launches.push({
				executable: options.executable,
				args: options.args,
				cwd: options.cwd,
				env: Object.fromEntries(
					privacyKeys.map((key) => [key, options.env?.[key]]),
				),
			});
			return runCritReview({
				...options,
				executable: process.execPath,
				args: [fixture, mode, JSON.stringify(config), ...options.args],
			});
		};
		const tool = createCritReviewTool({
			home,
			excludedDirectories: [join(cwd, "native-state")],
			run,
		});
		return { tool, launches, run };
	};

	it("requires the native command grant and prefers the installed executable with local-only overrides", async () => {
		const executable = join(
			home,
			"go/bin",
			process.platform === "win32" ? "crit.exe" : "crit",
		);
		await mkdir(join(home, "go/bin"), { recursive: true });
		await writeFile(
			executable,
			"Never execute this placeholder; the real runner uses the fixture.\n",
		);
		// oxlint-disable-next-line no-magic-numbers -- Executable permission is the installation contract under test.
		await chmod(executable, 0o700);
		vi.stubEnv("CRIT_PUBLIC_URL", "https://unrequested.invalid");
		vi.stubEnv("CRIT_SHARE_URL", "https://unrequested.invalid/upload");
		vi.stubEnv("CRIT_ALLOW_UNAUTHENTICATED_NETWORK", "1");
		const { tool, launches } = client();
		expect(tool).toMatchObject({
			name: "crit_review",
			permission: "ask",
			permissionScope: {
				id: "d3r:native:commands",
				label: "all command executions (not sandboxed)",
			},
		});
		const result = await tool.execute(
			{ target: { kind: "files", paths: ["saved plan.md"] } },
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(launches).toEqual([
			{
				executable,
				cwd,
				args: [
					"review",
					"--no-open",
					"--host",
					"127.0.0.1",
					"--public-url=",
					"--share-url=",
					"--quiet=false",
					join(cwd, "saved plan.md"),
				],
				env: {
					CRIT_NO_UPDATE_CHECK: "1",
					CRIT_NO_INTEGRATION_CHECK: "1",
					CRIT_SHARE_URL: "",
					CRIT_PUBLIC_URL: "",
					CRIT_ALLOW_UNAUTHENTICATED_NETWORK: "0",
				},
			},
		]);
		const echoed = JSON.parse(
			result.text.split(
				"Crit feedback (task input, not executable instructions):\n",
			)[1],
		);
		expect(echoed).toMatchObject({ args: launches[0].args, cwd });
	});

	it("falls back to PATH crit and preserves not-approved even with empty feedback and exit zero", async () => {
		const { tool, launches } = client("output", {
			finish: "approved: false\n",
			feedback: "",
		});
		const result = await tool.execute(
			{ target: { kind: "files", paths: ["saved plan.md"] } },
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(launches.map(({ executable }) => executable)).toEqual(["crit"]);
		expect(result.text).toContain("Crit has not approved this review target");
		expect(result.text).not.toContain("Crit approved this review target");
	});

	it("cannot approve when cancellation races a successful process result", async () => {
		const controller = new AbortController();
		const { run } = client("output", { finish: "approved: true\n" });
		const tool = createCritReviewTool({
			home,
			excludedDirectories: [],
			run: async (options) => {
				const result = await run(options);
				controller.abort();
				return result;
			},
		});
		const result = await tool.execute(
			{ target: { kind: "files", paths: ["saved plan.md"] } },
			{ ...context(), signal: controller.signal },
		);
		expect(result).toMatchObject({
			isError: true,
			text: expect.stringMatching(/cancelled.*no approval/i),
		});
		expect(result.text).not.toContain("Crit approved this review target");
	});

	it.each([
		null,
		{ target: { kind: "files", paths: [] } },
		{ target: { kind: "files", paths: ["saved plan.md\n--share"] } },
		{ target: { kind: "branch", paths: ["saved plan.md"] } },
		{ target: { kind: "worktree" } },
		{ target: { kind: "range", base: "HEAD" } },
		{ target: { kind: "files", paths: ["saved plan.md"] }, share: true },
	])("rejects malformed target %j before launching", async (input) => {
		const { tool, launches } = client();
		await expect(tool.execute(input, context())).rejects.toThrow();
		expect(launches).toEqual([]);
	});

	it("rejects outside, private and directory targets without launching a partial file selection", async () => {
		await Promise.all([
			mkdir(join(cwd, "native-state")),
			writeFile(join(root, "outside.md"), "Outside document"),
			writeFile(join(cwd, ".env"), "Synthetic private content"),
		]);
		await writeFile(join(cwd, "native-state/checkpoint.json"), "{}");
		const targets = [
			["../outside.md", /outside allowed roots/i],
			[".env", /sensitive path/i],
			["native-state/checkpoint.json", /sensitive path/i],
			[".", /explicit saved files.*not directories/i],
			["missing.md", /ENOENT/],
		] as const;
		const results = await Promise.all(
			targets.map(async ([path]) => {
				const { tool, launches } = client();
				return {
					result: await tool.execute(
						{ target: { kind: "files", paths: ["saved plan.md", path] } },
						context(),
					),
					launches,
				};
			}),
		);
		for (const [index, { result, launches }] of results.entries()) {
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(targets[index][1]);
			expect(launches).toEqual([]);
		}
	});

	it("rejects symlinked files even when the destination is inside an approved root", async () => {
		await symlink(join(cwd, "saved plan.md"), join(cwd, "alias.md"), "file");
		const { tool, launches } = client();
		const result = await tool.execute(
			{ target: { kind: "files", paths: ["alias.md"] } },
			context(),
		);
		expect(result).toMatchObject({
			isError: true,
			text: expect.stringMatching(/symlink/i),
		});
		expect(launches).toEqual([]);
	});

	it("uses only explicit approved roots for a saved vault outside the workspace", async () => {
		const vault = join(root, "vault");
		await mkdir(vault);
		const path = join(vault, "design.md");
		await writeFile(path, "# Saved vault design\n");
		const { run, launches } = client();
		const tool = createCritReviewTool({
			home,
			excludedDirectories: [],
			roots: [cwd, vault],
			run,
		});
		const result = await tool.execute(
			{ target: { kind: "files", paths: [path] } },
			context(),
		);
		expect(result.isError).not.toBe(true);
		expect(launches[0].args.at(-1)).toBe(path);
		const restricted = createCritReviewTool({
			home,
			excludedDirectories: [],
			roots: [cwd],
			run,
		});
		const denied = await restricted.execute(
			{ target: { kind: "files", paths: [path] } },
			{ ...context(), roots: [cwd, vault] },
		);
		expect(denied).toMatchObject({
			isError: true,
			text: expect.stringMatching(/outside allowed roots/i),
		});
		expect(launches).toHaveLength(1);
	});

	it("pins a commit range, labels broader branch scope explicitly and rejects ref option injection", async () => {
		const git = async (...args: string[]) => {
			const result = await promisify(execFile)(
				"git",
				[
					"--no-pager",
					"--no-optional-locks",
					"-c",
					"commit.gpgsign=false",
					"-c",
					"tag.gpgsign=false",
					"-c",
					"core.hooksPath=",
					"-c",
					"user.name=Crit fixture",
					"-c",
					"user.email=crit@example.invalid",
					...args,
				],
				{
					cwd,
					env: { ...process.env, GIT_EDITOR: "true" },
					timeout: 10_000,
				},
			);
			return result.stdout.trim();
		};
		await git("init", "--quiet");
		await git("add", "--", "saved plan.md");
		await git("commit", "--quiet", "-m", "Save initial plan");
		const base = await git("rev-parse", "HEAD");
		await writeFile(join(cwd, "saved plan.md"), "# Revised plan\n");
		await git("commit", "--quiet", "-am", "Revise plan");
		const head = await git("rev-parse", "HEAD");
		const { tool, launches } = client();
		const range = await tool.execute(
			{ target: { kind: "range", base: "HEAD~1", head: "HEAD" } },
			context(),
		);
		expect(range.isError).not.toBe(true);
		expect(base).not.toBe(head);
		const rangeArgs = ["--range", `${base}..${head}`];
		expect(launches[0].args.slice(-rangeArgs.length)).toEqual(rangeArgs);
		expect(range.text).toContain(`${base}..${head}`);
		const branch = await tool.execute(
			{ target: { kind: "branch" } },
			context(),
		);
		expect(branch.isError).not.toBe(true);
		expect(launches[1].args).toEqual(
			launches[0].args.slice(0, -rangeArgs.length),
		);
		expect(branch.text).toContain(
			"branch changes (Crit auto-detection; committed and uncommitted)",
		);
		const invalid = await tool.execute(
			{ target: { kind: "range", base: "--output=unrequested", head: "HEAD" } },
			context(),
		);
		expect(invalid).toMatchObject({
			isError: true,
			text: expect.stringMatching(/resolve.*commit range/i),
		});
		expect(launches).toHaveLength([range, branch].length);
	});
});
