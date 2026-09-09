import { type McpServer } from "@agentclientprotocol/sdk";
import { createSessionStore } from "@d3r/adapter-acp/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { CWD, fixture, runtime } from "./test-support.ts";
import { type ClientServices } from "./client.ts";

/** Credential detection must not turn common MCP settings into global text substitutions. */
it("preserves pinned model state containing '-y', '.', and common nonsecret MCP values", async () => {
	const dir = await mkdtemp(join(tmpdir(), "d3r-secrets-"));
	const store = createSessionStore(dir);
	const pinned = {
		model: "a",
		provider: "example.ai",
		directory: ".",
		argvText: "-y .",
		messages: ["-y", ".", "a", "1", "notes.md", "https://example.test/mcp"],
	};
	const mcpServers: McpServer[] = [
		{
			name: "stdio",
			command: resolve("mcp-server"),
			args: ["-y", "."],
			env: [
				{ name: "PATH", value: "." },
				{ name: "MODE", value: "a" },
				{ name: "PAGE", value: "1" },
				{ name: "MAX_TOKENS", value: "1" },
				{ name: "TOKEN_LIMIT", value: "a" },
				{ name: "PASSWORD_FILE", value: "." },
				{ name: "API_TOKEN", value: "private-env-token" },
			],
		},
		{
			type: "http",
			name: "http",
			url: "https://example.test/mcp?page=1&mode=a&token=private-query-token",
			headers: [
				{ name: "X-Mode", value: "a" },
				{ name: "Accept", value: "." },
				{ name: "Authorization", value: "Bearer private-header-token" },
			],
		},
	];
	const restore = vi.fn();
	const createSession = vi.fn(() => ({
		...runtime(),
		restore,
		snapshot: () => ({
			...pinned,
			credentialEvidence: [
				"private-env-token",
				"Bearer private-header-token",
				"private-query-token",
			],
			mcpServers,
		}),
	}));
	const f = fixture(createSession, async () => {}, { deps: { store } });
	try {
		await f.initialize();
		const { sessionId } = await f.peer.agent.request("session/new", {
			cwd: CWD,
			mcpServers,
		});
		await f.prompt(sessionId);
		const saved = await store.get(sessionId);
		expect(saved?.records.at(-1)).toMatchObject({
			kind: "checkpoint",
			state: { runtime: pinned },
		});
		const text = await readFile(join(dir, `${sessionId}.json`), "utf8");
		expect(text).not.toMatch(
			/private-env-token|private-header-token|private-query-token|mcpServers/,
		);
		await f.peer.agent.request("session/close", { sessionId });
		await f.peer.agent.request("session/resume", {
			sessionId,
			cwd: CWD,
			mcpServers,
		});
		expect(restore).toHaveBeenCalledWith({
			...pinned,
			credentialEvidence: ["[redacted]", "[redacted]", "[redacted]"],
		});
	} finally {
		await f.close();
		await rm(dir, { recursive: true, force: true });
	}
});

/** Native discovery may resolve credentials after session setup parameters have been parsed. */
it("redacts dynamically registered setup and tool credentials from every persisted checkpoint and replay record", async () => {
	const dir = await mkdtemp(join(tmpdir(), "d3r-dynamic-secrets-"));
	const store = createSessionStore(dir);
	const setupSecret = "resolved-setup-credential";
	const toolSecret = "resolved-tool-credential";
	const messages = [setupSecret, ".", "-y", "a"];
	const f = fixture(
		async (input) => {
			const services = input.client as ClientServices["services"];
			services.registerSecrets([setupSecret, "", setupSecret]);
			return {
				...runtime(),
				snapshot: () => ({ messages }),
				prompt: async (request) => {
					services.registerSecrets([toolSecret]);
					messages.push(toolSecret);
					await request.activity!({
						kind: "tool",
						toolCallId: "registered",
						title: "Resolved tool",
						toolKind: "fetch",
						status: "completed",
						rawOutput: { value: toolSecret },
					});
					return "completed";
				},
			};
		},
		async () => {},
		{ deps: { store } },
	);
	try {
		await f.initialize();
		const { sessionId } = await f.newSession();
		const initial = await readFile(join(dir, `${sessionId}.json`), "utf8");
		expect(initial).not.toContain(setupSecret);
		await f.prompt(sessionId);
		const text = await readFile(join(dir, `${sessionId}.json`), "utf8");
		expect(text).not.toContain(setupSecret);
		expect(text).not.toContain(toolSecret);
		const saved = await store.get(sessionId);
		expect(saved?.records).toContainEqual({
			kind: "update",
			update: expect.objectContaining({
				sessionUpdate: "tool_call",
				rawOutput: { value: "[redacted]" },
			}),
		});
		expect(saved?.records.at(-1)).toMatchObject({
			kind: "checkpoint",
			state: {
				runtime: { messages: ["[redacted]", ".", "-y", "a", "[redacted]"] },
			},
		});
	} finally {
		await f.close();
		await rm(dir, { recursive: true, force: true });
	}
});
