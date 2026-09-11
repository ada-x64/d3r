/* oxlint-disable init-declarations, no-magic-numbers -- Real filesystem fixtures are initialized per test; numeric bounds are test data. */
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RuntimeToolContext,
	type RuntimeToolResult,
} from "@d3r/core/runtime";
import { vaultFind } from "@d3r/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { compileTools } from "../../adapters/pi/embedded-tools.ts";
import { createVaultTools } from "./vault-tools.ts";
import { withDiskLock } from "./runtime-tools.ts";

/** Independent digest oracle, not the implementation's snapshot helper. */
const token = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** Parse the model-visible contract, not private helper state. */
const data = (result: RuntimeToolResult) => JSON.parse(result.text);

/** Executing this expression would create a temp-FS marker; assertions stay outside tool/parser callbacks. */
const javascriptDocument = (marker: string): string =>
	`---js\n(require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'), { kind: 'hijacked', created: '2099-01-01', injected: true })\n---\nBody\r\n  untouched\r\n\r\n`;

/** Seam tests complement the native composition/ACP journeys owned by the caller. */
// oxlint-disable-next-line max-statements -- Each registration protects a distinct filesystem or model-input boundary.
describe("native vault tools", () => {
	let base: string;
	let cwd: string;
	let vaultRoot: string;
	let context: RuntimeToolContext;
	let tools: ReturnType<typeof createVaultTools>;
	const execute = (name: string, args: unknown, ctx = context) =>
		tools.find((tool) => tool.name === name)!.execute(args, ctx);
	beforeEach(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), "d3r-vault-tools-")));
		cwd = join(base, "workspace");
		vaultRoot = join(cwd, ".agents", "vault");
		await mkdir(vaultRoot, { recursive: true });
		context = {
			toolCallId: "vault-call",
			cwd,
			roots: [cwd],
			signal: new AbortController().signal,
		};
		tools = createVaultTools({ vaultRoot });
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(base, { recursive: true, force: true });
	});

	it("exposes exactly eight inert tools without per-operation approval or initialization", async () => {
		expect(new Set(tools.map(({ name }) => name))).toEqual(
			new Set([
				"vault_read",
				"vault_ls",
				"vault_find",
				"vault_write",
				"vault_edit",
				"vault_mv",
				"vault_rm",
				"vault_lint",
			]),
		);
		// Native vault operations rely on workspace/vault trust, not per-call grants.
		expect(new Set(tools.map(({ permission }) => permission))).toEqual(
			new Set(["none"]),
		);
		const write = tools.find(({ name }) => name === "vault_write")!;
		expect(
			write.schema.parse({
				mode: "raw",
				path: "new/child.txt",
				contents: "not executed by schema parsing",
			}),
		).toMatchObject({ path: "new/child.txt" });
		expect(await readdir(vaultRoot)).toEqual([]);
		const absent = join(base, "absent");
		expect(createVaultTools({ vaultRoot: absent })).toHaveLength(8);
		expect(existsSync(absent)).toBe(false);
		for (const tool of tools) {
			expect(tool.schema.safeParse({ vaultRoot: cwd }).success).toBe(false);
		}
	});

	it("compiles vault_write to an object-root provider schema without weakening raw/doc validation", async () => {
		const compiled = compileTools(tools).find(
			({ tool }) => tool.name === "vault_write",
		)!;
		expect(compiled.parameters).toMatchObject({
			type: "object",
			properties: {
				mode: { type: "string", enum: expect.arrayContaining(["raw", "doc"]) },
				path: { type: "string" },
				contents: { type: "string" },
				kind: { type: "string" },
				frontmatter: { type: "object" },
				body: { type: "string" },
				snapshot: { type: "string" },
			},
			required: expect.arrayContaining(["mode", "path"]),
			additionalProperties: false,
		});
		expect(compiled.parameters).not.toHaveProperty("anyOf");
		expect(compiled.parameters).not.toHaveProperty("oneOf");
		const valid = [
			{ mode: "raw", path: "raw.txt", contents: "raw" },
			{
				mode: "doc",
				path: "doc.md",
				kind: "task",
				body: "body",
				frontmatter: { created: "2026-05-05" },
			},
		];
		for (const args of valid) {
			expect(compiled.tool.schema.parse(args)).toEqual(args);
			expect(
				compiled.tool.schema.parse(compiled.tool.schema.parse(args)),
			).toEqual(args);
		}
		const invalid = [
			{ path: "bad.txt", contents: "missing mode" },
			{ mode: "raw", contents: "missing path" },
			{ mode: "raw", path: "bad.txt" },
			{ mode: "doc", path: "bad.md", body: "missing kind" },
			{ mode: "doc", path: "bad.md", kind: "task" },
			{ ...valid[0], body: "wrong arm" },
			{ ...valid[0], kind: "wrong arm" },
			{ ...valid[0], frontmatter: {} },
			{ ...valid[1], contents: "wrong arm" },
			{ ...valid[1], vaultRoot: base },
		];
		for (const args of invalid) {
			expect(compiled.tool.schema.safeParse(args).success).toBe(false);
		}
		const outcomes = await Promise.allSettled(
			invalid.map((args) => execute("vault_write", args)),
		);
		expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(
			true,
		);
		expect(await readdir(vaultRoot)).toEqual([]);
	});

	it("never evaluates ---js frontmatter in permission-free find or either lint path", async () => {
		const marker = join(base, "executed-marker");
		await writeFile(
			join(vaultRoot, "untrusted.md"),
			javascriptDocument(marker),
		);
		const calls = [
			execute("vault_find", { query: "Body" }),
			execute("vault_lint", {}),
			execute("vault_lint", { paths: ["untrusted.md"] }),
		];
		const outcomes = await Promise.allSettled(calls);
		expect(existsSync(marker)).toBe(false);
		expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
			true,
		);
		const [find, lintScan, lintExplicit] = outcomes.map((outcome) => {
			if (outcome.status !== "fulfilled") {
				throw outcome.reason;
			}
			return data(outcome.value);
		});
		expect(find).toMatchObject({ matches: [], skipped: 1, truncated: false });
		for (const lint of [lintScan, lintExplicit]) {
			expect(lint).toMatchObject({
				findings: [{ path: "untrusted.md", ok: false, reason: "schema-fail" }],
				summary: { total: 1, ok: 0, failed: 1 },
			});
			expect(lint.findings[0].errors[0].message).toContain(
				"only YAML is allowed",
			);
		}
	});

	it("serializes malicious model doc bodies as inert verbatim text with only the supplied metadata", async () => {
		const marker = join(base, "body-executed-marker");
		const body = javascriptDocument(marker);
		const frontmatter = {
			created: "2026-05-05",
			status: "draft",
			details: { enabled: true, tags: ["one", "two"] },
		};
		const [outcome] = await Promise.allSettled([
			execute("vault_write", {
				mode: "doc",
				path: "new/doc.md",
				kind: "task",
				frontmatter,
				body,
			}),
		]);
		expect(existsSync(marker)).toBe(false);
		expect(outcome.status).toBe("fulfilled");
		const saved = await readFile(join(vaultRoot, "new", "doc.md"), "utf8");
		const closing = saved.indexOf("\n---\n", 4);
		expect(closing).toBeGreaterThan(4);
		expect(parseYaml(saved.slice(4, closing))).toEqual({
			...frontmatter,
			kind: "task",
		});
		expect(saved.slice(closing + 5)).toBe(body);
		const found = data(
			await execute("vault_find", { query: body, kind: "task" }),
		);
		const lint = data(await execute("vault_lint", { paths: ["new/doc.md"] }));
		expect(existsSync(marker)).toBe(false);
		expect(found.matches).toEqual([
			{ path: "new/doc.md", kind: "task", matchedQuery: true },
		]);
		expect(lint.summary).toEqual({ total: 1, ok: 1, failed: 0 });
	});

	it("rejects invalid YAML metadata and bounded alias failures while accepting ordinary YAML aliases", async () => {
		const invalid = [
			{ name: "language.md", text: "---toml\nkind = 'task'\n---\nBody" },
			{
				name: "tag.md",
				text: "---\nvalue: !!js/function 'function () {}'\n---\nBody",
			},
			{ name: "duplicate.md", text: "---\nkind: task\nkind: note\n---\nBody" },
			{ name: "sequence.md", text: "---\n[task, note]\n---\nBody" },
			{ name: "mapping-key.md", text: "---\n? [a, b]\n: value\n---\nBody" },
			{ name: "nonfinite.md", text: "---\nvalue: .inf\n---\nBody" },
			{
				name: "reserved.md",
				text: "---\n__proto__: {injected: true}\n---\nBody",
			},
			{
				name: "aliases.md",
				text: `---\na: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [${Array.from({ length: 10 }, () => "*a").join(", ")}]\nc: [${Array.from({ length: 10 }, () => "*b").join(", ")}]\n---\nBody`,
			},
			{ name: "cycle.md", text: "---\nloop: &loop [*loop]\n---\nBody" },
		];
		await Promise.all(
			invalid.map(({ name, text }) => writeFile(join(vaultRoot, name), text)),
		);
		const results = await Promise.all(
			invalid.map(async ({ name }) => ({
				name,
				find: data(await execute("vault_find", { glob: name, query: "Body" })),
				lint: data(await execute("vault_lint", { paths: [name] })),
			})),
		);
		for (const result of results) {
			expect(result.find).toMatchObject({
				matches: [],
				skipped: 1,
				truncated: false,
			});
			expect(result.lint.findings).toMatchObject([
				{ path: result.name, ok: false, reason: "schema-fail" },
			]);
		}
		await writeFile(
			join(vaultRoot, "good.md"),
			"\uFEFF---yaml\r\nkind: task\r\ncreated: 2026-05-05\r\ntags: &tags [one, two]\r\ncopy: *tags\r\n---\r\nBody\r\n",
		);
		expect(
			data(await execute("vault_lint", { paths: ["good.md"] })).summary,
		).toEqual({ total: 1, ok: 1, failed: 0 });
		expect(
			data(
				await execute("vault_find", {
					glob: "good.md",
					query: "Body\r\n",
					kind: "task",
				}),
			).matches,
		).toEqual([
			{ path: "good.md", kind: "task", matchedGlob: true, matchedQuery: true },
		]);
	});

	it("rejects non-data model metadata without invoking serialization hooks or creating parents", async () => {
		const hook = vi.fn(() => "must not run");
		const cyclic: Record<string, unknown> = {};
		cyclic.loop = cyclic;
		const metadata = [
			{ value: Number.NaN },
			{ value: () => "function" },
			{ value: { toJSON: hook } },
			JSON.parse('{"__proto__":{"injected":true}}'),
			{ nested: { constructor: "reserved" } },
			cyclic,
		];
		const outcomes = await Promise.allSettled(
			metadata.map((frontmatter) =>
				execute("vault_write", {
					mode: "doc",
					path: "missing/doc.md",
					kind: "task",
					frontmatter,
					body: "body",
				}),
			),
		);
		expect(hook).not.toHaveBeenCalled();
		expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(
			true,
		);
		expect(await readdir(vaultRoot)).toEqual([]);
	});

	it.each(["inside workspace", "outside workspace"])(
		"pins all IO to the saved vault, bypassing ACP editor fs when %s",
		async (placement) => {
			if (placement === "outside workspace") {
				vaultRoot = join(base, "separate-vault");
				await mkdir(vaultRoot);
				tools = createVaultTools({ vaultRoot });
			}
			const editorRead = vi.fn(async () => "UNSAVED editor body");
			const editorWrite = vi.fn(async () => undefined);
			const requestPermission = vi.fn(async () => true);
			const ctx: RuntimeToolContext = {
				...context,
				cwd: base,
				roots: [base],
				client: {
					requestPermission,
					readTextFile: editorRead,
					writeTextFile: editorWrite,
				},
			};
			await writeFile(join(base, "note.md"), "decoy");
			await writeFile(
				join(vaultRoot, "note.md"),
				"---\nkind: task\ncreated: 2026-05-05\n---\nsaved body\n",
			);
			const read = data(await execute("vault_read", { path: "note.md" }, ctx));
			expect(read.path).toBe("note.md");
			expect(read.text).toContain("saved body");
			expect(
				data(
					await execute(
						"vault_find",
						{ query: "saved body", kind: "task" },
						ctx,
					),
				).matches,
			).toEqual([{ path: "note.md", kind: "task", matchedQuery: true }]);
			expect(data(await execute("vault_ls", {}, ctx)).entries).toEqual([
				{ name: "note.md", path: "note.md", kind: "file" },
			]);
			expect(data(await execute("vault_lint", {}, ctx)).summary).toEqual({
				total: 1,
				ok: 1,
				failed: 0,
			});
			await execute(
				"vault_edit",
				{
					path: "note.md",
					snapshot: read.snapshot,
					find: "saved body",
					replace: "changed body",
				},
				ctx,
			);
			const updated = data(
				await execute("vault_read", { path: "note.md" }, ctx),
			);
			await execute(
				"vault_mv",
				{
					from: "note.md",
					to: ".misc/archive/note.md",
					snapshot: updated.snapshot,
				},
				ctx,
			);
			await execute(
				"vault_rm",
				{ path: ".misc/archive/note.md", snapshot: updated.snapshot },
				ctx,
			);
			await execute(
				"vault_write",
				{ mode: "raw", path: "new/child.txt", contents: "disk artifact" },
				ctx,
			);
			expect(await readFile(join(vaultRoot, "new", "child.txt"), "utf8")).toBe(
				"disk artifact",
			);
			expect(await readFile(join(base, "note.md"), "utf8")).toBe("decoy");
			expect(existsSync(join(vaultRoot, "note.md"))).toBe(false);
			expect(existsSync(join(vaultRoot, ".misc", "archive", "note.md"))).toBe(
				false,
			);
			expect(editorRead).not.toHaveBeenCalled();
			expect(editorWrite).not.toHaveBeenCalled();
			// This checks direct IO; assembled journeys cover workspace/vault trust.
			expect(requestPermission).not.toHaveBeenCalled();
		},
	);

	it("assembles doc mode and preserves raw preimages, BOMs, snapshots and literal edit diffs", async () => {
		const created = await execute("vault_write", {
			mode: "doc",
			path: ".misc/templates/task.md",
			kind: "task",
			frontmatter: { kind: "ignored", created: "2026-05-05" },
			body: "Task body\n",
		});
		const doc = await readFile(
			join(vaultRoot, ".misc/templates/task.md"),
			"utf8",
		);
		expect(doc).toContain("kind: task");
		expect(doc).not.toContain("ignored");
		expect(created.content).toEqual([
			{
				type: "diff",
				path: join(vaultRoot, ".misc/templates/task.md"),
				oldText: null,
				newText: doc,
			},
		]);
		const raw = "\uFEFFone one\n";
		const written = await execute("vault_write", {
			mode: "raw",
			path: "raw.txt",
			contents: raw,
		});
		expect(written.text).toContain(`Updated raw.txt\nSnapshot: ${token(raw)}`);
		const read = data(await execute("vault_read", { path: "raw.txt" }));
		expect(read).toMatchObject({
			path: "raw.txt",
			text: raw,
			snapshot: token(raw),
			truncated: false,
		});
		await expect(
			execute("vault_edit", {
				path: "raw.txt",
				snapshot: read.snapshot,
				find: "one",
				replace: "$&",
			}),
		).rejects.toThrow("Expected 1 exact matches; found 2");
		const edited = await execute("vault_edit", {
			path: "raw.txt",
			snapshot: read.snapshot,
			find: "one",
			replace: "$&",
			count: 2,
		});
		const replacement = "\uFEFF$& $&\n";
		expect(edited.content).toEqual([
			{
				type: "diff",
				path: join(vaultRoot, "raw.txt"),
				oldText: raw,
				newText: replacement,
			},
		]);
		expect(await readFile(join(vaultRoot, "raw.txt"), "utf8")).toBe(
			replacement,
		);
		await execute("vault_write", {
			mode: "raw",
			path: "raw.txt",
			contents: "x",
			snapshot: token(replacement),
		});
		expect(await readFile(join(vaultRoot, "raw.txt"), "utf8")).toBe("x");
	});

	it("rejects missing/stale snapshots before any lock, mkdir, or file effect", async () => {
		await writeFile(join(vaultRoot, "note.txt"), "first");
		const read = data(await execute("vault_read", { path: "note.txt" }));
		await expect(
			execute("vault_write", {
				mode: "raw",
				path: "note.txt",
				contents: "no token",
			}),
		).rejects.toThrow(/snapshot/);
		await writeFile(join(vaultRoot, "note.txt"), "newer");
		await Promise.all([
			expect(
				execute("vault_edit", {
					path: "note.txt",
					snapshot: read.snapshot,
					find: "newer",
					replace: "lost",
				}),
			).rejects.toThrow(/snapshot/),
			expect(
				execute("vault_mv", {
					from: "note.txt",
					to: "new/target.txt",
					snapshot: read.snapshot,
				}),
			).rejects.toThrow(/snapshot/),
			expect(
				execute("vault_rm", { path: "note.txt", snapshot: read.snapshot }),
			).rejects.toThrow(/snapshot/),
			expect(
				execute("vault_write", {
					mode: "raw",
					path: "missing/target.txt",
					contents: "lost",
					snapshot: read.snapshot,
				}),
			).rejects.toThrow(/snapshot/),
		]);
		expect(await readdir(vaultRoot)).toEqual(["note.txt"]);
		expect(await readFile(join(vaultRoot, "note.txt"), "utf8")).toBe("newer");
	});

	it.each([
		"/outside.txt",
		"C:/outside.txt",
		"C:outside.txt",
		String.raw`\\server\share`,
		String.raw`\rooted`,
		"../outside.txt",
		"x/../../outside.txt",
		"x/../note.txt",
		".git/config",
		".env",
		".ssh/id_rsa",
		".agents/sessions/log",
		".agents/d3r/private/credentials.json",
		".d3r-write-test.tmp",
		"note.txt:stream",
		"folder./note",
		"NUL",
		"bad\0path",
	])(
		"denies unsafe explicit paths in every path-bearing tool: %s",
		async (path) => {
			await Promise.all([
				expect(execute("vault_read", { path })).rejects.toThrow(),
				expect(execute("vault_ls", { path })).rejects.toThrow(),
				expect(
					execute("vault_write", { mode: "raw", path, contents: "unsafe" }),
				).rejects.toThrow(),
				expect(
					execute("vault_edit", {
						path,
						snapshot: token(""),
						find: "x",
						replace: "y",
					}),
				).rejects.toThrow(),
				expect(
					execute("vault_mv", {
						from: path,
						to: "safe.txt",
						snapshot: token(""),
					}),
				).rejects.toThrow(),
				expect(
					execute("vault_rm", { path, snapshot: token("") }),
				).rejects.toThrow(),
				expect(execute("vault_lint", { paths: [path] })).rejects.toThrow(),
			]);
			expect(await readdir(vaultRoot)).toEqual([]);
		},
	);

	it("allows security documentation names in vault reads, listings, searches, and writes", async () => {
		const path = "notes/auth/secrets.md";
		const contents =
			"Public documentation about credential handling, not stored credential values.";
		await execute("vault_write", { mode: "raw", path, contents });
		expect(data(await execute("vault_read", { path })).text).toBe(contents);
		expect(data(await execute("vault_ls", { path: "notes" })).entries).toEqual([
			{ name: "auth", path: "notes/auth", kind: "dir" },
		]);
		expect(
			data(
				await execute("vault_find", {
					glob: "notes/auth/**",
					query: "credential handling",
				}),
			).matches,
		).toEqual([{ path, matchedGlob: true, matchedQuery: true }]);
	});

	it("refuses unsafe move destinations and glob/root overrides", async () => {
		await writeFile(join(vaultRoot, "note.txt"), "original");
		await expect(
			execute("vault_mv", {
				from: "note.txt",
				to: "../escape.txt",
				snapshot: token("original"),
			}),
		).rejects.toThrow();
		await expect(execute("vault_find", { glob: "../**" })).rejects.toThrow();
		await expect(execute("vault_find", { glob: ".git/**" })).rejects.toThrow();
		await expect(
			execute("vault_read", { path: "note.txt", vaultRoot: base }),
		).rejects.toThrow();
		await expect(
			execute("vault_write", {
				mode: "raw",
				path: "new.txt",
				contents: "bad",
				root: base,
			}),
		).rejects.toThrow();
		expect(await readdir(vaultRoot)).toEqual(["note.txt"]);
	});

	it("never follows symlinks or hardlinks, including allowed-looking in-vault aliases", async () => {
		const outside = join(base, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "doc.md"), "outside marker");
		await writeFile(join(vaultRoot, "safe.md"), "saved marker");
		await symlink(outside, join(vaultRoot, "escape"), "dir");
		await symlink(
			join(vaultRoot, "safe.md"),
			join(vaultRoot, "alias.md"),
			"file",
		);
		await link(join(outside, "doc.md"), join(vaultRoot, "hard.md"));
		await Promise.all([
			expect(execute("vault_read", { path: "escape/doc.md" })).rejects.toThrow(
				/Symlink/,
			),
			expect(execute("vault_read", { path: "alias.md" })).rejects.toThrow(
				/Symlink/,
			),
			expect(execute("vault_read", { path: "hard.md" })).rejects.toThrow(
				/Hard-linked/,
			),
			expect(
				execute("vault_write", {
					mode: "raw",
					path: "escape/new/sub.md",
					contents: "bad",
				}),
			).rejects.toThrow(/Symlink/),
			expect(
				execute("vault_lint", { paths: ["escape/doc.md"] }),
			).rejects.toThrow(/Symlink/),
		]);
		const found = data(await execute("vault_find", { query: "marker" }));
		expect(found.matches).toEqual([{ path: "safe.md", matchedQuery: true }]);
		expect(found.skipped).toBe(3);
		expect(
			data(await execute("vault_ls", {})).entries.map(
				(entry: { path: string }) => entry.path,
			),
		).toEqual(["safe.md"]);
		expect(await readdir(outside)).toEqual(["doc.md"]);
	});

	it("does not recreate a missing vault or bless a root replaced by a symlink", async () => {
		await writeFile(join(vaultRoot, "note.txt"), "before");
		await rename(vaultRoot, join(base, "moved-vault"));
		await expect(
			execute("vault_write", {
				mode: "raw",
				path: "child/new.txt",
				contents: "bad",
			}),
		).rejects.toThrow();
		expect(existsSync(vaultRoot)).toBe(false);
		const outside = join(base, "outside");
		await mkdir(outside);
		await symlink(outside, vaultRoot, "dir");
		await expect(execute("vault_ls", {})).rejects.toThrow(/canonical/);
		await expect(
			execute("vault_write", { mode: "raw", path: "new.txt", contents: "bad" }),
		).rejects.toThrow(/canonical/);
		expect(await readdir(outside)).toEqual([]);
	});

	it("includes .misc without touching private or link descendants and keeps scan results navigable but not followable", async () => {
		await mkdir(join(vaultRoot, ".misc", "archive"), { recursive: true });
		await mkdir(join(vaultRoot, ".git"));
		await writeFile(
			join(vaultRoot, ".misc", "archive", "old.md"),
			"---\nkind: task\ncreated: 2026-05-05\n---\nNeedle\n",
		);
		await writeFile(join(vaultRoot, ".git", "config"), "Needle");
		await writeFile(join(vaultRoot, ".env"), "Needle");
		const find = await execute("vault_find", {
			glob: "**/*.md",
			query: "Needle",
			kind: "task",
		});
		expect(data(find).matches).toEqual([
			{
				path: ".misc/archive/old.md",
				matchedGlob: true,
				matchedQuery: true,
				kind: "task",
			},
		]);
		expect(find.locations).toBeUndefined();
		expect(find.content?.every((content) => content.type === "text")).toBe(
			true,
		);
		const lint = await execute("vault_lint", {});
		expect(data(lint).summary).toEqual({ total: 1, ok: 1, failed: 0 });
		expect(data(lint).skipped).toBe(2);
		expect(lint.locations).toBeUndefined();
		expect(
			data(await execute("vault_read", { path: ".misc/archive" })).entries[0]
				.path,
		).toBe(".misc/archive/old.md");
	});

	it("keeps existing glob/query/kind behavior on safe documents and handles hostile glob complexity without backtracking", async () => {
		await mkdir(join(vaultRoot, "nested"));
		await writeFile(
			join(vaultRoot, "root.md"),
			"---\nkind: task\ntitle: header-only\n---\nBody\n",
		);
		await writeFile(
			join(vaultRoot, "nested", "child.md"),
			"---\nkind: issue\n---\nOther Body\n",
		);
		await writeFile(join(vaultRoot, "plain.txt"), "Body\n");
		const filters = [
			{},
			{ glob: "*.md" },
			{ glob: "**/*.md" },
			{ glob: "nested/?????.md" },
			{ query: "Body" },
			{ query: "body" },
			{ query: "header-only" },
			{ kind: "task", query: "Body" },
		];
		await Promise.all(
			filters.map(async (filter) => {
				const legacy = await vaultFind(filter, { vaultRoot });
				if (!legacy.ok) {
					throw new Error("Safe fixture unexpectedly rejected by legacy find");
				}
				const native = data(await execute("vault_find", filter));
				expect(
					native.matches.toSorted((a: { path: string }, b: { path: string }) =>
						a.path.localeCompare(b.path),
					),
				).toEqual(
					legacy.value.matches.toSorted((a, b) => a.path.localeCompare(b.path)),
				);
			}),
		);
		await writeFile(join(vaultRoot, `${"a".repeat(200)}.md`), "body");
		expect(
			data(await execute("vault_find", { glob: `${"*a".repeat(100)}z` }))
				.matches,
		).toEqual([]);
	});

	it("reports malformed/invalid frontmatter, and fails explicit binary/oversized reads and lint paths", async () => {
		await writeFile(join(vaultRoot, "bad.md"), "---\nkind: [broken\n---\ntext");
		await writeFile(
			join(vaultRoot, "unknown.md"),
			"---\nkind: unknown\n---\ntext",
		);
		await writeFile(join(vaultRoot, "none.md"), "plain markdown");
		await writeFile(join(vaultRoot, "binary.md"), Buffer.from([0, 1]));
		await writeFile(join(vaultRoot, "large.md"), "x".repeat(1_048_577));
		const lint = data(await execute("vault_lint", {}));
		expect(
			lint.findings
				.map((finding: { reason: string }) => finding.reason)
				.toSorted(),
		).toEqual(["no-kind", "schema-fail", "unknown-kind"]);
		expect(lint.skipped).toBe(2);
		await Promise.all([
			expect(execute("vault_read", { path: "binary.md" })).rejects.toThrow(
				/Binary/,
			),
			expect(execute("vault_read", { path: "large.md" })).rejects.toThrow(
				/exceeds/,
			),
			expect(
				execute("vault_read", { path: "large.md", limit: 1 }),
			).rejects.toThrow(/exceeds/),
			expect(execute("vault_lint", { paths: ["binary.md"] })).rejects.toThrow(
				/Binary/,
			),
		]);
	});

	it("reconstructs an entire large multibyte template losslessly with one full-file snapshot across pages", async () => {
		const path = ".misc/templates/large.md";
		const firstPage = `\uFEFF# Template\n${"a".repeat(8179)}\u{1F680}`;
		const template = `${firstPage}${"\u00E9\u4E2D\u{1F680}e\u0301\n".repeat(3000)}\nEND`;
		await mkdir(join(vaultRoot, ".misc", "templates"), { recursive: true });
		await writeFile(join(vaultRoot, path), template);
		const pages: string[] = [];
		let offset = 0;
		for (let index = 0; index < 4; index++) {
			// oxlint-disable-next-line no-await-in-loop -- Consume the previous page's model-visible continuation.
			const result = await execute(
				"vault_read",
				index === 0 ? { path } : { path, offset },
			);
			const page = data(result);
			expect(page).toMatchObject({
				kind: "file",
				path,
				offset,
				limit: 8192,
				snapshot: token(template),
				truncated: index < 3,
			});
			expect(Buffer.byteLength(result.text)).toBeLessThan(65_536);
			const codePoints = [...page.text].length;
			expect(codePoints).toBeGreaterThan(0);
			expect(codePoints).toBeLessThanOrEqual(8192);
			pages.push(page.text);
			if (page.truncated) {
				expect(page.nextOffset).toBe(offset + codePoints);
				expect(page.nextOffset).toBeGreaterThan(offset);
				offset = page.nextOffset;
			} else {
				expect(page.nextOffset).toBeUndefined();
			}
		}
		expect(pages[0]).toBe(firstPage);
		expect(pages.join("")).toBe(template);
	});

	it("advances one Unicode code point at a time, terminates at EOF, and exposes changes between reads", async () => {
		const path = "unicode.txt";
		const text = "\u{1F680}e\u0301\u4E2D";
		await writeFile(join(vaultRoot, path), text);
		const pages = await Promise.all(
			Array.from({ length: 5 }, async (_, offset) =>
				data(await execute("vault_read", { path, offset, limit: 1 })),
			),
		);
		expect(pages.map((page) => page.text)).toEqual([
			"\u{1F680}",
			"e",
			"\u0301",
			"\u4E2D",
			"",
		]);
		expect(pages.map((page) => page.nextOffset)).toEqual([
			1,
			2,
			3,
			undefined,
			undefined,
		]);
		expect(pages.map((page) => page.truncated)).toEqual([
			true,
			true,
			true,
			false,
			false,
		]);
		expect(
			pages.every((page) => page.snapshot === token(text) && page.limit === 1),
		).toBe(true);
		await expect(execute("vault_read", { path, offset: 5 })).rejects.toThrow(
			/offset exceeds/,
		);
		await writeFile(join(vaultRoot, path), `${text}changed`);
		const changed = data(
			await execute("vault_read", { path, offset: 1, limit: 1 }),
		);
		expect(changed.snapshot).toBe(token(`${text}changed`));
		expect(changed.snapshot).not.toBe(pages[0].snapshot);
		await writeFile(join(vaultRoot, "empty.txt"), "");
		const empty = data(await execute("vault_read", { path: "empty.txt" }));
		expect(empty).toMatchObject({
			text: "",
			offset: 0,
			limit: 8192,
			truncated: false,
			snapshot: token(""),
		});
		expect(empty.nextOffset).toBeUndefined();
	});

	it("rejects invalid pagination bounds and directory pagination rather than returning non-progress pages", async () => {
		await writeFile(join(vaultRoot, "note.txt"), "body");
		await Promise.all(
			[
				{ offset: -1 },
				{ offset: 0.5 },
				{ offset: 1_048_577 },
				{ limit: 0 },
				{ limit: -1 },
				{ limit: 1.5 },
				{ limit: 8193 },
			].map(async (bounds) => {
				await expect(
					execute("vault_read", { path: "note.txt", ...bounds }),
				).rejects.toThrow();
			}),
		);
		await expect(
			execute("vault_read", { path: ".", offset: 1 }),
		).rejects.toThrow(/only to files/);
		await expect(
			execute("vault_read", { path: ".", limit: 1 }),
		).rejects.toThrow(/only to files/);
	});

	it("bounds pages/results and aggregate reads, including failures that consumed disk bytes", async () => {
		const longText = "text\n".repeat(5000);
		await writeFile(join(vaultRoot, "long.txt"), longText);
		const read = await execute("vault_read", { path: "long.txt" });
		expect(data(read)).toMatchObject({
			snapshot: token(longText),
			offset: 0,
			limit: 8192,
			nextOffset: 8192,
			truncated: true,
		});
		expect(Buffer.byteLength(read.text)).toBeLessThan(65_536);
		await mkdir(join(vaultRoot, "rows"));
		await Promise.all(
			Array.from({ length: 205 }, (_, index) =>
				writeFile(join(vaultRoot, "rows", `${index}.txt`), "row"),
			),
		);
		const listed = data(await execute("vault_ls", { path: "rows" }));
		expect(listed.entries).toHaveLength(200);
		expect(listed.truncated).toBe(true);
		const found = data(await execute("vault_find", {}));
		expect(found.matches).toHaveLength(200);
		expect(found.truncated).toBe(true);
		await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				writeFile(
					join(vaultRoot, `binary-${index}.md`),
					Buffer.alloc(1_048_576),
				),
			),
		);
		const scan = data(
			await execute("vault_find", { glob: "binary-*.md", query: "absent" }),
		);
		expect(scan.matches).toEqual([]);
		expect(scan.truncated).toBe(true);
		expect(scan.skipped).toBe(8);
	});

	it("rejects directory/root mutations and overwriting moves without descending into private content", async () => {
		await mkdir(join(vaultRoot, "directory", ".git"), { recursive: true });
		await writeFile(join(vaultRoot, "directory", ".git", "config"), "private");
		await writeFile(join(vaultRoot, "from.txt"), "source");
		await writeFile(join(vaultRoot, "to.txt"), "destination");
		await Promise.all([
			expect(
				execute("vault_mv", {
					from: "directory",
					to: "moved",
					snapshot: token(""),
				}),
			).rejects.toThrow(/directory operations are unsupported/),
			expect(
				execute("vault_rm", { path: "directory", snapshot: token("") }),
			).rejects.toThrow(/directory operations are unsupported/),
			expect(
				execute("vault_rm", {
					path: "directory",
					recursive: true,
					snapshot: token(""),
				}),
			).rejects.toThrow(),
			expect(
				execute("vault_mv", {
					from: ".",
					to: "root-moved",
					snapshot: token(""),
				}),
			).rejects.toThrow(/directory operations are unsupported/),
			expect(
				execute("vault_rm", { path: ".", snapshot: token("") }),
			).rejects.toThrow(/directory operations are unsupported/),
			expect(
				execute("vault_mv", {
					from: "from.txt",
					to: "to.txt",
					snapshot: token("source"),
				}),
			).rejects.toThrow(/overwriting moves are unsupported/),
			expect(
				execute("vault_mv", {
					from: "from.txt",
					to: "to.txt",
					overwrite: true,
					snapshot: token("source"),
				}),
			).rejects.toThrow(),
		]);
		expect(await readFile(join(vaultRoot, "from.txt"), "utf8")).toBe("source");
		expect(await readFile(join(vaultRoot, "to.txt"), "utf8")).toBe(
			"destination",
		);
		expect(
			await readFile(join(vaultRoot, "directory", ".git", "config"), "utf8"),
		).toBe("private");
		const entries = await readdir(vaultRoot);
		expect(entries.toSorted()).toEqual(["directory", "from.txt", "to.txt"]);
	});

	it("uses shared disk locks/no-clobber across factories and cleans mutation sidecars", async () => {
		const second = createVaultTools({ vaultRoot }).find(
			({ name }) => name === "vault_write",
		)!;
		const writes = await Promise.allSettled([
			execute("vault_write", { mode: "raw", path: "new.txt", contents: "one" }),
			second.execute(
				{ mode: "raw", path: "new.txt", contents: "two" },
				context,
			),
		]);
		expect(
			writes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(["one", "two"]).toContain(
			await readFile(join(vaultRoot, "new.txt"), "utf8"),
		);
		const { snapshot } = data(await execute("vault_read", { path: "new.txt" }));
		await withDiskLock(
			join(vaultRoot, "new.txt"),
			{ cwd: vaultRoot, roots: [vaultRoot], signal: context.signal },
			async () => {
				await expect(
					execute("vault_rm", { path: "new.txt", snapshot }),
				).rejects.toThrow(/EEXIST/);
				await expect(
					execute("vault_mv", { from: "new.txt", to: "blocked.txt", snapshot }),
				).rejects.toThrow(/EEXIST/);
			},
		);
		expect(await readdir(vaultRoot)).toEqual(["new.txt"]);
	});

	it.each(["cancelled", "destination changed", "source changed"])(
		"cancels before effects and reports an incomplete move when %s after publication",
		async (fault) => {
			const controller = new AbortController();
			controller.abort();
			await expect(
				execute(
					"vault_write",
					{ mode: "raw", path: "new/child.txt", contents: "bad" },
					{ ...context, signal: controller.signal },
				),
			).rejects.toThrow();
			expect(await readdir(vaultRoot)).toEqual([]);
			await writeFile(join(vaultRoot, "source.txt"), "source text");
			const moving = new AbortController();
			let injected = false;
			// Inject a fault at the observable commit boundary, not before the contested IO.
			vi.spyOn(moving.signal, "throwIfAborted").mockImplementation(() => {
				if (!injected && existsSync(join(vaultRoot, "target.txt"))) {
					injected = true;
					if (fault === "cancelled") {
						moving.abort(new Error("cancelled after publication"));
					} else {
						writeFileSync(
							join(
								vaultRoot,
								fault === "source changed" ? "source.txt" : "target.txt",
							),
							"external writer",
						);
					}
				}
				if (moving.signal.aborted) {
					throw moving.signal.reason;
				}
			});
			const result = await execute(
				"vault_mv",
				{
					from: "source.txt",
					to: "target.txt",
					snapshot: token("source text"),
				},
				{ ...context, signal: moving.signal },
			);
			expect(result.isError).toBe(true);
			expect(result.text).toContain(
				"Move incomplete: destination target.txt was created",
			);
			expect(result.content).toEqual([
				{
					type: "diff",
					path: join(vaultRoot, "target.txt"),
					oldText: null,
					newText: "source text",
				},
			]);
			expect(injected).toBe(true);
			expect(await readFile(join(vaultRoot, "source.txt"), "utf8")).toBe(
				fault === "source changed" ? "external writer" : "source text",
			);
			expect(await readFile(join(vaultRoot, "target.txt"), "utf8")).toBe(
				fault === "destination changed" ? "external writer" : "source text",
			);
			const entries = await readdir(vaultRoot);
			expect(entries.toSorted()).toEqual(["source.txt", "target.txt"]);
			const info = await lstat(join(vaultRoot, "source.txt"));
			expect(info.nlink).toBe(1);
		},
	);
});
