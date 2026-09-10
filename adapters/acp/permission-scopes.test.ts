/* oxlint-disable no-magic-numbers -- Counts and metadata limits are explicit boundary test data. */
import {
	type AgentContext,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { type RuntimePermission } from "@d3r/core/runtime";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { compileTools, createToolBridge } from "../pi/embedded-tools.ts";
import { createClientServices } from "./client.ts";
import { CWD, deferred } from "./test-support.ts";

/** Shell-owned web scopes deliberately separate fetching from searching. */
const FETCH = { id: "exa:web_fetch", label: "web fetches via Exa" };
/** The provider name alone must never become a permission key. */
const SEARCH = { id: "exa:web_search", label: "web searches via Exa" };
/** Clients select option IDs, not their policy kinds. */
const selected = (optionId: string): RequestPermissionResponse => ({
	outcome: { outcome: "selected", optionId },
});
/** Uncooperative replies let tests distinguish local cancellation from remote settlement. */
interface PermissionCall {
	readonly params: RequestPermissionRequest;
	readonly signal: AbortSignal;
	readonly reply: ReturnType<typeof deferred<RequestPermissionResponse>>;
}

/** Exercise root-owned approval services independently of provider and transport timing. */
describe("scoped ACP approval", () => {
	const cleanup: (() => Promise<void>)[] = [];
	const open = (sessionId = "root", secrets: readonly string[] = []) => {
		const connection = new AbortController();
		const calls: PermissionCall[] = [];
		const request = vi.fn(
			(
				method: string,
				params: RequestPermissionRequest,
				{ cancellationSignal }: { cancellationSignal: AbortSignal },
			) => {
				expect(method).toBe("session/request_permission");
				const reply = deferred<RequestPermissionResponse>();
				calls.push({ params, signal: cancellationSignal, reply });
				return reply.promise;
			},
		);
		const bridge = createClientServices(
			sessionId,
			{ request } as unknown as AgentContext,
			{ capabilities: {}, connectionSignal: connection.signal, secrets },
		);
		cleanup.push(bridge.dispose);
		let nextId = 0;
		const ask = (
			scope: unknown,
			signal = new AbortController().signal,
			overrides: Partial<RuntimePermission> = {},
		) =>
			bridge.services.requestPermission(
				{
					toolCallId: `call:${nextId++}`,
					title: "web_fetch",
					kind: "fetch",
					input: { url: "https://example.com" },
					...(scope === undefined ? {} : { scope }),
					...overrides,
				} as RuntimePermission,
				signal,
			);
		return { bridge, calls, ask, connection };
	};
	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((close) => close()));
	});

	it.each([undefined, FETCH, SEARCH])(
		"forwards only the shell-defined permission scope through Pi preflight (case %#)",
		async (permissionScope) => {
			const requestPermission = vi.fn(
				async (_request: RuntimePermission) => true,
			);
			const execute = vi.fn(async () => ({ text: "done" }));
			const requestSignal = new AbortController().signal;
			const bridge = createToolBridge(
				compileTools([
					{
						name: "renamed_tool",
						description: "Shell-owned tool",
						kind: "fetch",
						schema: z.object({ url: z.string() }),
						permission: "ask",
						...(permissionScope === undefined ? {} : { permissionScope }),
						execute,
					},
				]),
				{ sessionId: "root", cwd: CWD, client: { requestPermission } },
				{ namespace: "role", requestSignal, activity: async () => {} },
			);
			const toolCall = {
				type: "toolCall" as const,
				id: "model-call",
				name: "renamed_tool",
				arguments: {
					url: "https://example.com",
					scope: { id: "model-scope", label: "model-provided label" },
				},
			};
			await bridge.observe({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			await expect(
				bridge.beforeToolCall(
					{
						toolCall,
						args: toolCall.arguments,
						context: { systemPrompt: "", messages: [], tools: bridge.tools },
						assistantMessage: {
							role: "assistant",
							content: [toolCall],
							api: "openai-responses",
							provider: "test",
							model: "test",
							stopReason: "toolUse",
							timestamp: 0,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
						},
					},
					requestSignal,
				),
			).resolves.toBeUndefined();
			expect(requestPermission).toHaveBeenCalledTimes(1);
			expect(requestPermission.mock.calls[0][0]).toEqual({
				toolCallId: expect.stringMatching(/^role:tool:/),
				title: "renamed_tool",
				kind: "fetch",
				input: { url: "https://example.com" },
				...(permissionScope === undefined ? {} : { scope: permissionScope }),
			});
			expect(execute).not.toHaveBeenCalled();
			await bridge.tools[0].execute(
				toolCall.id,
				toolCall.arguments,
				requestSignal,
			);
			expect(execute).toHaveBeenCalledWith(
				{ url: "https://example.com" },
				expect.anything(),
			);
		},
	);

	it("coalesces simultaneous roles only after an offered thread grant and retains cache-hit previews", async () => {
		const f = open();
		const first = f.ask(FETCH);
		const second = f.ask(FETCH, undefined, {
			toolCallId: "role-b:fetch",
			title: "renamed tool",
			input: { url: "https://example.org/other" },
		});
		const third = f.ask(FETCH);
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0].params.options).toEqual([
			{ optionId: "allow", name: "Allow once", kind: "allow_once" },
			{ optionId: "reject", name: "Reject", kind: "reject_once" },
			{
				optionId: "allow_scope",
				name: "Allow web fetches via Exa for this thread",
				kind: "allow_always",
			},
		]);
		f.calls[0].reply.resolve(selected("allow_scope"));
		await expect(Promise.all([first, second, third])).resolves.toEqual([
			true,
			true,
			true,
		]);
		expect(f.calls).toHaveLength(1);
		expect(f.bridge.permissionPresentation("role-b:fetch")?.title).toBe(
			"renamed tool",
		);
		expect(
			JSON.stringify(f.bridge.permissionPresentation("role-b:fetch")),
		).toContain("https://example.org/other");
		await f.bridge.finishTurn();
		expect(f.bridge.permissionPresentation("role-b:fetch")).toBeUndefined();
		await expect(
			f.ask(FETCH, undefined, { toolCallId: "next-turn" }),
		).resolves.toBe(true);
		expect(f.calls).toHaveLength(1);
		expect(f.bridge.permissionPresentation("next-turn")).toBeDefined();
	});

	it.each([
		{ name: "once", response: selected("allow"), allowed: true },
		{ name: "deny", response: selected("reject"), allowed: false },
		{
			name: "cancel",
			response: { outcome: { outcome: "cancelled" } },
			allowed: false,
		},
		{
			name: "unknown option",
			response: selected("allow_always"),
			allowed: false,
		},
		{
			name: "permanent rejection",
			response: selected("reject_always"),
			allowed: false,
		},
		{ name: "malformed reply", response: {}, allowed: false },
	])(
		"does not share a $name decision with queued live calls",
		async ({ response, allowed }) => {
			const f = open();
			const first = f.ask(FETCH);
			const second = f.ask(FETCH);
			const third = f.ask(FETCH);
			expect(f.calls).toHaveLength(1);
			f.calls[0].reply.resolve(response as RequestPermissionResponse);
			await expect(first).resolves.toBe(allowed);
			await setImmediate();
			expect(f.calls).toHaveLength(2);
			f.calls[1].reply.resolve(selected("reject"));
			await expect(second).resolves.toBe(false);
			await setImmediate();
			expect(f.calls).toHaveLength(3);
			f.calls[2].reply.resolve(selected("allow"));
			await expect(third).resolves.toBe(true);
		},
	);

	it("releases the scope queue after a failed client request", async () => {
		const f = open();
		const first = f.ask(FETCH);
		const second = f.ask(FETCH);
		f.calls[0].reply.reject(new Error("client failed"));
		await expect(first).resolves.toBe(false);
		await setImmediate();
		expect(f.calls).toHaveLength(2);
		f.calls[1].reply.resolve(selected("allow_scope"));
		await expect(second).resolves.toBe(true);
	});

	it("does not lock different scopes or unscoped requests behind each other", async () => {
		const f = open();
		const fetching = f.ask(FETCH);
		const searching = f.ask(SEARCH);
		const unscoped = f.ask(undefined);
		expect(f.calls).toHaveLength(3);
		expect(f.calls[1].params.options.at(-1)?.name).toBe(
			"Allow web searches via Exa for this thread",
		);
		f.calls[1].reply.resolve(selected("allow_scope"));
		await expect(searching).resolves.toBe(true);
		await expect(f.ask(SEARCH)).resolves.toBe(true);
		f.calls[2].reply.resolve(selected("allow_scope"));
		await expect(unscoped).resolves.toBe(false);
		expect(f.calls).toHaveLength(3);
		f.calls[0].reply.resolve(selected("reject"));
		await expect(fetching).resolves.toBe(false);
	});

	it.each([
		undefined,
		null,
		{},
		{ id: FETCH.id },
		{ id: FETCH.id, label: "" },
		{ id: "", label: FETCH.label },
		{ id: " ", label: FETCH.label },
		{ id: 42, label: FETCH.label },
		{ id: FETCH.id, label: 42 },
		{ id: FETCH.id, label: "\n\u001b\u202e " },
		{ id: "exa:\nweb_fetch", label: FETCH.label },
		{ id: "x".repeat(257), label: FETCH.label },
		{ id: FETCH.id, label: "x".repeat(4097) },
		{ ...FETCH, extra: "not scope metadata" },
	])(
		"offers no remembered option for malformed or absent scope (case %#)",
		async (scope) => {
			const f = open();
			const first = f.ask(scope);
			expect(f.calls[0].params.options.map(({ kind }) => kind)).toEqual([
				"allow_once",
				"reject_once",
			]);
			f.calls[0].reply.resolve(selected("allow_scope"));
			await expect(first).resolves.toBe(false);
			const next = f.ask(scope);
			expect(f.calls).toHaveLength(2);
			f.calls[1].reply.resolve(selected("allow"));
			await expect(next).resolves.toBe(true);
		},
	);

	it.each([
		"run_command",
		"write_file",
		"apply_patch",
		"mcp_exa_fetch",
		"Extend response budget",
		"web_fetch",
	])(
		"never infers a scope for %s from its title or model input",
		async (title) => {
			const f = open();
			const grant = f.ask(FETCH);
			f.calls[0].reply.resolve(selected("allow_scope"));
			await grant;
			const pending = f.ask(undefined, undefined, {
				title,
				kind: "execute",
				input: { scope: FETCH, permissionScope: FETCH },
			});
			expect(f.calls).toHaveLength(2);
			expect(f.calls[1].params.options).toHaveLength(2);
			f.calls[1].reply.resolve(selected("allow_scope"));
			await expect(pending).resolves.toBe(false);
		},
	);

	it.each(["__proto__", "constructor", "toString", FETCH.id])(
		"uses the opaque scope key %s with exact, case-sensitive matching",
		async (id) => {
			const f = open();
			const scope = { id, label: FETCH.label };
			const first = f.ask(scope);
			expect(f.calls).toHaveLength(1);
			f.calls[0].reply.resolve(selected("allow_scope"));
			await expect(first).resolves.toBe(true);
			await expect(
				f.ask({ ...scope, label: "a different display label" }),
			).resolves.toBe(true);
			const others = [SEARCH.id, `${id} `, id.toUpperCase(), `${id}/child`].map(
				(other) => f.ask({ id: other, label: FETCH.label }),
			);
			expect(f.calls).toHaveLength(5);
			f.calls
				.slice(1)
				.forEach(({ reply }) => reply.resolve(selected("reject")));
			await expect(Promise.all(others)).resolves.toEqual([
				false,
				false,
				false,
				false,
			]);
		},
	);

	it("cancels a queued waiter immediately without sharing a once grant or blocking its live sibling", async () => {
		const f = open();
		const controller = new AbortController();
		const first = f.ask(FETCH);
		const cancelled = f.ask(FETCH, controller.signal);
		const live = f.ask(FETCH);
		controller.abort();
		await expect(cancelled).resolves.toBe(false);
		expect(f.calls).toHaveLength(1);
		f.calls[0].reply.resolve(selected("allow"));
		await expect(first).resolves.toBe(true);
		await setImmediate();
		expect(f.calls).toHaveLength(2);
		f.calls[1].reply.resolve(selected("allow"));
		await expect(live).resolves.toBe(true);
		await expect(f.ask(FETCH, controller.signal)).resolves.toBe(false);
		expect(f.calls).toHaveLength(2);
	});

	it("ignores a cancelled owner's late thread grant while the next live caller decides", async () => {
		const f = open();
		const controller = new AbortController();
		const first = f.ask(FETCH, controller.signal);
		const second = f.ask(FETCH);
		controller.abort();
		await expect(first).resolves.toBe(false);
		await setImmediate();
		expect(f.calls).toHaveLength(2);
		expect(f.calls[0].signal.aborted).toBe(true);
		f.calls[0].reply.resolve(selected("allow_scope"));
		await setImmediate();
		f.calls[1].reply.resolve(selected("reject"));
		await expect(second).resolves.toBe(false);
		const third = f.ask(FETCH);
		expect(f.calls).toHaveLength(3);
		f.calls[2].reply.resolve(selected("allow_scope"));
		await expect(third).resolves.toBe(true);
	});

	it("does not cache a reply resolved immediately before requester cancellation", async () => {
		const f = open();
		const controller = new AbortController();
		const first = f.ask(FETCH, controller.signal);
		f.calls[0].reply.resolve(selected("allow_scope"));
		controller.abort();
		await expect(first).resolves.toBe(false);
		const second = f.ask(FETCH);
		expect(f.calls).toHaveLength(2);
		f.calls[1].reply.resolve(selected("reject"));
		await expect(second).resolves.toBe(false);
	});

	it.each(["dispose", "disconnect"])(
		"bounds grants and pending waiters to the root lifetime on %s",
		async (ending) => {
			const f = open();
			const grant = f.ask(SEARCH);
			f.calls[0].reply.resolve(selected("allow_scope"));
			await grant;
			const first = f.ask(FETCH);
			const second = f.ask(FETCH);
			if (ending === "dispose") {
				await f.bridge.dispose();
			} else {
				f.connection.abort();
			}
			await expect(Promise.all([first, second])).resolves.toEqual([
				false,
				false,
			]);
			f.calls[1].reply.resolve(selected("allow_scope"));
			await setImmediate();
			await expect(f.ask(SEARCH)).resolves.toBe(false);
			await expect(f.ask(FETCH)).resolves.toBe(false);
			const reopened = open();
			const next = reopened.ask(SEARCH);
			expect(reopened.calls).toHaveLength(1);
			reopened.calls[0].reply.resolve(selected("reject"));
			await expect(next).resolves.toBe(false);
		},
	);

	it("never shares approvals across live roots even on the same connection", async () => {
		const f = open("first-root");
		const grant = f.ask(FETCH);
		f.calls[0].reply.resolve(selected("allow_scope"));
		await grant;
		const other = createClientServices(
			"other-root",
			{
				request: vi.fn(async () => selected("reject")),
			} as unknown as AgentContext,
			{
				capabilities: {},
				connectionSignal: f.connection.signal,
			},
		);
		cleanup.push(other.dispose);
		await expect(
			other.services.requestPermission(
				{
					toolCallId: "other:fetch",
					title: "web_fetch",
					kind: "fetch",
					input: {},
					scope: FETCH,
				},
				new AbortController().signal,
			),
		).resolves.toBe(false);
		await expect(f.ask(FETCH)).resolves.toBe(true);
	});

	it("redacts full secrets before sanitizing and truncating labels, without exposing scope keys", async () => {
		const secret = "private\nprovider-credential";
		const f = open("root", ["private", secret]);
		const first = f.ask({
			id: "secret-opaque-key",
			label: `${FETCH.label}\n\u001b\u202e ${secret} ${"x".repeat(200)}`,
		});
		const serialized = JSON.stringify(f.calls[0].params);
		expect(serialized).not.toContain("secret-opaque-key");
		expect(serialized).not.toContain("provider-credential");
		const { name } = f.calls[0].params.options.at(-1)!;
		expect(name).toContain(`${FETCH.label} [redacted] `);
		expect(name).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
		expect(name).toHaveLength(
			"Allow ".length + 100 + " for this thread".length,
		);
		expect(name).toMatch(/\.\.\. for this thread$/);
		f.calls[0].reply.resolve(selected("reject"));
		await first;
	});

	it("uses credentials registered while queued when rendering the next permission option", async () => {
		const f = open();
		const first = f.ask(FETCH);
		const second = f.ask({
			...FETCH,
			label: "fetch with newly-registered-secret",
		});
		f.bridge.services.registerSecrets(["newly-registered-secret"]);
		f.calls[0].reply.resolve(selected("allow"));
		await first;
		await setImmediate();
		expect(f.calls[1].params.options.at(-1)?.name).toBe(
			"Allow fetch with [redacted] for this thread",
		);
		f.calls[1].reply.resolve(selected("allow_scope"));
		await expect(second).resolves.toBe(true);
	});
});
