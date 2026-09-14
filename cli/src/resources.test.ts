/* oxlint-disable init-declarations, no-magic-numbers -- Fixtures are initialized in beforeEach; numeric values are test data. */
import {
	cp,
	link,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentResources, resolveWorkspaceResource } from "./resources.ts";

/** Native frontmatter fixtures preserve IDs independently of filenames. */
const agent = (name: string, prompt: string) =>
	`---\nname: ${name}\ntier: moderate\ndescription: ${name} agent\ncapabilities: [read, edit]\n---\n${prompt}`;

/** Skill fixtures are inert Markdown bodies. */
const skill = (name: string, prompt: string) =>
	`---\nname: ${name}\ndescription: ${name} skill\n---\n${prompt}`;

/** Fixtures mimic an installed core package without relying on a source-relative lookup. */
describe("native agent resources", () => {
	let base: string;
	let core: string;
	let cwd: string;
	let home: string;
	const put = async (path: string, text: string) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
	};

	const load = () =>
		loadAgentResources(
			{ home, cwd },
			{ resolveCorePackage: () => join(core, "package.json") },
		);
	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), "d3r-resources-"));
		core = join(base, "installed-core");
		cwd = join(base, "parent", "workspace");
		home = join(base, "home");
		await Promise.all([
			mkdir(cwd, { recursive: true }),
			mkdir(home),
			put(join(core, "package.json"), '{"name":"@d3r/core"}'),
			put(join(core, "agents", "one.md"), agent("one", "core prompt")),
			put(
				join(core, "workflow.yaml"),
				"commands:\n  build:\n    description: Build\n    chain: [{kind: agent, name: one}]\nvault:\n  dirs: [notes]\n  template_kinds: [note]\n",
			),
		]);
	});
	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("cancels before package resolution or resource reads", async () => {
		const resolveCorePackage = vi.fn(() => join(core, "package.json"));
		await expect(
			loadAgentResources(
				{ home, cwd, signal: AbortSignal.abort(new Error("setup cancelled")) },
				{ resolveCorePackage },
			),
		).rejects.toThrow("setup cancelled");
		expect(resolveCorePackage).not.toHaveBeenCalled();
	});

	it("forwards setup cancellation to in-flight readers and bounds non-cooperating IO", async () => {
		const controller = new AbortController();
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const readText = vi.fn((_path: string, signal: AbortSignal) => {
			started();
			return new Promise<string>((_, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		});
		const pending = loadAgentResources(
			{ home, cwd },
			{
				signal: controller.signal,
				resolveCorePackage: () => join(core, "package.json"),
				readText,
			},
		);
		const rejected = expect(pending).rejects.toThrow("setup cancelled");
		await entered;
		controller.abort(new Error("setup cancelled"));
		await rejected;
		const stalled = vi.fn(() => new Promise<string>(() => undefined));
		await expect(
			loadAgentResources(
				{ home, cwd },
				{
					timeoutMs: 20,
					resolveCorePackage: () => join(core, "package.json"),
					readText: stalled,
				},
			),
		).rejects.toThrow(/timed out/);
	});

	it("loads core definitions as spec/prompt and keeps the workspace vault", async () => {
		const result = await load();
		expect(result.agents).toEqual([
			{
				spec: {
					name: "one",
					tier: "moderate",
					description: "one agent",
					capabilities: ["read", "edit"],
					tools: [],
					vault_scope: "local",
				},
				prompt: "core prompt",
			},
		]);
		expect(result.workflow.commands.build.chain).toEqual([
			{ kind: "agent", name: "one" },
		]);
		expect(result.vaultRoot).toBe(join(cwd, ".agents", "vault"));
		expect(result.instructions).toBe("");
		expect(result.skills).toEqual([]);
	});

	it("loads installed assets under private package stores without granting workspace access", async () => {
		const installed = join(base, ".local", "installed-core");
		await cp(core, installed, { recursive: true });
		await link(
			join(installed, "agents", "one.md"),
			join(base, "package-hardlink"),
		);
		const result = await loadAgentResources(
			{ home, cwd },
			{ resolveCorePackage: () => join(installed, "package.json") },
		);
		expect(result.agents[0].prompt).toBe("core prompt");
		await expect(
			resolveWorkspaceResource(
				pathToFileURL(join(installed, "agents", "one.md")).href,
				{ cwd: base, roots: [base], signal: new AbortController().signal },
			),
		).rejects.toThrow(/Sensitive/);
	});

	it("overlays agents, workflow commands and recursive skills by ID", async () => {
		await Promise.all([
			put(
				join(home, ".agents", "agents", "different-filename.md"),
				agent("one", "global prompt"),
			),
			put(
				join(cwd, ".agents", "agents", "workspace.md"),
				agent("one", "workspace prompt"),
			),
			put(
				join(home, ".agents", "agents", "two.md"),
				agent("two", "global second"),
			),
			put(
				join(home, ".agents", "skills", "one", "SKILL.md"),
				skill("same-id", "global skill"),
			),
			put(
				join(cwd, ".agents", "skills", "nested", "two", "SKILL.md"),
				skill("same-id", "workspace skill"),
			),
			put(
				join(cwd, ".agents", "skills", "nested", "three", "SKILL.md"),
				skill("third", "another skill"),
			),
			put(
				join(home, ".agents", "workflow.yaml"),
				"commands:\n  test:\n    description: Test\n    chain: []\n",
			),
			put(
				join(cwd, ".agents", "workflow.yaml"),
				"commands:\n  build:\n    description: Workspace build\n    chain: []\n",
			),
		]);
		const result = await load();
		expect(
			result.agents.map(({ spec, prompt }) => [spec.name, prompt]),
		).toEqual([
			["one", "workspace prompt"],
			["two", "global second"],
		]);
		expect(result.workflow.commands.build.description).toBe("Workspace build");
		expect(result.workflow.commands.test.description).toBe("Test");
		expect(result.workflow.vault.dirs).toEqual(["notes"]);
		expect(result.skills.map(({ name, prompt }) => [name, prompt])).toEqual([
			["same-id", "workspace skill"],
			["third", "another skill"],
		]);
	});

	it("overlays workspace GitHub skills over globals and beneath workspace .agents skills", async () => {
		const entries = [
			[home, ".agents", "shared", "global"],
			[home, ".agents", "github-wins", "global"],
			[cwd, ".github", "shared", "github"],
			[cwd, ".github", "github-wins", "github"],
			[cwd, ".github", "github-only", "github"],
			[cwd, ".agents", "shared", "workspace"],
		];
		await Promise.all(
			entries.map(([root, directory, name, body]) =>
				put(
					join(root, directory, "skills", "nested", name, "SKILL.md"),
					skill(name, body),
				),
			),
		);
		await Promise.all([
			put(
				join(home, ".github", "skills", "ignored", "SKILL.md"),
				"not a global skill",
			),
			put(
				join(cwd, ".github", "agents", "invalid.agent.md"),
				"not a native agent",
			),
			put(
				join(cwd, ".github", "copilot-instructions.md"),
				"DO NOT LOAD COPILOT INSTRUCTIONS",
			),
		]);
		const result = await load();
		expect(result.skills.map(({ name, prompt }) => [name, prompt])).toEqual([
			["github-only", "github"],
			["github-wins", "github"],
			["shared", "workspace"],
		]);
		expect(result.skills[1].path).toBe(
			join(cwd, ".github", "skills", "nested", "github-wins", "SKILL.md"),
		);
		expect(result.instructions).not.toContain("COPILOT");
	});

	it("rejects duplicate GitHub skill IDs within the workspace tree", async () => {
		await Promise.all(
			["first", "second"].map((folder) =>
				put(
					join(cwd, ".github", "skills", folder, "SKILL.md"),
					skill("same-id", folder),
				),
			),
		);
		await expect(load()).rejects.toThrow(/duplicate skill ID same-id/);
	});

	it("inherits ancestor instructions and discovers its vault without loading other agent resources", async () => {
		const parent = join(base, "parent");
		const vault = join(parent, ".agents", "vault");
		await Promise.all([
			mkdir(vault, { recursive: true }),
			put(join(parent, "AGENTS.md"), "Inherited parent instructions"),
			put(join(parent, ".agents", "system-prompt.md"), "DO NOT LOAD SYSTEM"),
			put(join(parent, ".agents", "agents", "invalid.md"), "invalid agent"),
			put(
				join(parent, ".agents", "skills", "invalid", "SKILL.md"),
				"invalid skill",
			),
			put(
				join(parent, ".github", "skills", "invalid", "SKILL.md"),
				"invalid skill",
			),
			put(join(parent, ".agents", "workflow.yaml"), "invalid workflow"),
			put(join(parent, ".agents", "mcp.json"), "invalid MCP"),
			put(join(parent, ".agents", "models.json"), "invalid models"),
		]);
		const result = await load();
		expect(result.vaultRoot).toBe(vault);
		expect(result.instructions).toContain("Inherited parent instructions");
		expect(result.instructions).not.toContain("DO NOT LOAD");
		expect(result.systemPrompt).toBeUndefined();
		expect(result.skills).toEqual([]);
		expect(result.agents.map(({ spec }) => spec.name)).toEqual(["one"]);
		expect(Object.keys(result.workflow.commands)).toEqual(["build"]);
	});

	describe("inherited instructions", () => {
		it("inherits both instruction filenames from ancestors in broad-to-specific order", async () => {
			await Promise.all([
				put(join(base, "AGENT.md"), "Broad ancestor instruction"),
				put(join(base, "parent", "AGENT.md"), "Parent singular instruction"),
				put(join(base, "parent", "AGENTS.md"), "Parent plural instruction"),
				put(
					join(base, "parent", "sibling", "AGENTS.md"),
					"DO NOT LOAD SIBLING",
				),
				put(join(cwd, "child", "AGENT.md"), "DO NOT LOAD DESCENDANT"),
				put(
					join(base, "parent", ".agents", "agents.md"),
					"DO NOT LOAD PARENT EITHER",
				),
				put(join(home, "AGENTS.md"), "global instructions"),
				put(join(home, ".agents", "agents.md"), "global agent instructions"),
				put(join(cwd, "AGENT.md"), "workspace singular instructions"),
				put(join(cwd, "AGENTS.md"), "workspace instructions"),
				put(join(cwd, ".agents", "agents.md"), "workspace agent instructions"),
				put(join(home, ".agents", "system-prompt.md"), "global system"),
				put(join(cwd, ".agents", "system-prompt.md"), "workspace system"),
			]);
			const result = await load();
			expect(result.instructions).toContain("global instructions");
			expect(result.instructions).toContain("global agent instructions");
			expect(result.instructions).toContain("workspace instructions");
			expect(result.instructions).toContain("workspace agent instructions");
			expect(result.instructions).not.toContain("DO NOT LOAD");
			const ordered = [
				"global instructions",
				"global agent instructions",
				"Broad ancestor instruction",
				"Parent singular instruction",
				"Parent plural instruction",
				"workspace singular instructions",
				"workspace instructions",
				"workspace agent instructions",
			];
			const positions = ordered.map((text) =>
				result.instructions.indexOf(text),
			);
			expect(positions.every((position) => position >= 0)).toBe(true);
			expect(positions).toEqual(positions.toSorted((a, b) => a - b));
			expect(result.instructions).toContain(
				`# ${join(base, "parent", "AGENT.md")}`,
			);
			expect(result.instructions).toContain(
				"more specific directory instructions take precedence",
			);
			expect(result.systemPrompt).toBe("workspace system");
		});

		it("loads home instructions once at their ancestral scope when workspace is inside home", async () => {
			const ancestorHome = join(base, "parent");
			await Promise.all([
				put(join(base, "AGENT.md"), "Broad ancestor rule"),
				put(join(ancestorHome, "AGENTS.md"), "Home ancestor rule"),
				put(join(ancestorHome, ".agents", "agents.md"), "Home legacy rule"),
				put(join(cwd, "AGENTS.md"), "Specific workspace rule"),
			]);
			const result = await loadAgentResources(
				{ home: ancestorHome, cwd },
				{ resolveCorePackage: () => join(core, "package.json") },
			);
			expect(result.instructions).toMatch(
				/Broad ancestor rule[\s\S]*Home ancestor rule[\s\S]*Home legacy rule[\s\S]*Specific workspace rule/,
			);
			expect(result.instructions.match(/Home ancestor rule/g)).toHaveLength(1);
			expect(result.instructions.match(/Home legacy rule/g)).toHaveLength(1);
		});

		it("reports an unreadable ancestor instruction rather than omitting its rules", async () => {
			const path = join(base, "parent", "AGENT.md");
			await put(path, "Do not silently skip these rules");
			await expect(
				loadAgentResources(
					{ home, cwd },
					{
						resolveCorePackage: () => join(core, "package.json"),
						readText: async (file) => {
							if (file === path) {
								throw Object.assign(new Error(`Cannot read ${path}`), {
									code: "EACCES",
								});
							}
							return readFile(file, "utf8");
						},
					},
				),
			).rejects.toThrow(`Cannot read ${path}`);
		});

		it("rejects a symlinked ancestor instruction without following it", async () => {
			const target = join(home, "unrelated.md");
			await put(target, "Not inherited instructions");
			await symlink(target, join(base, "parent", "AGENTS.md"), "file");
			await expect(load()).rejects.toThrow(/Symlink/);
		});
	});

	it.each([".agents", ".github"])(
		"does not load extensions or execute %s skill scripts",
		async (directory) => {
			const marker = join(cwd, "marker");
			await put(
				join(cwd, ".agents", "extensions", "evil.ts"),
				`throw new Error('must never import');`,
			);
			await put(
				join(cwd, directory, "skills", "example", "run.js"),
				`require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
			);
			await put(
				join(cwd, directory, "skills", "example", "SKILL.md"),
				skill("example", "Run run.js only if explicitly requested"),
			);
			const result = await load();
			expect(result.skills[0].prompt).toContain("only if explicitly requested");
			await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("supports flat Markdown, VS Code agent filenames and one-level agent directories", async () => {
		await Promise.all([
			put(
				join(cwd, ".agents", "agents", "flat.md"),
				agent("flat", "flat prompt"),
			),
			put(
				join(cwd, ".agents", "agents", "vscode.agent.md"),
				agent("vscode", "VS Code filename"),
			),
			put(
				join(cwd, ".agents", "agents", "folder", "agent.md"),
				agent("folder", "directory prompt"),
			),
			put(
				join(cwd, ".agents", "agents", "folder", "support.md"),
				"not an agent",
			),
			put(
				join(cwd, ".agents", "agents", "nested", "deeper", "agent.md"),
				"must not recurse",
			),
		]);
		const result = await load();
		expect(result.agents.map(({ spec }) => spec.name)).toEqual([
			"flat",
			"folder",
			"one",
			"vscode",
		]);
	});

	it("overlays directory agents by spec ID and deduplicates identical same-layer formats", async () => {
		await Promise.all([
			put(
				join(home, ".agents", "agents", "one", "agent.md"),
				agent("one", "global directory"),
			),
			put(
				join(cwd, ".agents", "agents", "one", "agent.md"),
				agent("one", "workspace directory"),
			),
			put(
				join(cwd, ".agents", "agents", "one.agent.md"),
				agent("one", "workspace directory"),
			),
		]);
		const result = await load();
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0].prompt).toBe("workspace directory");
	});

	it("reports both paths for conflicting IDs across directory and flat layouts", async () => {
		const flat = join(cwd, ".agents", "agents", "one.agent.md");
		const nested = join(cwd, ".agents", "agents", "one", "agent.md");
		await Promise.all([
			put(flat, agent("one", "flat")),
			put(nested, agent("one", "directory")),
		]);
		await expect(load()).rejects.toThrow(flat);
		await expect(load()).rejects.toThrow(nested);
	});

	it("does not silently ignore malformed or symlinked directory agents", async () => {
		const path = join(cwd, ".agents", "agents", "one", "agent.md");
		await put(path, "---\nname: invalid\n---\nbody");
		await expect(load()).rejects.toThrow();
		await rm(path);
		await symlink(join(core, "agents", "one.md"), path, "file");
		await expect(load()).rejects.toThrow(/Symlink/);
	});

	it("reports invalid native specs and duplicate IDs instead of silently skipping", async () => {
		await put(
			join(cwd, ".agents", "agents", "invalid.md"),
			"---\nname: invalid\n---\nbody",
		);
		await expect(load()).rejects.toThrow();
		await rm(join(cwd, ".agents", "agents", "invalid.md"));
		await put(join(cwd, ".agents", "agents", "a.md"), agent("one", "first"));
		await put(join(cwd, ".agents", "agents", "b.md"), agent("one", "second"));
		await expect(load()).rejects.toThrow(/Duplicate agent ID/);
	});

	it.each([".agents", ".github"])(
		"refuses escaping %s skill symlinks",
		async (directory) => {
			await mkdir(join(cwd, directory, "skills"), { recursive: true });
			await symlink(
				home,
				join(cwd, directory, "skills", "outside"),
				process.platform === "win32" ? "junction" : "dir",
			);
			await expect(load()).rejects.toThrow(/Symlink/);
		},
	);

	it("loads one overlay when home and cwd coincide", async () => {
		await put(join(cwd, "AGENTS.md"), "unique instruction");
		await Promise.all(
			[".github", ".agents"].map((directory) =>
				put(
					join(cwd, directory, "skills", "shared", "SKILL.md"),
					skill("shared", directory),
				),
			),
		);
		const result = await loadAgentResources(
			{ home: cwd, cwd },
			{ resolveCorePackage: () => join(core, "package.json") },
		);
		expect(result.instructions.match(/unique instruction/g)).toHaveLength(1);
		expect(result.skills.map(({ name, prompt }) => [name, prompt])).toEqual([
			["shared", ".agents"],
		]);
	});

	it("resolves text-only file URIs through negotiated editor buffers", async () => {
		const path = join(cwd, "file with spaces.txt");
		await writeFile(path, "disk");
		const readTextFile = vi.fn(async () => "unsaved text");
		const result = await resolveWorkspaceResource(
			{ uri: pathToFileURL(path).href, mimeType: "text/plain" },
			{
				cwd,
				roots: [cwd],
				signal: new AbortController().signal,
				client: { requestPermission: vi.fn(), readTextFile },
			},
		);
		expect(result).toEqual({ type: "text", text: "unsaved text" });
		expect(readTextFile).toHaveBeenCalledWith(path, expect.any(AbortSignal));
	});

	it("resolves auth source attachments while excluding the actual private store before editor IO", async () => {
		const path = join(cwd, "auth", "secrets.ts");
		await put(path, "saved implementation");
		const readTextFile = vi.fn(async () => "unsaved implementation");
		const access = {
			cwd,
			roots: [cwd],
			signal: new AbortController().signal,
			client: { requestPermission: vi.fn(), readTextFile },
		};
		await expect(
			resolveWorkspaceResource(pathToFileURL(path).href, access),
		).resolves.toEqual({ type: "text", text: "unsaved implementation" });
		expect(readTextFile).toHaveBeenCalledOnce();
		await expect(
			resolveWorkspaceResource(
				pathToFileURL(
					join(cwd, ".agents", "d3r", "private", "credentials.json"),
				).href,
				access,
			),
		).rejects.toThrow(/Sensitive path/);
		expect(readTextFile).toHaveBeenCalledOnce();
	});

	it("rejects network URIs, authority, traversal, private and binary resources", async () => {
		const access = { cwd, roots: [cwd], signal: new AbortController().signal };
		await writeFile(join(cwd, "binary"), Buffer.from([0, 1]));
		await writeFile(join(cwd, "invalid-utf8"), Buffer.from([255]));
		await symlink(
			home,
			join(cwd, "link"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await Promise.all(
			[
				"https://example.invalid/resource",
				"file://remote-server/share/file.txt",
				pathToFileURL(join(home, "outside")).href,
				pathToFileURL(join(cwd, ".env")).href,
				pathToFileURL(join(cwd, "binary")).href,
				pathToFileURL(join(cwd, "invalid-utf8")).href,
				pathToFileURL(join(cwd, "link", "outside")).href,
			].map((uri) =>
				expect(resolveWorkspaceResource(uri, access)).rejects.toThrow(),
			),
		);
		await expect(
			resolveWorkspaceResource(
				{ uri: pathToFileURL(join(cwd, "binary")).href, mimeType: "image/png" },
				access,
			),
		).rejects.toThrow(/Non-text/);
	});

	it("honors cancellation before consulting client filesystem", async () => {
		const readTextFile = vi.fn();
		await expect(
			resolveWorkspaceResource(pathToFileURL(join(cwd, "file.txt")).href, {
				cwd,
				roots: [cwd],
				signal: AbortSignal.abort(new Error("cancelled")),
				client: { requestPermission: vi.fn(), readTextFile },
			}),
		).rejects.toThrow("cancelled");
		expect(readTextFile).not.toHaveBeenCalled();
	});
});
