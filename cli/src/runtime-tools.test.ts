/* oxlint-disable init-declarations, no-magic-numbers -- Fixtures are initialized in beforeEach; numeric values are test data. */
import { createHash } from "node:crypto";
import {
	rename,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RuntimeClientServices,
	type RuntimeToolContext,
} from "@d3r/core/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWorkspaceTools,
	localCommandInvocation,
} from "./runtime-tools.ts";

/** Test tokens explicitly identify the caller's preimage, never a shared read cache. */
const token = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** Real disk fixtures exercise root containment and symlink behavior. */
// oxlint-disable-next-line max-statements -- Each test registers one independent workspace boundary case.
describe("workspace runtime tools", () => {
	let base: string;
	let cwd: string;
	let context: RuntimeToolContext;
	let tools: ReturnType<typeof createWorkspaceTools>;
	const execute = (name: string, args: unknown, ctx = context) =>
		tools.find((tool) => tool.name === name)!.execute(args, ctx);
	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), "d3r-workspace-"));
		cwd = join(base, "workspace");
		await mkdir(cwd);
		context = {
			toolCallId: "call-1",
			cwd,
			roots: [cwd],
			signal: new AbortController().signal,
		};
		tools = createWorkspaceTools({ cwd });
	});
	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("creates inert tools with explicit permission policies", () => {
		expect(tools.map(({ name }) => name)).toEqual([
			"read_file",
			"write_file",
			"edit_file",
			"list_directory",
			"search",
			"run_command",
		]);
		expect(
			tools
				.filter(({ permission }) => permission === "ask")
				.map(({ name }) => name),
		).toEqual(["write_file", "edit_file", "run_command"]);
		expect(
			tools.find(({ name }) => name === "run_command")!.description,
		).toContain("NOT A SANDBOX");
	});

	it("reads text with snapshots and one-based locations", async () => {
		await writeFile(join(cwd, "notes.txt"), "one\ntwo\nthree");
		const result = await execute("read_file", {
			path: "notes.txt",
			startLine: 2,
			endLine: 2,
		});
		expect(result.text).toMatch(/^Snapshot: [a-f0-9]{64}\n2: two$/);
		expect(result.locations).toEqual([
			{ path: join(cwd, "notes.txt"), line: 2 },
		]);
	});

	it("preserves UTF-8 BOMs in snapshots and actual diffs", async () => {
		const path = join(cwd, "bom.txt");
		await writeFile(path, "\uFEFFold");
		await execute("read_file", { path });
		const result = await execute("edit_file", {
			path,
			snapshot: token("\uFEFFold"),
			oldText: "old",
			newText: "new",
		});
		expect(await readFile(path, "utf8")).toBe("\uFEFFnew");
		expect(result.content).toEqual([
			{ type: "diff", path, oldText: "\uFEFFold", newText: "\uFEFFnew" },
		]);
	});

	it("coordinates mutations from independent factories with an exclusive disk lock", async () => {
		const path = join(cwd, "shared.txt");
		await writeFile(path, "old");
		const other = createWorkspaceTools({ cwd });
		await Promise.all([
			execute("read_file", { path }),
			other
				.find((tool) => tool.name === "read_file")!
				.execute({ path }, context),
		]);
		const outcomes = await Promise.allSettled([
			execute("write_file", { path, content: "first", snapshot: token("old") }),
			other
				.find((tool) => tool.name === "write_file")!
				.execute({ path, content: "second", snapshot: token("old") }, context),
		]);
		expect(
			outcomes.filter(({ status }) => status === "fulfilled"),
		).toHaveLength(1);
		expect(["first", "second"]).toContain(await readFile(path, "utf8"));
	});

	it("refuses partial client filesystem capabilities for mutations", async () => {
		const path = join(cwd, "notes.txt");
		await writeFile(path, "disk");
		await execute("read_file", { path });
		const writeTextFile = vi.fn();
		const ctx = {
			...context,
			client: { requestPermission: vi.fn(), writeTextFile },
		};
		await expect(
			execute("write_file", { path, content: "bad" }, ctx),
		).rejects.toThrow(/both readTextFile and writeTextFile/);
		expect(writeTextFile).not.toHaveBeenCalled();
	});

	it("creates a file and returns an actual null-to-text diff", async () => {
		const result = await execute("write_file", {
			path: "new.txt",
			content: "hello",
		});
		expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("hello");
		expect(result.content).toEqual([
			{
				type: "diff",
				path: join(cwd, "new.txt"),
				oldText: null,
				newText: "hello",
			},
		]);
	});

	it("requires an explicit token for overwrites and publishes shorter replacements", async () => {
		await writeFile(join(cwd, "notes.txt"), "long old content");
		await expect(
			execute("write_file", { path: "notes.txt", content: "new" }),
		).rejects.toThrow(/snapshot/);
		await execute("read_file", { path: "notes.txt" });
		const result = await execute("write_file", {
			path: "notes.txt",
			snapshot: token("long old content"),
			content: "new",
		});
		expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("new");
		expect(result.content).toEqual([
			{
				type: "diff",
				path: join(cwd, "notes.txt"),
				oldText: "long old content",
				newText: "new",
			},
		]);
	});

	it("does not let another role's read or write authorize an omitted snapshot", async () => {
		const path = join(cwd, "roles.txt");
		await writeFile(path, "v1");
		await execute(
			"read_file",
			{ path },
			{ ...context, toolCallId: "role-a-read" },
		);
		await execute(
			"write_file",
			{ path, content: "v2", snapshot: token("v1") },
			{ ...context, toolCallId: "role-b-write" },
		);
		await expect(
			execute("write_file", { path, content: "stale" }),
		).rejects.toThrow(/snapshot/);
		await expect(
			execute("edit_file", { path, oldText: "v2", newText: "stale" }),
		).rejects.toThrow(/snapshot/);
		await expect(
			execute("write_file", { path, content: "stale", snapshot: token("v1") }),
		).rejects.toThrow(/Stale/);
		expect(await readFile(path, "utf8")).toBe("v2");
	});

	it("rejects a root replaced by a symlink before a later read or write", async () => {
		await writeFile(join(cwd, "file.txt"), "trusted");
		await execute("read_file", { path: "file.txt" });
		const moved = join(base, "original");
		await rename(cwd, moved);
		const outside = join(base, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "file.txt"), "outside");
		await symlink(
			outside,
			cwd,
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(execute("read_file", { path: "file.txt" })).rejects.toThrow(
			/root.*symlink/,
		);
		await expect(
			execute("write_file", {
				path: "file.txt",
				content: "bad",
				snapshot: token("trusted"),
			}),
		).rejects.toThrow(/root.*symlink/);
		expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("outside");
	});

	it("refuses stale snapshots without modifying the newer file", async () => {
		await writeFile(join(cwd, "notes.txt"), "original");
		await execute("read_file", { path: "notes.txt" });
		await writeFile(join(cwd, "notes.txt"), "external change");
		await expect(
			execute("edit_file", {
				path: "notes.txt",
				snapshot: token("original"),
				oldText: "external",
				newText: "agent",
			}),
		).rejects.toThrow(/Stale/);
		expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe(
			"external change",
		);
	});

	it("requires exact match counts, preserving dollar replacement text literally", async () => {
		await writeFile(join(cwd, "notes.txt"), "old old");
		await execute("read_file", { path: "notes.txt" });
		await expect(
			execute("edit_file", {
				path: "notes.txt",
				snapshot: token("old old"),
				oldText: "old",
				newText: "new",
			}),
		).rejects.toThrow("found 2");
		await expect(
			execute("edit_file", {
				path: "notes.txt",
				snapshot: token("old old"),
				oldText: "missing",
				newText: "new",
			}),
		).rejects.toThrow("found 0");
		await execute("edit_file", {
			path: "notes.txt",
			snapshot: token("old old"),
			oldText: "old",
			newText: "$&",
			expectedMatches: 2,
		});
		expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("$& $&");
	});

	it("rejects parent/prefix traversal and context attempts to widen factory roots", async () => {
		const other = join(base, "workspace-other");
		await mkdir(other);
		await writeFile(join(other, "notes.txt"), "outside");
		await Promise.all(
			["../workspace-other/notes.txt", join(other, "notes.txt")].map(
				async (path) => {
					await expect(
						execute("read_file", { path }, { ...context, roots: [base] }),
					).rejects.toThrow(/outside allowed roots/);
					await expect(
						execute("write_file", { path, content: "bad" }),
					).rejects.toThrow(/outside allowed roots/);
				},
			),
		);
	});

	it("allows explicit additional roots and honors narrower turn roots", async () => {
		const other = join(base, "additional");
		await mkdir(other);
		await writeFile(join(other, "notes.txt"), "allowed");
		tools = createWorkspaceTools({ cwd, additionalDirectories: [other] });
		const result = await execute(
			"read_file",
			{ path: join(other, "notes.txt") },
			{ ...context, roots: [cwd, other] },
		);
		expect(result.text).toContain("allowed");
		await expect(
			execute("read_file", { path: join(other, "notes.txt") }),
		).rejects.toThrow(/outside allowed roots/);
	});

	it.each([
		".env",
		".envrc",
		".git-credentials",
		"auth-store.json",
		".env.local",
		"service.env",
		"auth.json",
		"credentials.json",
		"private.key",
		"certificate.pem",
		".git/config",
		".ssh/id_ed25519",
		".agents/sessions/turn.json",
		".agents/private/data",
	])("denies sensitive reads and writes: %s", async (path) => {
		await expect(execute("read_file", { path })).rejects.toThrow(
			/Sensitive path/,
		);
		await expect(
			execute("write_file", { path, content: "bad" }),
		).rejects.toThrow(/Sensitive path/);
	});

	it("refuses symlink escapes and links replaced after a read", async () => {
		const outside = join(base, "outside.txt");
		await writeFile(outside, "private");
		await symlink(outside, join(cwd, "link.txt"), "file");
		await symlink(
			base,
			join(cwd, "linked-directory"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await Promise.all(
			["link.txt", "linked-directory/outside.txt"].map(async (path) => {
				await expect(execute("read_file", { path })).rejects.toThrow(/Symlink/);
				await expect(
					execute("write_file", { path, content: "bad" }),
				).rejects.toThrow(/Symlink/);
			}),
		);
		await writeFile(join(cwd, "replace.txt"), "old");
		await execute("read_file", { path: "replace.txt" });
		await rm(join(cwd, "replace.txt"));
		await symlink(outside, join(cwd, "replace.txt"), "file");
		await expect(
			execute("edit_file", {
				path: "replace.txt",
				snapshot: token("old"),
				oldText: "old",
				newText: "bad",
			}),
		).rejects.toThrow(/Symlink/);
		expect(await readFile(outside, "utf8")).toBe("private");
	});

	it("prefers unsaved buffers and emits their actual old/new diff", async () => {
		const path = join(cwd, "notes.txt");
		await writeFile(path, "disk");
		let buffer = "unsaved";
		const client: RuntimeClientServices = {
			requestPermission: vi.fn(),
			readTextFile: vi.fn(async () => buffer),
			writeTextFile: vi.fn(async (_, content) => {
				buffer = content;
			}),
		};
		const ctx = { ...context, client };
		const read = await execute("read_file", { path }, ctx);
		expect(read.text).toContain("unsaved");
		const result = await execute(
			"edit_file",
			{
				path,
				oldText: "unsaved",
				newText: "edited",
				snapshot: token("unsaved"),
			},
			ctx,
		);
		expect(result.content).toEqual([
			{ type: "diff", path, oldText: "unsaved", newText: "edited" },
		]);
		expect(buffer).toBe("edited");
		expect(await readFile(path, "utf8")).toBe("disk");
		expect(client.requestPermission).not.toHaveBeenCalled();
	});

	it("does not fall back to disk when a negotiated buffer read fails", async () => {
		await writeFile(join(cwd, "notes.txt"), "disk");
		const client: RuntimeClientServices = {
			requestPermission: vi.fn(),
			readTextFile: vi.fn(async () => {
				throw new Error("editor unavailable");
			}),
		};
		await expect(
			execute("read_file", { path: "notes.txt" }, { ...context, client }),
		).rejects.toThrow("editor unavailable");
	});

	it("refuses simultaneous mutations rather than overwriting a concurrent buffer edit", async () => {
		const path = join(cwd, "notes.txt");
		await writeFile(path, "old");
		let release!: () => void;
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const client: RuntimeClientServices = {
			requestPermission: vi.fn(),
			readTextFile: async () => "old",
			writeTextFile: async () => {
				started();
				await waiting;
			},
		};
		const ctx = { ...context, client };
		await execute("read_file", { path }, ctx);
		const first = execute(
			"write_file",
			{ path, content: "first", snapshot: token("old") },
			ctx,
		);
		void first.catch(() => started());
		await entered;
		try {
			await expect(
				execute(
					"write_file",
					{ path, content: "second", snapshot: token("old") },
					ctx,
				),
			).rejects.toThrow(/Concurrent mutation/);
		} finally {
			release();
			await first;
		}
	});

	it("cancels before any mutation or subprocess/client command", async () => {
		const signal = AbortSignal.abort(new Error("cancelled"));
		const runCommand = vi.fn();
		const ctx = {
			...context,
			signal,
			client: { requestPermission: vi.fn(), runCommand },
		};
		await expect(
			execute("write_file", { path: "new.txt", content: "bad" }, ctx),
		).rejects.toThrow("cancelled");
		await expect(
			execute("run_command", { command: process.execPath }, ctx),
		).rejects.toThrow("cancelled");
		expect(runCommand).not.toHaveBeenCalled();
		await expect(readFile(join(cwd, "new.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("checks abort again after an asynchronous editor read", async () => {
		await writeFile(join(cwd, "notes.txt"), "old");
		await execute("read_file", { path: "notes.txt" });
		const controller = new AbortController();
		const writeTextFile = vi.fn();
		const ctx = {
			...context,
			signal: controller.signal,
			client: {
				requestPermission: vi.fn(),
				readTextFile: async () => {
					controller.abort(new Error("cancelled during read"));
					return "old";
				},
				writeTextFile,
			},
		};
		await expect(
			execute("write_file", { path: "notes.txt", content: "bad" }, ctx),
		).rejects.toThrow(/cancelled/);
		expect(writeTextFile).not.toHaveBeenCalled();
	});

	it("lists and searches the vault but excludes private stores and links", async () => {
		await mkdir(join(cwd, ".agents", "vault"), { recursive: true });
		await mkdir(join(cwd, ".git"));
		await writeFile(join(cwd, ".agents", "vault", "note.md"), "needle\nNEEDLE");
		await writeFile(join(cwd, ".git", "config"), "needle secret");
		await writeFile(join(cwd, ".env"), "needle secret");
		await writeFile(join(cwd, "binary"), Buffer.from([0, 1]));
		const listed = await execute("list_directory", {});
		expect(listed.text).not.toMatch(/\.env|\.git/);
		const result = await execute("search", { query: "needle", maxResults: 1 });
		expect(result.text).toContain("note.md:1: needle");
		expect(result.text).toContain("[Search truncated]");
		expect(result.text).not.toContain("secret");
		expect(result.locations).toEqual([
			{ path: join(cwd, ".agents", "vault", "note.md"), line: 1 },
		]);
	});

	it("rejects binary and oversized text", async () => {
		await writeFile(join(cwd, "binary"), Buffer.from([0, 1]));
		await writeFile(join(cwd, "large"), Buffer.alloc(1024 * 1024 + 1, "x"));
		await expect(execute("read_file", { path: "binary" })).rejects.toThrow(
			/Binary/,
		);
		await expect(execute("read_file", { path: "large" })).rejects.toThrow(
			/exceeds/,
		);
	});

	it("runs a real subprocess with literal argv and combines stderr", async () => {
		const literal = '$(not-executed); & spaces "quoted"';
		const result = await execute("run_command", {
			command: process.execPath,
			args: [
				"-e",
				"process.stdout.write(process.argv[1]); process.stderr.write(' stderr')",
				literal,
			],
		});
		expect(result.text).toContain(literal);
		expect(result.text).toContain("stderr");
		expect(result.isError).toBe(false);
	});

	it("caps output, reports failure exits, and times out real subprocesses", async () => {
		const result = await execute("run_command", {
			command: process.execPath,
			args: [
				"-e",
				"process.stdout.write('x'.repeat(100000)); process.exitCode = 7",
			],
		});
		expect(result.text.length).toBeLessThan(66_000);
		expect(result.text).toContain("truncated");
		expect(result.text).toContain("Exit code: 7");
		expect(result.isError).toBe(true);
		await expect(
			execute("run_command", {
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				timeoutMs: 100,
			}),
		).rejects.toThrow(/timed out/);
	});

	it("uses negotiated command services and bounds non-cooperating clients", async () => {
		const runCommand = vi.fn(async () => ({
			output: "client output",
			exitCode: 0,
			terminalId: "terminal-1",
		}));
		const ctx = {
			...context,
			client: { requestPermission: vi.fn(), runCommand },
		};
		const result = await execute(
			"run_command",
			{ command: "echo", args: ["literal"] },
			ctx,
		);
		expect(runCommand).toHaveBeenCalledWith(
			{ command: "echo", args: ["literal"], cwd },
			expect.any(AbortSignal),
		);
		expect(result.content).toContainEqual({
			type: "terminal",
			terminalId: "terminal-1",
		});
		const hung = {
			...ctx,
			client: {
				...ctx.client,
				runCommand: () => new Promise<never>(() => undefined),
			},
		};
		await expect(
			execute("run_command", { command: "echo", timeoutMs: 20 }, hung),
		).rejects.toThrow(/timed out/);
	});

	it("handles Windows batch startup without interpolating unsafe arguments", () => {
		const invocation = localCommandInvocation(
			{ command: "C:\\Program Files\\tool.cmd", args: ["hello world"], cwd },
			"win32",
		);
		expect(invocation.windowsVerbatimArguments).toBe(true);
		expect(invocation.args).toEqual([
			"/d",
			"/s",
			"/c",
			String.raw`""C:\Program Files\tool.cmd" "hello world""`,
		]);
		for (const arg of [
			"& whoami",
			"%SECRET%",
			"!secret!",
			"line\nbreak",
			'bad"quote',
		]) {
			expect(() =>
				localCommandInvocation(
					{ command: "tool.cmd", args: [arg], cwd },
					"win32",
				),
			).toThrow(/Unsafe/);
		}
	});
});
