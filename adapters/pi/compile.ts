// Pi adapter compile entry point.
//
// compile(coreDir, distDir):
//   1. gray-matter every coreDir/agents/*.md → AgentSpec.parse
//   2. Rewrite frontmatter to pi shape (name, description, tools, tier);
//      body verbatim; write distDir/agents/<name>.md.
//   3. Parse coreDir/workflow.yaml → Workflow.parse → emitPrompts.
//   4. Force-symlink extensions/subagent (and mode, once it exists)
//      into distDir/extensions/.
//   5. Force-symlink coreDir/templates → distDir/templates.
//   6. Return BuildReport. Throw on any zod failure.

import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import { AgentSpec, Workflow } from "../../core/schema.ts";
import { piToolMap } from "./capability-map.ts";
import { emitPrompts } from "./prompt-emit.ts";

export interface BuildReport {
	agents: number;
	prompts: number;
	extensions: string[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_SRC = path.join(HERE, "extensions");

async function forceSymlink(target: string, linkPath: string): Promise<void> {
	await rm(linkPath, { force: true, recursive: true });
	await mkdir(path.dirname(linkPath), { recursive: true });
	await symlink(target, linkPath);
}

async function compileAgents(coreDir: string, distDir: string): Promise<number> {
	const agentsSrc = path.join(coreDir, "agents");
	const agentsOut = path.join(distDir, "agents");
	await mkdir(agentsOut, { recursive: true });
	const files = (await readdir(agentsSrc)).filter((f) => f.endsWith(".md"));
	for (const f of files) {
		const raw = await readFile(path.join(agentsSrc, f), "utf8");
		const parsed = matter(raw);
		const spec = AgentSpec.parse(parsed.data);
		const tools = Array.from(
			new Set(spec.capabilities.flatMap((c) => piToolMap[c])),
		);
		const piFrontmatter = {
			name: spec.name,
			description: spec.description,
			tools: tools.join(", "),
			tier: spec.tier,
		};
		const out = matter.stringify(parsed.content, piFrontmatter);
		await writeFile(path.join(agentsOut, f), out, "utf8");
	}
	return files.length;
}

async function compilePrompts(coreDir: string, distDir: string): Promise<number> {
	const wfRaw = await readFile(path.join(coreDir, "workflow.yaml"), "utf8");
	const wf = Workflow.parse(parseYaml(wfRaw));
	const written = await emitPrompts(wf, path.join(distDir, "prompts"));
	return written.length;
}

async function linkExtensions(distDir: string): Promise<string[]> {
	const wanted = ["subagent", "mode"];
	const linked: string[] = [];
	for (const name of wanted) {
		const src = path.join(EXTENSIONS_SRC, name);
		const dest = path.join(distDir, "extensions", name);
		try {
			// fs.constants.F_OK access via stat
			const { stat } = await import("node:fs/promises");
			await stat(src);
		} catch {
			console.warn(
				`[compile] skipping extensions/${name}: source not present`,
			);
			continue;
		}
		await forceSymlink(src, dest);
		linked.push(name);
	}
	return linked;
}

async function linkTemplates(coreDir: string, distDir: string): Promise<void> {
	const src = path.join(coreDir, "templates");
	const dest = path.join(distDir, "templates");
	await forceSymlink(src, dest);
}

export async function compile(
	coreDir: string,
	distDir: string,
): Promise<BuildReport> {
	await mkdir(distDir, { recursive: true });
	const agents = await compileAgents(coreDir, distDir);
	const prompts = await compilePrompts(coreDir, distDir);
	const extensions = await linkExtensions(distDir);
	await linkTemplates(coreDir, distDir);
	const report: BuildReport = { agents, prompts, extensions };
	console.log(
		`[compile:pi] agents=${agents} prompts=${prompts} extensions=[${extensions.join(", ")}]`,
	);
	return report;
}
