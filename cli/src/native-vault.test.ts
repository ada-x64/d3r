/* oxlint-disable init-declarations, no-magic-numbers -- Real filesystem fixtures and lifecycle assertions. */
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type RuntimeSessionInput } from "@d3r/core/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentResources, resolveWorkspaceResource } from "./resources.ts";
import { parseNativeCheckpoint } from "./native-resources.ts";
import { nativeFixture, testPrompt } from "./native-test-support.ts";

/** Native composition seams exercise real tools and resource IO; the main ACP suite owns provider journeys. */
describe("native ancestor vault access", () => {
	let base: string;
	let home: string;
	let cwd: string;
	let vault: string;
	let f: ReturnType<typeof nativeFixture>;
	let deps: Awaited<ReturnType<ReturnType<typeof nativeFixture>["server"]>>;
	const open = async (input: Partial<RuntimeSessionInput> = {}) => {
		const session = await deps.createSession({
			sessionId: "vault-session",
			cwd,
			client: { requestPermission: f.requestPermission },
			...input,
		});
		f.sessions.push(session);
		return session;
	};
	const context = () => ({
		toolCallId: "vault-tool",
		cwd: home,
		roots: [home],
		signal: new AbortController().signal,
	});
	const tool = (name: string) =>
		f.turns[0].options.tools!.find((entry) => entry.name === name)!;
	const resource = (path: string) =>
		f.turns[0].options.resolveResource!(
			{
				type: "resource_link",
				uri: pathToFileURL(path).href,
				name: "document",
			},
			context(),
		);
	beforeEach(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), "d3r-native-vault-")));
		home = join(base, "home");
		cwd = join(base, "repo", "worktrees", "topic");
		vault = join(base, "repo", ".agents", "vault");
		await Promise.all([
			mkdir(home),
			mkdir(cwd, { recursive: true }),
			mkdir(vault, { recursive: true }),
		]);
		f = nativeFixture();
		deps = await f.server(
			{ home },
			{ realpath, loadAgentResources, resolveWorkspaceResource },
		);
	});
	afterEach(async () => {
		await f.close();
		await rm(base, { recursive: true, force: true });
	});

	// oxlint-disable-next-line max-statements -- One seam verifies the complete filesystem grant, not a provider or ACP journey.
	it("names the vault in trust, grants only that path after approval, and keeps its reads/search/writes disk-owned", async () => {
		const path = join(vault, "notes.md");
		const local = join(cwd, "notes.md");
		await Promise.all([
			writeFile(path, "vault disk text"),
			writeFile(local, "workspace disk text"),
		]);
		const readTextFile = vi.fn(async (file: string) => {
			if (file !== local) {
				throw new Error("Zed cannot read out-of-project files");
			}
			return "workspace unsaved text";
		});
		const writeTextFile = vi.fn(async () => {});
		const session = await open({
			client: {
				requestPermission: f.requestPermission,
				readTextFile,
				writeTextFile,
			},
		});
		const initial = parseNativeCheckpoint(session.snapshot!());
		expect(initial.resources.vaultRoot).toBe(vault);
		expect(initial.sources.additionalDirectories).toEqual([]);
		f.requestPermission.mockResolvedValueOnce(false);
		await session.prompt(testPrompt());
		expect(f.requestPermission.mock.calls[0]).toEqual([
			expect.objectContaining({
				title: expect.stringContaining(vault),
				input: expect.objectContaining({
					cwd,
					vaultRoot: vault,
					additionalDirectories: [],
				}),
			}),
			expect.any(AbortSignal),
		]);
		expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
		expect(readTextFile).not.toHaveBeenCalled();
		expect(session.snapshot!()).toEqual(initial);
		await session.prompt(testPrompt());
		expect(f.deps.createWorkspaceTools).toHaveBeenCalledWith({
			cwd,
			additionalDirectories: [vault],
		});
		expect(f.turns[0].options.systemPrompt).toContain(vault);
		const read = await tool("read_file").execute({ path }, context());
		expect(read.text).toContain("vault disk text");
		await expect(
			tool("list_directory").execute({ path: vault }, context()),
		).resolves.toMatchObject({ text: expect.stringContaining("notes.md") });
		await expect(
			tool("search").execute({ path: vault, query: "vault disk" }, context()),
		).resolves.toMatchObject({ text: expect.stringContaining(path) });
		expect(await resource(path)).toBe("vault disk text");
		expect(readTextFile).not.toHaveBeenCalled();
		expect(tool("write_file").permission).toBe("ask");
		expect(tool("edit_file").permission).toBe("ask");
		const [, snapshot] = /Snapshot: (\w+)/.exec(read.text)!;
		await tool("edit_file").execute(
			{ path, snapshot, oldText: "disk", newText: "updated" },
			context(),
		);
		expect(await readFile(path, "utf8")).toBe("vault updated text");
		await expect(
			tool("write_file").execute(
				{ path, snapshot, content: "stale overwrite" },
				context(),
			),
		).rejects.toThrow(/snapshot/i);
		await tool("write_file").execute(
			{ path: join(vault, "new.md"), content: "new vault document" },
			context(),
		);
		expect(await readFile(join(vault, "new.md"), "utf8")).toBe(
			"new vault document",
		);
		expect(writeTextFile).not.toHaveBeenCalled();
		await expect(
			tool("read_file").execute({ path: local }, context()),
		).resolves.toMatchObject({
			text: expect.stringContaining("workspace unsaved text"),
		});
		expect(await resource(local)).toBe("workspace unsaved text");
		readTextFile.mockRejectedValue(new Error("editor read failed"));
		await expect(
			tool("read_file").execute({ path: local }, context()),
		).rejects.toThrow("editor read failed");
		await expect(resource(local)).rejects.toThrow("editor read failed");
	});

	it("preserves local vault precedence, editor ownership, and the existing workspace trust surface", async () => {
		const localVault = join(cwd, ".agents", "vault");
		await mkdir(localVault, { recursive: true });
		const path = join(localVault, "note.md");
		await writeFile(path, "saved local vault text");
		const readTextFile = vi.fn(async () => "unsaved local vault text");
		const session = await open({
			client: { requestPermission: f.requestPermission, readTextFile },
		});
		const checkpoint = parseNativeCheckpoint(session.snapshot!());
		expect(checkpoint.resources.vaultRoot).toBe(localVault);
		session.restore!(checkpoint);
		expect(session.snapshot!()).toEqual(checkpoint);
		await session.prompt(testPrompt());
		expect(f.requestPermission.mock.calls[0]).toEqual([
			expect.objectContaining({
				title: `Trust workspace ${cwd} for this session`,
			}),
			expect.any(AbortSignal),
		]);
		expect(f.deps.createWorkspaceTools).toHaveBeenCalledWith({
			cwd,
			additionalDirectories: [],
		});
		await expect(
			tool("read_file").execute({ path }, context()),
		).resolves.toMatchObject({
			text: expect.stringContaining("unsaved local vault text"),
		});
		expect(await resource(path)).toBe("unsaved local vault text");
		await expect(resource(join(vault, "parent.md"))).rejects.toThrow(
			/outside allowed roots/,
		);
	});

	it("keeps sensitive stores, sibling paths, and vault symlinks outside the grant", async () => {
		await Promise.all([
			writeFile(join(vault, "visible.md"), "find me"),
			writeFile(join(vault, ".env"), "private"),
			mkdir(join(vault, ".git")),
			writeFile(join(dirname(vault), "mcp.json"), "private sibling"),
		]);
		await writeFile(join(vault, ".git", "config"), "private git data");
		await symlink(
			home,
			join(vault, "escape"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const session = await open();
		await session.prompt(testPrompt());
		const denied = [
			join(vault, ".env"),
			join(vault, ".git", "config"),
			join(dirname(vault), "mcp.json"),
			join(vault, "escape", "file.md"),
		];
		await Promise.all(
			denied.map(async (path) => {
				await expect(
					tool("read_file").execute({ path }, context()),
				).rejects.toThrow();
				await expect(
					tool("write_file").execute(
						{ path, content: "unauthorized" },
						context(),
					),
				).rejects.toThrow();
				await expect(resource(path)).rejects.toThrow();
			}),
		);
		await expect(
			tool("list_directory").execute({ path: dirname(vault) }, context()),
		).rejects.toThrow(/outside allowed roots/);
		await expect(
			tool("list_directory").execute({ path: vault }, context()),
		).resolves.toMatchObject({ text: "visible.md" });
		await expect(
			tool("search").execute({ path: vault, query: "private" }, context()),
		).resolves.toMatchObject({ text: "" });
	});

	it("keeps vault resource links disk-owned alongside explicit additional editor workspace roots", async () => {
		const repo = join(base, "repo");
		const local = join(repo, "editor.md");
		await Promise.all([
			writeFile(local, "disk text"),
			writeFile(join(vault, "disk.md"), "needle vault"),
		]);
		const readTextFile = vi.fn(async (path: string) => {
			if (path !== local) {
				throw new Error("out-of-project editor read");
			}
			return "needle editor";
		});
		const session = await open({
			additionalDirectories: [repo],
			client: { requestPermission: f.requestPermission, readTextFile },
		});
		await session.prompt(testPrompt());
		expect(await resource(join(vault, "disk.md"))).toBe("needle vault");
		expect(await resource(local)).toBe("needle editor");
		expect(readTextFile.mock.calls.map(([path]) => path)).toEqual([local]);
	});

	it.each(["nearer appeared", "pinned removed"])(
		"rejects restore before state or backend effects when the vault location changed: %s",
		async (change) => {
			const previous = await open();
			const saved = parseNativeCheckpoint(previous.snapshot!());
			await (change === "nearer appeared"
				? mkdir(join(cwd, ".agents", "vault"), { recursive: true })
				: rm(vault, { recursive: true }));
			const loaded = await open();
			const before = loaded.snapshot!();
			expect(() => loaded.validateRestore!(saved)).toThrow(/vault differs/);
			expect(() => loaded.restore!(saved)).toThrow(/vault differs/);
			expect(loaded.snapshot!()).toEqual(before);
			expect(previous.snapshot!()).toEqual(saved);
			expect(f.requestPermission).not.toHaveBeenCalled();
			expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
		},
	);

	it("accepts the unchanged pin without effects but rejects arbitrary, descendant, and non-nearest roots atomically", async () => {
		const session = await open();
		const saved = parseNativeCheckpoint(session.snapshot!());
		session.validateRestore!(saved);
		session.restore!(saved);
		const farther = join(base, ".agents", "vault");
		await mkdir(farther, { recursive: true });
		for (const vaultRoot of [
			base,
			farther,
			join(cwd, ".agents", "vault"),
			join(cwd, "child", ".agents", "vault"),
			`${vault}/../vault`,
		]) {
			const hostile = {
				...saved,
				resources: { ...saved.resources, vaultRoot },
				selection: { ...saved.selection, thinking: "off" },
			};
			expect(() => session.validateRestore!(hostile)).toThrow();
			expect(() => session.restore!(hostile)).toThrow();
			expect(session.snapshot!()).toEqual(saved);
		}
		expect(f.requestPermission).not.toHaveBeenCalled();
		expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
	});

	it.each(["before trust", "during trust"])(
		"rechecks an external pin %s before MCP or model effects",
		async (when) => {
			const session = await open();
			const saved = session.snapshot!();
			const changeVault = () =>
				mkdir(join(cwd, ".agents", "vault"), { recursive: true });
			if (when === "before trust") {
				await changeVault();
			} else {
				f.requestPermission.mockImplementationOnce(async () => {
					await changeVault();
					return true;
				});
			}
			await expect(session.prompt(testPrompt())).rejects.toThrow(
				/vault location changed/,
			);
			expect(session.snapshot!()).toEqual(saved);
			expect(f.deps.loadMcpConfig).not.toHaveBeenCalled();
			expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
			expect(f.deps.createWorkspaceTools).not.toHaveBeenCalled();
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
			await rm(join(cwd, ".agents", "vault"), { recursive: true });
			await expect(session.prompt(testPrompt())).resolves.toBe("completed");
		},
	);
});
