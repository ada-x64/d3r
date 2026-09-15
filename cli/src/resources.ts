/* oxlint-disable no-await-in-loop -- Overlay order and aggregate discovery budgets require sequential IO. */
import { lstat, opendir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpec, Workflow } from "@d3r/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	isMissing,
	checkedWorkspaceRoot,
	isWithinRoot,
	isSensitivePath,
	ResourceAccessError,
	readDiskText,
	readWorkspaceText,
	workspacePath,
	type WorkspaceAccess,
} from "./resource-paths.ts";
import { resourceAncestors } from "./resource-ancestors.ts";
import { withResourceDeadline } from "./resource-io.ts";
import { discoverVaultRoot } from "./resource-vault.ts";
export { loadMcpConfig } from "./resource-mcp.ts";

/** Setup cancellation and injected readers stay local to this resource load. */
export interface ResourceLoadOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly resolveCorePackage?: () => string;
	readonly readText?: typeof readDiskText;
}

/** Native agents retain the core spec instead of translating to a harness shape. */
export interface AgentDefinition {
	readonly spec: AgentSpec;
	readonly prompt: string;
}

/** Skills are inert prompt resources, never executables or loaded extensions. */
export interface SkillDefinition {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	readonly path: string;
}

/** The nearest ancestral vault is independent of the exact home/workspace agent overlays. */
export interface AgentResources {
	readonly agents: AgentDefinition[];
	readonly workflow: Workflow;
	readonly instructions: string;
	readonly systemPrompt?: string;
	readonly skills: SkillDefinition[];
	readonly vaultRoot: string;
}

/** File resources deliberately have no HTTP, embedded-binary, or network fallback. */
const resourceSchema = z
	.object({ uri: z.string().min(1), mimeType: z.string().optional() })
	.passthrough();

/** Text MIME types permit common source formats, not arbitrary application data. */
const isTextMime = (mime: string): boolean =>
	/^(?:text\/[\w.+-]+|application\/(?:json|[\w.-]+\+json|xml|[\w.-]+\+xml|javascript|x-yaml|yaml|toml))(?:;.*)?$/i.test(
		mime,
	);

/** Resolve an editor resource link through the same root/secret policy as tools. */
export const resolveWorkspaceResource = async (
	resource: string | { readonly uri: string; readonly mimeType?: string },
	access: WorkspaceAccess,
): Promise<{ type: "text"; text: string }> => {
	access.signal.throwIfAborted();
	const input = resourceSchema.parse(
		typeof resource === "string" ? { uri: resource } : resource,
	);
	const uri = new URL(input.uri);
	if (
		uri.protocol !== "file:" ||
		uri.hostname ||
		uri.username ||
		uri.password ||
		uri.search ||
		uri.hash
	) {
		throw new Error(
			"Only local file URIs without authority, query, or fragment are supported",
		);
	}
	if (input.mimeType && !isTextMime(input.mimeType)) {
		throw new Error(`Non-text resource MIME type: ${input.mimeType}`);
	}
	const file = await readWorkspaceText(fileURLToPath(uri), access);
	return { type: "text", text: file.text };
};

/** Discovery limits also apply to hostile or accidentally enormous skill trees. */
const RESOURCE_LIMITS = {
	entries: 5000,
	depth: 20,
	bytes: 8_388_608,
	aliases: 50,
};

/** Parse frontmatter without evaluating YAML tags or executing resource content. */
const markdown = (
	text: string,
	path: string,
): { metadata: unknown; prompt: string } => {
	const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) {
		throw new Error(`Missing YAML frontmatter: ${path}`);
	}
	try {
		return {
			metadata: parseYaml(match[1], { maxAliasCount: RESOURCE_LIMITS.aliases }),
			prompt: text.slice(match[0].length).trim(),
		};
	} catch (error) {
		throw new Error(`Invalid frontmatter in ${path}`, { cause: error });
	}
};

/** Resolve from the installed package, never a source checkout or process cwd. */
const installedCorePackage = (): string =>
	createRequire(import.meta.url).resolve("@d3r/core/package.json");

/** Instruction scope follows directory ancestry, not repository or vault boundaries. */
const instructionRoots = (home: string, cwd: string): string[] => {
	const ancestors = resourceAncestors(
		resolve(cwd),
		new Error("Instruction discovery ancestry limit exceeded"),
	);
	const global = resolve(home);
	return [
		...(ancestors.includes(global) ? [] : [global]),
		...ancestors.toReversed(),
	];
};

/** Inherit ancestor instructions while keeping other overlays at the exact home/workspace. */
// oxlint-disable-next-line max-statements -- This shell owns the ordered core/global/workspace overlay lifecycle.
const readAgentResources = async (
	{ home, cwd }: { home: string; cwd: string },
	{
		signal,
		resolveCorePackage = installedCorePackage,
		readText = readDiskText,
	}: ResourceLoadOptions & { signal: AbortSignal },
): Promise<AgentResources> => {
	signal.throwIfAborted();
	const vaultRoot = await discoverVaultRoot(resolve(cwd), { signal });
	const core = await realpath(dirname(resolveCorePackage()));
	const coreRoot = await checkedWorkspaceRoot(core, signal);
	const resourcePath = async (path: string, root: string): Promise<string> => {
		signal.throwIfAborted();
		if (root !== core) {
			return workspacePath(path, { cwd: root, roots: [root], signal });
		}
		// Installed package assets can live under .local and use pnpm hardlinks.
		const currentRoot = await checkedWorkspaceRoot(core, signal);
		if (coreRoot.dev !== currentRoot.dev || coreRoot.ino !== currentRoot.ino) {
			throw new Error("Installed core root identity changed");
		}
		const canonical = await realpath(path);
		if (!isWithinRoot(core, canonical) || canonical !== resolve(path)) {
			throw new Error(`Installed core resource escaped its package: ${path}`);
		}
		signal.throwIfAborted();
		return canonical;
	};
	// Instruction aliases are configuration inputs, not filesystem grants to worker tools.
	const instructionPath = async (
		path: string,
		root: string,
	): Promise<string> => {
		await resourcePath(dirname(path), root);
		const info = await lstat(path);
		if (!info.isSymbolicLink()) {
			return resourcePath(path, root);
		}
		const canonical = await realpath(path).catch(() => {
			throw new ResourceAccessError(
				`Cannot resolve instruction symlink: ${path}`,
			);
		});
		if (!["AGENT.md", "AGENTS.md", "agents.md"].includes(basename(canonical))) {
			throw new ResourceAccessError(
				`Symlink instruction must resolve to an instruction file: ${path}`,
			);
		}
		const directory = dirname(canonical);
		const sharedConfig =
			basename(directory) === ".config" && !isSensitivePath(dirname(directory));
		if (isSensitivePath(canonical) && !sharedConfig) {
			throw new ResourceAccessError(
				`Sensitive instruction target denied: ${path}`,
			);
		}
		await checkedWorkspaceRoot(directory, signal);
		return canonical;
	};
	const agents = new Map<string, AgentDefinition>();
	const skills = new Map<string, SkillDefinition>();
	const instructions: string[] = [];
	let bytes = 0;
	let entries = 0;
	let systemPrompt: string | undefined = undefined;
	const read = async (
		path: string,
		root: string,
		resolvePath = resourcePath,
	): Promise<string> => {
		const canonical = await resolvePath(path, root);
		const text = await readText(
			canonical,
			signal,
			root === core && isWithinRoot(core, canonical),
		);
		signal.throwIfAborted();
		if ((await resolvePath(path, root)) !== canonical) {
			throw new ResourceAccessError(
				`Resource source changed during read: ${path}`,
			);
		}
		bytes += Buffer.byteLength(text);
		if (bytes > RESOURCE_LIMITS.bytes) {
			throw new Error("Agent resources exceed the total text limit");
		}
		return text;
	};
	const optional = async (
		path: string,
		root: string,
		resolvePath = resourcePath,
	): Promise<string | undefined> => {
		try {
			return await read(path, root, resolvePath);
		} catch (error) {
			if (isMissing(error)) {
				return undefined;
			}
			throw error;
		}
	};
	const discover = async (
		directory: string,
		root: string,
		{ kind, depth = 0 }: { kind: "agents" | "skills"; depth?: number },
	): Promise<string[]> => {
		if (depth > RESOURCE_LIMITS.depth) {
			throw new Error(`Resource discovery depth exceeded: ${directory}`);
		}
		let canonical = "";
		try {
			canonical = await resourcePath(directory, root);
		} catch (error) {
			if (isMissing(error)) {
				return [];
			}
			throw error;
		}
		const found: string[] = [];
		const handle = await opendir(canonical);
		for await (const entry of handle) {
			signal.throwIfAborted();
			if (++entries > RESOURCE_LIMITS.entries) {
				throw new Error("Resource discovery entry limit exceeded");
			}
			const path = join(canonical, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`Symlink resource denied: ${path}`);
			}
			if (
				entry.isFile() &&
				(kind === "skills"
					? entry.name === "SKILL.md"
					: entry.name.endsWith(".md"))
			) {
				found.push(path);
			} else if (entry.isDirectory()) {
				if (kind === "skills") {
					found.push(
						...(await discover(path, root, { kind, depth: depth + 1 })),
					);
				} else {
					// Agents have exactly one directory level; supporting files are not definitions.
					const candidate = join(path, "agent.md");
					try {
						found.push(await resourcePath(candidate, root));
					} catch (error) {
						if (!isMissing(error)) {
							throw error;
						}
					}
				}
			}
		}
		return found.toSorted();
	};
	const loadAgents = async (directory: string, root: string) => {
		const seen = new Map<
			string,
			{ path: string; definition: AgentDefinition }
		>();
		for (const path of await discover(directory, root, { kind: "agents" })) {
			const parsed = markdown(await read(path, root), path);
			const spec = AgentSpec.parse(parsed.metadata);
			if (!spec.name.trim()) {
				throw new Error(`Empty agent ID: ${path}`);
			}
			const definition = { spec, prompt: parsed.prompt };
			const previous = seen.get(spec.name);
			if (
				previous &&
				JSON.stringify(previous.definition) !== JSON.stringify(definition)
			) {
				throw new Error(
					`Duplicate agent ID ${spec.name}: conflicting definitions in ${previous.path} and ${path}`,
				);
			}
			if (!previous) {
				seen.set(spec.name, { path, definition });
				agents.set(spec.name, definition);
			}
		}
	};

	await loadAgents(join(core, "agents"), core);
	if (!agents.size) {
		throw new Error(`Installed core has no agent definitions: ${core}`);
	}
	let workflow = Workflow.parse(
		parseYaml(await read(join(core, "workflow.yaml"), core)),
	);
	for (const root of new Set([resolve(home), resolve(cwd)])) {
		await loadAgents(join(root, ".agents", "agents"), root);
		const override = await optional(
			join(root, ".agents", "workflow.yaml"),
			root,
		);
		if (override !== undefined) {
			const layer = Workflow.partial().strict().parse(parseYaml(override));
			workflow = Workflow.parse({
				...workflow,
				...layer,
				commands: { ...workflow.commands, ...layer.commands },
			});
		}

		const prompt = await optional(
			join(root, ".agents", "system-prompt.md"),
			root,
		);
		if (prompt !== undefined) {
			systemPrompt = prompt;
		}
		// Repository compatibility skills override globals; workspace .agents stays authoritative.
		for (const directory of [
			...(root === resolve(cwd) ? [join(root, ".github", "skills")] : []),
			join(root, ".agents", "skills"),
		]) {
			const seen = new Set<string>();
			for (const path of await discover(directory, root, { kind: "skills" })) {
				const parsed = markdown(await read(path, root), path);
				const metadata = z
					.object({
						name: z.string().min(1).optional(),
						description: z.string().min(1),
					})
					.passthrough()
					.parse(parsed.metadata);
				const name = metadata.name ?? basename(dirname(path));
				if (!name.trim() || seen.has(name)) {
					throw new Error(
						`Empty or duplicate skill ID ${name} in ${directory}`,
					);
				}
				seen.add(name);
				skills.set(name, {
					name,
					description: metadata.description,
					prompt: parsed.prompt,
					path,
				});
			}
		}
	}
	for (const root of instructionRoots(home, cwd)) {
		for (const path of [
			join(root, "AGENT.md"),
			join(root, "AGENTS.md"),
			...([resolve(home), resolve(cwd)].includes(root)
				? [join(root, ".agents", "agents.md")]
				: []),
		]) {
			const text = await optional(path, root, instructionPath);
			if (text?.trim()) {
				instructions.push(`# ${path}\n\n${text.trim()}`);
			}
		}
	}
	signal.throwIfAborted();
	return {
		agents: [...agents.values()].toSorted((a, b) =>
			a.spec.name.localeCompare(b.spec.name),
		),
		workflow,
		instructions: instructions.length
			? [
					"Inherited instructions apply to the router and every worker role. Files are listed from broad to specific scope; more specific directory instructions take precedence. Within the same directory, later files take precedence. Home instructions outside the workspace ancestry are global defaults. Source paths identify instruction scope, not additional filesystem access.",
					...instructions,
				].join("\n\n")
			: "",
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
		skills: [...skills.values()].toSorted((a, b) =>
			a.name.localeCompare(b.name),
		),
		vaultRoot,
	};
};

/** Bound the entire setup and propagate its signal through every reader and traversal. */
export const loadAgentResources = (
	{ home, cwd, signal }: { home: string; cwd: string; signal?: AbortSignal },
	options: ResourceLoadOptions = {},
): Promise<AgentResources> =>
	withResourceDeadline(
		{
			signal: options.signal ?? signal ?? new AbortController().signal,
			timeoutMs: options.timeoutMs,
		},
		(setupSignal) =>
			readAgentResources({ home, cwd }, { ...options, signal: setupSignal }),
	);
