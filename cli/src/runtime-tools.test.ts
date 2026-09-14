/* oxlint-disable init-declarations, no-magic-numbers -- Fixtures are initialized in beforeEach; numeric values are test data. */
import { createHash } from "node:crypto";
import {
	rename,
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
					await expect(
						execute(
							"search",
							{ path, query: "outside" },
							{ ...context, roots: [base] },
						),
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
		const search = await execute(
			"search",
			{ path: other, query: "allowed" },
			{ ...context, roots: [cwd, other] },
		);
		expect(search.text).toBe(`${join(other, "notes.txt")}:1: allowed`);
		await expect(
			execute("read_file", { path: join(other, "notes.txt") }),
		).rejects.toThrow(/outside allowed roots/);
		await expect(
			execute("search", { path: other, query: "allowed" }),
		).rejects.toThrow(/outside allowed roots/);
	});

	it.each([
		".env",
		".envrc",
		".git-credentials",

		".env.local",
		"service.env",

		"private.key",
		"certificate.pem",
		".git/config",
		".ssh/id_ed25519",
		".agents/sessions/turn.json",
		".agents/private/data",
		".agents/d3r/private/credentials.json",
		".agents/d3r/private/sessions/turn.json",
		".agents/d3r/private/renamed.data",
	])("denies sensitive reads, writes and searches: %s", async (path) => {
		await expect(execute("read_file", { path })).rejects.toThrow(
			/Sensitive path/,
		);
		await expect(
			execute("write_file", { path, content: "bad" }),
		).rejects.toThrow(/Sensitive path/);
		await expect(execute("search", { path, query: "secret" })).rejects.toThrow(
			/Sensitive path/,
		);
	});

	it("reads, lists, searches, and edits security implementation names without treating them as secret stores", async () => {
		const paths = [
			"cli/src/verbs/auth.ts",
			"adapters/pi/auth.ts",
			"adapters/pi/auth-store.ts",
			"adapters/acp/secrets.ts",
			"src/auth/credentials/secrets/tokens/keys/index.ts",
			"docs/secrets.md",
			"auth.json",
			"auth-store.json",
			"credentials.json",
		];
		const source =
			"PUBLIC_SOURCE: security implementation or documented schema, not a live credential";
		await Promise.all(
			paths.map(async (path) => {
				await mkdir(dirname(join(cwd, path)), { recursive: true });
				await writeFile(join(cwd, path), source);
			}),
		);
		await Promise.all(
			paths.map(async (path) => {
				const read = await execute("read_file", { path });
				expect(read.text).toContain(source);
			}),
		);
		const listing = await execute("list_directory", { path: "adapters/pi" });
		expect(listing.text.split("\n")).toEqual(["auth-store.ts", "auth.ts"]);
		const directory = await execute("list_directory", { path: "src" });
		expect(directory.text).toBe("auth/");
		const search = await execute("search", { query: "PUBLIC_SOURCE" });
		for (const path of paths) {
			expect(search.text).toContain(`${join(cwd, path)}:1: ${source}`);
		}
		await execute("edit_file", {
			path: paths[0],
			snapshot: token(source),
			oldText: "PUBLIC_SOURCE",
			newText: "UPDATED_SOURCE",
		});
		expect(await readFile(join(cwd, paths[0]), "utf8")).toContain(
			"UPDATED_SOURCE",
		);
	});

	it("protects the actual D3R private store before consulting editor buffers", async () => {
		const directory = join(cwd, ".agents", "d3r", "private");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, "credentials.json");
		await writeFile(path, "PRIVATE_STORE_CANARY", { mode: 0o600 });
		const readTextFile = vi.fn(async () => "PRIVATE_STORE_CANARY");
		const ctx = {
			...context,
			client: { requestPermission: vi.fn(), readTextFile },
		};
		await expect(execute("read_file", { path }, ctx)).rejects.toThrow(
			/Sensitive path/,
		);
		expect(readTextFile).not.toHaveBeenCalled();
		const [search, listing] = await Promise.all([
			execute("search", { query: "PRIVATE_STORE_CANARY" }),
			execute("list_directory", { path: ".agents/d3r" }),
		]);
		expect(search.text).toBe("");
		expect(listing.text).not.toContain("private");
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
				await expect(
					execute("search", { path, query: "private" }),
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
		expect(result.locations).toEqual([{ path, line: 1 }]);
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
		const search = await execute(
			"search",
			{ query: "disk" },
			{ ...context, client },
		);
		expect(search.text).toBe(`${join(cwd, "notes.txt")}:1: disk`);
		expect(search.locations).toBeUndefined();
		expect(client.readTextFile).not.toHaveBeenCalled();
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
		).resolves.toMatchObject({
			isError: true,
			text: "Command cancelled before execution; no process was started.",
		});
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

	it("discovers disk matches without editor reads or follow locations, then deliberately reads an unsaved buffer", async () => {
		const path = join(cwd, "notes.txt");
		const other = join(cwd, "other.txt");
		await Promise.all([
			writeFile(path, "heading\nneedle on disk"),
			writeFile(other, "needle elsewhere"),
		]);
		const buffer = "heading\nunsaved buffer only";
		const readTextFile = vi.fn(async () => buffer);
		const ctx = {
			...context,
			client: { requestPermission: vi.fn(), readTextFile },
		};
		const search = await execute("search", { query: "needle" }, ctx);
		expect(search.text.split("\n").toSorted()).toEqual(
			[`${path}:2: needle on disk`, `${other}:1: needle elsewhere`].toSorted(),
		);
		expect(search.content).toEqual([{ type: "text", text: search.text }]);
		expect(search.locations).toBeUndefined();
		const bufferSearch = await execute(
			"search",
			{ path, query: "unsaved" },
			ctx,
		);
		expect(bufferSearch.text).toBe("");
		expect(bufferSearch.locations).toBeUndefined();
		expect(readTextFile).not.toHaveBeenCalled();

		const read = await execute("read_file", { path, startLine: 2 }, ctx);
		expect(readTextFile).toHaveBeenCalledWith(path, ctx.signal);
		expect(read.text).toBe(
			`Snapshot: ${token(buffer)}\n2: unsaved buffer only`,
		);
		expect(read.locations).toEqual([{ path, line: 2 }]);
		expect(await readFile(path, "utf8")).toBe("heading\nneedle on disk");
	});

	it.each([
		{ caseSensitive: false, maxResults: 1, lines: [1], truncated: true },
		{ caseSensitive: false, maxResults: 3, lines: [1, 2, 3], truncated: false },
		{ caseSensitive: true, maxResults: 3, lines: [1, 3], truncated: false },
	])(
		"bounds literal matches and reports truncation: %j",
		async ({ caseSensitive, maxResults, lines, truncated }) => {
			const path = join(cwd, "notes.txt");
			const text = [
				"needle.*",
				"NEEDLE.*",
				"needle.*",
				"needle but not a literal match",
			];
			await writeFile(path, text.join("\n"));
			const result = await execute("search", {
				path,
				query: "needle.*",
				caseSensitive,
				maxResults,
			});
			expect(
				result.text.split("\n").filter((line) => !line.startsWith("[")),
			).toEqual(lines.map((line) => `${path}:${line}: ${text[line - 1]}`));
			expect(result.text.includes("[Search truncated]")).toBe(truncated);
			expect(result.locations).toBeUndefined();
		},
	);

	it("bounds search output while retaining a navigable match and truncation notice", async () => {
		const path = join(cwd, "long.txt");
		await writeFile(path, `needle ${"x".repeat(100_000)}`);
		const result = await execute("search", { query: "needle" });
		expect(result.text.startsWith(`${path}:1: needle `)).toBe(true);
		expect(Buffer.byteLength(result.text)).toBeLessThan(66_000);
		expect(result.text).toContain("[Output truncated]");
		expect(result.locations).toBeUndefined();
	});

	it("reports aggregate scan truncation even without matches", async () => {
		await Promise.all(
			Array.from({ length: 9 }, (_, index) =>
				writeFile(
					join(cwd, `part-${index}.txt`),
					Buffer.alloc(1024 * 1024, "x"),
				),
			),
		);
		const result = await execute("search", { query: "absent" });
		expect(result.text.trim()).toBe("[Search truncated]");
		expect(result.locations).toBeUndefined();
	});

	it("lists and searches the vault but excludes private stores and links", async () => {
		await mkdir(join(cwd, ".agents", "vault"), { recursive: true });
		await mkdir(join(cwd, ".git"));
		await mkdir(join(cwd, ".agents", "private"));
		await mkdir(join(cwd, "node_modules"));
		await writeFile(join(cwd, ".agents", "vault", "note.md"), "needle\nNEEDLE");
		await Promise.all(
			[
				join(cwd, ".git", "config"),
				join(cwd, ".env"),
				join(cwd, ".agents", "private", "note.md"),
				join(cwd, "node_modules", "generated.js"),
				join(base, "outside.txt"),
			].map((path) => writeFile(path, "needle excluded")),
		);
		await symlink(join(base, "outside.txt"), join(cwd, "link.txt"), "file");
		await symlink(
			base,
			join(cwd, "linked-directory"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const listed = await execute("list_directory", {});
		expect(listed.text).not.toMatch(/\.env|\.git|link/);
		const result = await execute("search", { query: "needle" });
		const path = join(cwd, ".agents", "vault", "note.md");
		expect(result.text.split("\n")).toEqual([
			`${path}:1: needle`,
			`${path}:2: NEEDLE`,
		]);
		expect(result.locations).toBeUndefined();
	});

	it("rejects binary and oversized reads and skips unsafe search candidates", async () => {
		await writeFile(join(cwd, "binary"), Buffer.from("x\0"));
		await writeFile(join(cwd, "invalid-utf8"), Buffer.from([120, 255]));
		await writeFile(join(cwd, "large"), Buffer.alloc(1024 * 1024 + 1, "x"));
		await writeFile(join(cwd, "valid.txt"), "safe\nx");
		await expect(execute("read_file", { path: "binary" })).rejects.toThrow(
			/Binary/,
		);
		await expect(execute("read_file", { path: "large" })).rejects.toThrow(
			/exceeds/,
		);
		const result = await execute("search", { query: "x" });
		expect(result.text).toBe(`${join(cwd, "valid.txt")}:2: x`);
		expect(result.locations).toBeUndefined();
	});

	it.each([undefined, ".", "../project"])(
		"normalizes command cwd %s against the canonical factory before approval",
		async (requestedCwd) => {
			const project = join(await realpath(base), "real", "project");
			const link = join(base, "link");
			await mkdir(project, { recursive: true });
			await symlink(
				project,
				link,
				process.platform === "win32" ? "junction" : "dir",
			);
			const tool = createWorkspaceTools({ cwd: await realpath(link) }).find(
				({ name }) => name === "run_command",
			)!;
			const input = Object.freeze({
				command: process.execPath,
				args: ["-e", "process.stdout.write(process.cwd())", "two words"],
				...(requestedCwd === undefined ? {} : { cwd: requestedCwd }),
			});
			const parsed = tool.schema.parse(input);
			expect(parsed).toEqual({ ...input, cwd: project, timeoutMs: 30_000 });
			expect(tool.schema.parse(parsed)).toEqual(parsed);
			expect(input.cwd).toBe(requestedCwd);
			if (requestedCwd === "../project") {
				expect(parsed.cwd).not.toBe(join(link, requestedCwd));
			}
			const runCommand = vi.fn(async () => ({ output: "ran", exitCode: 0 }));
			await tool.execute(parsed, {
				...context,
				cwd: link,
				roots: [project],
				client: { requestPermission: vi.fn(), runCommand },
			});
			expect(runCommand).toHaveBeenCalledWith(
				{ command: parsed.command, args: input.args, cwd: parsed.cwd },
				expect.any(AbortSignal),
			);
			const result = await tool.execute(parsed, {
				...context,
				cwd: link,
				roots: [project],
			});
			expect(result.text).toContain(project);
		},
	);

	it("preserves absolute command cwd, argv and timeout while normalizing idempotently", () => {
		const tool = tools.find(({ name }) => name === "run_command")!;
		const input = Object.freeze({
			command: "tool.cmd",
			args: ["two words", "literal"],
			cwd,
			timeoutMs: 1234,
		});
		expect(tool.schema.parse(input)).toEqual(input);
		expect(tool.schema.parse(tool.schema.parse(input))).toEqual(input);
	});

	it("reports cwd preflight failures without executing and permits a corrected retry", async () => {
		const notDirectory = join(cwd, "not-a-directory");
		await writeFile(notDirectory, "fixture");
		const runCommand = vi.fn(async () => ({ output: "ready", exitCode: 0 }));
		const ctx = {
			...context,
			client: { requestPermission: vi.fn(), runCommand },
		};
		const results = await Promise.all(
			[base, join(cwd, "missing"), notDirectory].map((path) =>
				execute(
					"run_command",
					{ command: "npx", args: ["difit", "--help"], cwd: path },
					ctx,
				),
			),
		);
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(result.text).toContain("Command was not started");
			expect(result.text).toContain("Omit cwd");
			expect(result.text).toContain("correct it and retry");
			expect(result.text).not.toContain("effects may have occurred");
		}
		expect(runCommand).not.toHaveBeenCalled();
		const corrected = await execute(
			"run_command",
			{ command: "npx", args: ["difit", "--help"] },
			ctx,
		);
		expect(corrected.isError).toBe(false);
		expect(runCommand).toHaveBeenCalledExactlyOnceWith(
			{ command: "npx", args: ["difit", "--help"], cwd },
			expect.any(AbortSignal),
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
