/* oxlint-disable no-magic-numbers -- Long names and digest lengths are policy test data. */
import { resolve } from "node:path";
import { AgentSpec } from "@d3r/core";
import { type RuntimeTool } from "@d3r/core/runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nativeMcpScope, nativeWorkspaceScope } from "./native-permissions.ts";
import { nativeRoleTools } from "./native-resources.ts";
import { type AgentDefinition } from "./resources.ts";
import { createWorkspaceTools } from "./runtime-tools.ts";

/** Schema-backed roles keep capability selection separate from permission defaults. */
const role = (
	name: string,
	capabilities: readonly AgentSpec["capabilities"][number][],
	tools: readonly string[] = [],
): AgentDefinition => ({
	spec: AgentSpec.parse({
		name,
		tier: "low",
		description: "Permission policy test role",
		capabilities,
		tools,
	}),
	prompt: "",
});

/** Construction is inert; policy tests never execute workspace IO. */
const workspaceTools = (): RuntimeTool[] =>
	createWorkspaceTools({ cwd: resolve("native-permissions-workspace") });

/** Focused policy seams complement the assembled native permission journeys. */
describe("native permission policies", () => {
	it("selects implementor tools by capabilities before granting edits", () => {
		const tools = workspaceTools();
		const cases = [
			{ capabilities: [], names: [] },
			{
				capabilities: ["read"],
				names: ["read_file", "list_directory", "search"],
			},
			{ capabilities: ["write"], names: ["write_file"] },
			{ capabilities: ["edit"], names: ["edit_file"] },
		] as const;
		for (const { capabilities, names } of cases) {
			const selected = nativeRoleTools(
				role("implementor", capabilities, [
					"write_file",
					"edit_file",
					"run_command",
				]),
				tools,
			);
			expect(selected.map(({ name }) => name)).toEqual(names);
			expect(selected.every(({ permission }) => permission === "none")).toBe(
				true,
			);
		}
	});

	it("grants implementor writes and edits on clones without mutating shared definitions", () => {
		const tools = workspaceTools().map((tool) =>
			Object.freeze({
				...tool,
				permissionScope: nativeWorkspaceScope(tool.name),
			}),
		);
		const selected = nativeRoleTools(
			role("implementor", ["write", "edit"]),
			tools,
		);
		expect(selected.map(({ name }) => name)).toEqual([
			"write_file",
			"edit_file",
		]);
		for (const tool of selected) {
			const original = tools.find(({ name }) => name === tool.name)!;
			expect(tool).not.toBe(original);
			expect(tool).toEqual({
				...original,
				permission: "none",
				permissionScope: undefined,
			});
			expect(original.permission).toBe("ask");
			expect(original.permissionScope?.id).toBe("d3r:native:workspace-edits");
		}
	});

	it("keeps generic workspace defaults and other roles asking after implementor selection", () => {
		const tools = workspaceTools();
		expect(
			tools
				.filter(({ permission }) => permission === "ask")
				.map(({ name }) => name),
		).toEqual(["write_file", "edit_file", "run_command"]);
		expect(
			tools.every(({ permissionScope }) => permissionScope === undefined),
		).toBe(true);
		const designer = role("designer", ["write", "edit"]);
		const before = nativeRoleTools(designer, tools);
		nativeRoleTools(role("implementor", ["write", "edit"]), tools);
		for (const name of [
			"designer",
			"reviewer",
			"orchestrator",
			"custom-implementor",
		]) {
			const selected = nativeRoleTools(role(name, ["write", "edit"]), tools);
			expect(selected.map((tool) => [tool.name, tool.permission])).toEqual([
				["write_file", "ask"],
				["edit_file", "ask"],
			]);
		}
		expect(before.map(({ permission }) => permission)).toEqual(["ask", "ask"]);
	});

	it("does not extend implementor edit grants to commands or explicitly selected MCP tools", () => {
		const remote: RuntimeTool = {
			name: "mcp__files__edit_file",
			description: "Remote edit tool",
			kind: "edit",
			permission: "ask",
			permissionScope: nativeMcpScope("mcp__files__edit_file"),
			schema: z.object({}),
			execute: async () => ({ text: "unused" }),
		};
		const tools = [
			...workspaceTools().map((tool) => ({
				...tool,
				permissionScope: nativeWorkspaceScope(tool.name),
			})),
			remote,
		];
		expect(
			nativeRoleTools(
				role("implementor", ["write", "edit", "bash"]),
				tools,
			).map(({ name }) => name),
		).toEqual(["write_file", "edit_file", "run_command"]);
		const selected = nativeRoleTools(
			role("implementor", ["write", "edit", "bash"], [remote.name]),
			tools,
		);
		expect(selected.map((tool) => [tool.name, tool.permission])).toEqual([
			["write_file", "none"],
			["edit_file", "none"],
			["run_command", "ask"],
			[remote.name, "ask"],
		]);
		expect(
			selected.find(({ name }) => name === "run_command")?.permissionScope?.id,
		).toBe("d3r:native:commands");
		expect(selected.find(({ name }) => name === remote.name)).toBe(remote);
	});

	it("shares the workspace write/edit scope but isolates commands and MCP tools", () => {
		const edits = nativeWorkspaceScope("write_file")!;
		const commands = nativeWorkspaceScope("run_command")!;
		expect(edits.id).toBe("d3r:native:workspace-edits");
		expect(nativeWorkspaceScope("edit_file")).toEqual(edits);
		expect(commands.id).toBe("d3r:native:commands");
		const scopes = [
			edits,
			commands,
			nativeMcpScope("write_file"),
			nativeMcpScope("run_command"),
		];
		expect(new Set(scopes.map(({ id }) => id)).size).toBe(scopes.length);
		for (const name of [
			"read_file",
			"list_directory",
			"search",
			"vault_write",
			"vault_edit",
			"mcp__files__edit_file",
			"unknown",
		]) {
			expect(nativeWorkspaceScope(name)).toBeUndefined();
		}
	});

	it("keeps MCP scope IDs deterministic and bounded without truncating tool identity", () => {
		const names = [
			"mcp__files__write",
			"mcp__files__edit",
			"mcp__other__write",
			`mcp__${"a".repeat(4096)}__write`,
			`mcp__${"a".repeat(4096)}__edit`,
		];
		const scopes = names.map(nativeMcpScope);
		for (const name of names) {
			const scope = nativeMcpScope(name);
			expect(scope).toEqual(nativeMcpScope(name));
			expect(scope.id).toMatch(/^d3r:native:mcp:[a-f0-9]{64}$/);
			expect(scope.label).toContain(name);
		}
		expect(new Set(scopes.map(({ id }) => id)).size).toBe(names.length);
	});
});
