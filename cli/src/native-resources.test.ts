import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "./mcp.ts";
import { loadModelConfig } from "./model-config.ts";
import { loadAgentResources, resolveWorkspaceResource } from "./resources.ts";
import { parseNativeCheckpoint } from "./native-resources.ts";
import {
	chosenModel,
	nativeFixture,
	testPrompt,
} from "./native-test-support.ts";

/** Real filesystem loaders verify that native composition does not confuse inert resources with code. */
describe("native resource composition", () => {
	// oxlint-disable-next-line max-statements -- One filesystem-backed lifecycle checks discovery, approval, pinned reads, and restoration.
	it("loads core/global/workspace resources and model layers, keeps MCP secrets in memory, and reads pinned global skills", async () => {
		const root = await mkdtemp(join(tmpdir(), "d3r-native-resources-"));
		const home = join(root, "home");
		const cwd = join(root, "workspace");
		const globalAgents = join(home, ".agents");
		const localAgents = join(cwd, ".agents");
		const skillPath = join(globalAgents, "skills", "inert", "SKILL.md");
		const f = nativeFixture();
		try {
			await Promise.all([
				mkdir(join(globalAgents, "skills", "inert"), { recursive: true }),
				mkdir(localAgents, { recursive: true }),
				mkdir(join(globalAgents, "d3r", "private"), {
					recursive: true,
					mode: 0o700,
				}),
			]);
			await Promise.all([
				writeFile(
					join(globalAgents, "models.json"),
					JSON.stringify({
						version: 1,
						presets: [{ id: "chosen", provider: "offline", model: "second" }],
						defaultPreset: "chosen",
					}),
				),
				writeFile(
					join(localAgents, "models.json"),
					JSON.stringify({ version: 1, defaultPreset: null }),
				),
				writeFile(join(globalAgents, "agents.md"), "GLOBAL instructions"),
				writeFile(join(localAgents, "agents.md"), "WORKSPACE instructions"),
				writeFile(
					join(localAgents, "system-prompt.md"),
					"Custom native routing instruction",
				),
				writeFile(
					skillPath,
					"---\nname: inert\ndescription: Global inert skill\n---\nDo not execute: node unexpected.js",
				),
				writeFile(
					join(localAgents, "mcp.json"),
					JSON.stringify({
						mcpServers: {
							configured: {
								command: "node",
								args: [],
								env: { API_TOKEN: { env: "NATIVE_TEST_TOKEN" } },
							},
						},
					}),
				),
				writeFile(join(cwd, "notes.txt"), "Workspace resource bytes"),
			]);
			const deps = await f.server(
				{ home },
				{
					realpath,
					loadModelConfig,
					loadAgentResources,
					resolveWorkspaceResource,
					loadMcpConfig: (roots, options) =>
						loadMcpConfig(roots, {
							...options,
							environment: { NATIVE_TEST_TOKEN: "private-resolved-token" },
						}),
				},
			);
			const session = await deps.createSession({
				sessionId: "resource-test",
				cwd,
				client: { requestPermission: f.requestPermission },
			});
			f.sessions.push(session);
			expect(session.getConfig?.()[0].value).toBe("select-model");
			const initial = parseNativeCheckpoint(session.snapshot!());
			expect(initial.sources.models).toEqual([
				join(globalAgents, "models.json"),
				join(localAgents, "models.json"),
			]);
			expect(
				initial.resources.agents.some(({ spec }) => spec.name === "designer"),
			).toBe(true);
			expect(initial.resources.instructions).toContain("GLOBAL instructions");
			expect(initial.resources.instructions).toContain(
				"WORKSPACE instructions",
			);
			expect(f.deps.connectMcpTools).not.toHaveBeenCalled();
			await session.setConfig!("model", chosenModel);
			await session.prompt(testPrompt());
			expect(f.deps.connectMcpTools).toHaveBeenCalledWith(
				[
					expect.objectContaining({
						env: [{ name: "API_TOKEN", value: "private-resolved-token" }],
					}),
				],
				expect.anything(),
			);
			const [{ options }] = f.turns;
			const skill = options.tools!.find(({ name }) => name === "read_skill")!;
			const context = {
				toolCallId: "read-inert",
				cwd,
				roots: [cwd],
				signal: new AbortController().signal,
			};
			await writeFile(
				skillPath,
				"---\nname: inert\ndescription: Changed\n---\nCHANGED skill body",
			);
			await expect(skill.execute({ name: "inert" }, context)).resolves.toEqual({
				text: expect.stringContaining("Do not execute: node unexpected.js"),
			});
			await expect(
				skill.execute({ name: "not-present" }, context),
			).rejects.toThrow("Unknown native skill");
			await expect(
				options.resolveResource!(
					{
						type: "resource_link",
						uri: pathToFileURL(join(cwd, "notes.txt")).href,
						name: "notes",
					},
					context,
				),
			).resolves.toBe("Workspace resource bytes");
			await expect(
				options.resolveResource!(
					{
						type: "resource_link",
						uri: pathToFileURL(skillPath).href,
						name: "outside workspace",
					},
					context,
				),
			).rejects.toThrow();
			const checkpoint = session.snapshot!();
			expect(JSON.stringify(checkpoint)).not.toContain(
				"private-resolved-token",
			);
			const loaded = await deps.createSession({
				sessionId: "resource-reload",
				cwd,
				client: { requestPermission: f.requestPermission },
			});
			f.sessions.push(loaded);
			loaded.restore!(checkpoint);
			expect(
				parseNativeCheckpoint(loaded.snapshot!()).resources.skills[0].prompt,
			).toBe("Do not execute: node unexpected.js");
			expect(f.models.streamSimple).not.toHaveBeenCalled();
		} finally {
			await f.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
