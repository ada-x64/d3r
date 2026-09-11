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
import { permissionIdentity } from "./permission-identity.ts";
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

	it("does not lock explicit and exact scopes behind each other", async () => {
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
		await expect(unscoped).resolves.toBe(true);
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
		"offers only an exact fallback for malformed or absent scope (case %#)",
		async (scope) => {
			const f = open();
			const first = f.ask(scope);
			expect(f.calls[0].params.options.map(({ kind }) => kind)).toEqual([
				"allow_once",
				"reject_once",
				"allow_always",
			]);
			expect(f.calls[0].params.options.at(-1)).toMatchObject({
				optionId: "allow_scope",
				name: "Allow identical requests for web_fetch for this thread",
			});
			f.calls[0].reply.resolve(selected("allow_scope"));
			await expect(first).resolves.toBe(true);
			await expect(f.ask(scope)).resolves.toBe(true);
			expect(f.calls).toHaveLength(1);
			const next = f.ask(scope, undefined, {
				input: { url: "https://other.example" },
			});
			const explicit = f.ask(FETCH);
			expect(f.calls).toHaveLength(3);
			f.calls[1].reply.resolve(selected("allow"));
			f.calls[2].reply.resolve(selected("reject"));
			await expect(next).resolves.toBe(true);
			await expect(explicit).resolves.toBe(false);
		},
	);

	it.each([
		"run_command",
		"write_file",
		"apply_patch",
		"mcp_exa_fetch",
		"Extend response budget",
		"Trust workspace",
		"Connect MCP server",
		"web_fetch",
	])(
		"never infers a broad scope for %s from its title or model input",
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
			expect(f.calls[1].params.options.at(-1)).toEqual({
				optionId: "allow_scope",
				name: `Allow identical requests for ${title} for this thread`,
				kind: "allow_always",
			});
			f.calls[1].reply.resolve(selected("allow_scope"));
			await expect(pending).resolves.toBe(true);
			const changed = f.ask(undefined, undefined, {
				title,
				kind: "execute",
				input: { scope: FETCH, permissionScope: SEARCH },
			});
			expect(f.calls).toHaveLength(3);
			f.calls[2].reply.resolve(selected("reject"));
			await expect(changed).resolves.toBe(false);
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

	it("coalesces exact requests across roles and turns, preserving reviewed cache-hit previews", async () => {
		const f = open();
		const input = {
			command: "node",
			args: ["a", "b"],
			cwd: CWD,
			env: { z: "last", a: "first" },
		};
		const first = f.ask(undefined, undefined, {
			title: "run_command",
			kind: "execute",
			input,
		});
		const second = f.ask(undefined, undefined, {
			toolCallId: "other-role",
			title: "run_command",
			kind: "execute",
			input: {
				env: { a: "first", z: "last" },
				cwd: CWD,
				args: ["a", "b"],
				command: "node",
			},
		});
		const effect = vi.fn();
		const executing = second.then((allowed) => {
			if (allowed) {
				effect();
			}
		});
		expect(f.calls).toHaveLength(1);
		await setImmediate();
		expect(effect).not.toHaveBeenCalled();
		f.calls[0].reply.resolve(selected("allow_scope"));
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
		await executing;
		expect(effect).toHaveBeenCalledTimes(1);
		expect(f.bridge.permissionPresentation("other-role")).toEqual(
			f.bridge.permissionPresentation("call:0"),
		);
		await f.bridge.finishTurn();
		expect(f.bridge.permissionPresentation("other-role")).toBeUndefined();
		await expect(
			f.ask(undefined, undefined, {
				toolCallId: "next-turn",
				title: "run_command",
				kind: "execute",
				input,
			}),
		).resolves.toBe(true);
		expect(f.bridge.permissionPresentation("next-turn")?.content).toBeDefined();
		expect(f.calls).toHaveLength(1);
	});

	it("does not reuse exact grants for different commands, argv order, cwd, credentials, title, or kind", async () => {
		const secret = "first-private-credential";
		const otherSecret = "second-private-credential";
		const f = open("root", [secret, otherSecret]);
		const title = `Connect MCP ${"x".repeat(120)} ${secret}`;
		const input = {
			command: "node",
			args: ["a", "b"],
			cwd: CWD,
			credentials: secret,
		};
		const first = f.ask(undefined, undefined, {
			title,
			kind: "execute",
			input,
		});
		f.calls[0].reply.resolve(selected("allow_scope"));
		await expect(first).resolves.toBe(true);
		const changed = [
			{ input: { ...input, command: "other" } },
			{ input: { ...input, args: ["b", "a"] } },
			{ input: { ...input, args: ["a b"] } },
			{ input: { ...input, cwd: `${CWD}/other` } },
			{ input: { ...input, credentials: otherSecret } },
			{ title: `Connect MCP ${"x".repeat(120)} ${otherSecret}` },
			{ kind: "other" as const },
		].map((overrides) =>
			f.ask(undefined, undefined, {
				title,
				kind: "execute",
				input,
				...overrides,
			}),
		);
		expect(f.calls).toHaveLength(8);
		expect(f.calls[0].params.toolCall.title).toBe(
			f.calls[6].params.toolCall.title,
		);
		expect(f.calls[0].params.toolCall.rawInput).toEqual(
			f.calls[5].params.toolCall.rawInput,
		);
		expect(f.calls[0].params.options).toEqual(f.calls[6].params.options);
		expect(JSON.stringify(f.calls.map(({ params }) => params))).not.toContain(
			secret,
		);
		expect(JSON.stringify(f.calls.map(({ params }) => params))).not.toContain(
			otherSecret,
		);
		f.calls.slice(1).forEach(({ reply }) => reply.resolve(selected("reject")));
		await expect(Promise.all(changed)).resolves.toEqual(Array(7).fill(false));
	});

	it.each(["allow", "reject", "allow_always"])(
		"does not coalesce exact requests on %s",
		async (optionId) => {
			const f = open();
			const first = f.ask(undefined);
			const second = f.ask(undefined);
			expect(f.calls).toHaveLength(1);
			f.calls[0].reply.resolve(selected(optionId));
			await expect(first).resolves.toBe(optionId === "allow");
			await setImmediate();
			expect(f.calls).toHaveLength(2);
			f.calls[1].reply.resolve(selected("reject"));
			await expect(second).resolves.toBe(false);
		},
	);

	it("discards late exact grants and cancelled waiters without blocking live siblings", async () => {
		const f = open();
		const owner = new AbortController();
		const waiter = new AbortController();
		const first = f.ask(undefined, owner.signal);
		const cancelled = f.ask(undefined, waiter.signal);
		const live = f.ask(undefined);
		waiter.abort();
		await expect(cancelled).resolves.toBe(false);
		expect(f.calls).toHaveLength(1);
		f.calls[0].reply.resolve(selected("allow_scope"));
		owner.abort();
		await expect(first).resolves.toBe(false);
		await setImmediate();
		expect(f.calls).toHaveLength(2);
		f.calls[1].reply.resolve(selected("reject"));
		await expect(live).resolves.toBe(false);
		const next = f.ask(undefined);
		expect(f.calls).toHaveLength(3);
		f.calls[2].reply.resolve(selected("allow_scope"));
		await expect(next).resolves.toBe(true);
	});

	it.each(["dispose", "disconnect"])(
		"keeps exact grants within the live root on %s",
		async (ending) => {
			const f = open();
			const first = f.ask(undefined);
			f.calls[0].reply.resolve(selected("allow_scope"));
			await first;
			const otherRequest = vi.fn(async () => selected("reject"));
			const other = createClientServices(
				"other-root",
				{ request: otherRequest } as unknown as AgentContext,
				{
					capabilities: {},
					connectionSignal: f.connection.signal,
				},
			);
			cleanup.push(other.dispose);
			await expect(
				other.services.requestPermission(
					{
						toolCallId: "other",
						title: "web_fetch",
						kind: "fetch",
						input: { url: "https://example.com" },
					},
					new AbortController().signal,
				),
			).resolves.toBe(false);
			expect(otherRequest).toHaveBeenCalledTimes(1);
			const pending = f.ask(undefined, undefined, { title: "another request" });
			const queued = f.ask(undefined, undefined, { title: "another request" });
			if (ending === "dispose") {
				await f.bridge.dispose();
			} else {
				f.connection.abort();
			}
			await expect(Promise.all([pending, queued])).resolves.toEqual([
				false,
				false,
			]);
			f.calls[1].reply.resolve(selected("allow_scope"));
			await expect(f.ask(undefined)).resolves.toBe(false);
			const reopened = open();
			const next = reopened.ask(undefined);
			expect(reopened.calls).toHaveLength(1);
			reopened.calls[0].reply.resolve(selected("reject"));
			await expect(next).resolves.toBe(false);
		},
	);

	it.each(["explicit first", "exact first"])(
		"separates explicit IDs from exact hash keys: %s",
		async (order) => {
			const f = open();
			const id = permissionIdentity({
				toolCallId: "ignored",
				title: "web_fetch",
				kind: "fetch",
				input: { url: "https://example.com" },
			})!.exactId;
			const scope = { id, label: "opaque explicit scope" };
			const first = f.ask(order === "explicit first" ? scope : undefined);
			f.calls[0].reply.resolve(selected("allow_scope"));
			await first;
			const next = f.ask(order === "explicit first" ? undefined : scope);
			expect(f.calls).toHaveLength(2);
			f.calls[1].reply.resolve(selected("reject"));
			await expect(next).resolves.toBe(false);
			expect(JSON.stringify(f.calls.map(({ params }) => params))).not.toContain(
				id,
			);
		},
	);

	it("redacts and bounds fallback labels before control sanitization and truncation", async () => {
		const secret = "private\nprovider-credential";
		const f = open("root", ["private", secret]);
		const first = f.ask(undefined, undefined, {
			title: `Connect ${secret}\n\u001b\u202e ${"x".repeat(200)}`,
		});
		const { name } = f.calls[0].params.options.at(-1)!;
		expect(name).toContain("identical requests for Connect [redacted] ");
		expect(name).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
		expect(name).toHaveLength(
			"Allow ".length + 100 + " for this thread".length,
		);
		expect(JSON.stringify(f.calls[0].params)).not.toContain(
			"provider-credential",
		);
		f.calls[0].reply.resolve(selected("reject"));
		await first;
	});

	describe("payload safety and size", () => {
		it.each(["x", "\u0001"])(
			"authorizes full 1 MiB write content under explicit and exact scopes (case %#)",
			async (character) => {
				const f = open();
				const input = {
					path: `${CWD}/large.txt`,
					content: character.repeat(1_048_576),
				};
				expect(Buffer.byteLength(input.content, "utf8")).toBe(1_048_576);
				const requests = [
					undefined,
					{
						id: "d3r:native:workspace-edits",
						label: "workspace file writes and edits",
					},
				].map((scope) =>
					f.ask(scope, undefined, { title: "write_file", kind: "edit", input }),
				);
				expect(f.calls).toHaveLength(2);
				for (const { params, reply } of f.calls) {
					expect(params.toolCall.rawInput).toEqual(input);
					expect(params.options.at(-1)).toMatchObject({
						optionId: "allow_scope",
						kind: "allow_always",
					});
					reply.resolve(selected("allow_scope"));
				}
				await expect(Promise.all(requests)).resolves.toEqual([true, true]);
			},
		);

		it.each([
			{
				input: { url: "https://example.com", absent: undefined },
				normalized: { url: "https://example.com" },
			},
			{ input: { nested: { absent: undefined } }, normalized: { nested: {} } },
			{
				input: { nested: [{ absent: undefined }] },
				normalized: { nested: [{}] },
			},
		])(
			"fails closed on undefined fields before and after an exact grant for their normalized JSON (case %#)",
			async ({ input, normalized }) => {
				const f = open();
				await expect(f.ask(undefined, undefined, { input })).resolves.toBe(
					false,
				);
				expect(f.calls).toHaveLength(0);
				expect(f.bridge.permissionPresentation("call:0")).toBeUndefined();

				const first = f.ask(undefined, undefined, { input: normalized });
				f.calls[0].reply.resolve(selected("allow_scope"));
				await expect(first).resolves.toBe(true);
				await expect(f.ask(undefined, undefined, { input })).resolves.toBe(
					false,
				);
				await expect(
					f.ask({ ...FETCH, label: "" }, undefined, { input }),
				).resolves.toBe(false);
				await expect(
					f.ask(undefined, undefined, { input: normalized }),
				).resolves.toBe(true);
				expect(f.calls).toHaveLength(1);
			},
		);

		it("never authorizes negative zero with an exact zero grant, but preserves explicit scopes", async () => {
			const f = open();
			const input = { value: -0 };
			await expect(f.ask(undefined, undefined, { input })).resolves.toBe(false);
			expect(f.calls).toHaveLength(0);
			expect(f.bridge.permissionPresentation("call:0")).toBeUndefined();
			const zero = f.ask(undefined, undefined, { input: { value: 0 } });
			f.calls[0].reply.resolve(selected("allow_scope"));
			await expect(zero).resolves.toBe(true);
			await expect(f.ask(undefined, undefined, { input })).resolves.toBe(false);
			await expect(
				f.ask({ ...FETCH, label: "" }, undefined, { input }),
			).resolves.toBe(false);
			await expect(
				f.ask(undefined, undefined, { input: { value: 0 } }),
			).resolves.toBe(true);
			expect(f.calls).toHaveLength(1);
			const explicit = f.ask(FETCH, undefined, { input });
			expect(f.calls[1].params.toolCall.rawInput).toEqual({ value: 0 });
			f.calls[1].reply.resolve(selected("allow_scope"));
			await expect(explicit).resolves.toBe(true);
			await expect(f.ask(FETCH, undefined, { input })).resolves.toBe(true);
			expect(Object.is(input.value, -0)).toBe(true);
		});

		it("normalizes undefined fields only for a validated explicit scope, never for an exact grant", async () => {
			const f = open();
			const input = {
				url: "https://example.com",
				absent: undefined,
				nested: [{ absent: undefined }],
			};
			const normalized = { url: "https://example.com", nested: [{}] };
			const first = f.ask(FETCH, undefined, { input });
			expect(f.calls[0].params.toolCall.rawInput).toEqual(normalized);
			expect(f.calls[0].params.options.at(-1)?.name).toBe(
				"Allow web fetches via Exa for this thread",
			);
			f.calls[0].reply.resolve(selected("allow_scope"));
			await expect(first).resolves.toBe(true);
			await expect(f.ask(FETCH, undefined, { input })).resolves.toBe(true);
			await expect(
				f.ask(FETCH, undefined, { input: normalized }),
			).resolves.toBe(true);
			await expect(f.ask(undefined, undefined, { input })).resolves.toBe(false);
			const exact = f.ask(undefined, undefined, { input: normalized });
			expect(f.calls).toHaveLength(2);
			f.calls[1].reply.resolve(selected("reject"));
			await expect(exact).resolves.toBe(false);
			expect(Object.hasOwn(input, "absent")).toBe(true);
			expect(Object.hasOwn(input.nested[0], "absent")).toBe(true);
		});
	});

	it("fails closed before preview or RPC on unsafe input, even with a remembered explicit grant", async () => {
		const f = open();
		const granted = f.ask(FETCH);
		f.calls[0].reply.resolve(selected("allow_scope"));
		await granted;
		const hook = vi.fn(() => {
			throw new Error("must not execute");
		});
		const cycle: unknown[] = [];
		cycle.push(cycle);
		const inputs = [
			{ toJSON: hook },
			Object.defineProperty({}, "key", { get: hook, enumerable: true }),
			new Proxy({}, { getPrototypeOf: hook, get: hook, ownKeys: hook }),
			cycle,
			undefined,
			NaN,
			[undefined],
			"x".repeat(8_388_608),
		];
		await expect(
			Promise.all(
				inputs.flatMap((input) =>
					[undefined, FETCH].map((scope) =>
						f.ask(scope, undefined, { input, toolCallId: "unsafe" }),
					),
				),
			),
		).resolves.toEqual(Array(inputs.length * 2).fill(false));
		expect(hook).not.toHaveBeenCalled();
		expect(f.calls).toHaveLength(1);
		expect(f.bridge.permissionPresentation("unsafe")).toBeUndefined();
	});

	it("falls back narrowly on executable scope metadata without running it", async () => {
		const f = open();
		const hook = vi.fn(() => {
			throw new Error("must not execute");
		});
		const scope = Object.defineProperty({ label: FETCH.label }, "id", {
			get: hook,
		});
		const first = f.ask(scope);
		expect(f.calls[0].params.options.at(-1)?.name).toBe(
			"Allow identical requests for web_fetch for this thread",
		);
		f.calls[0].reply.resolve(selected("allow_scope"));
		await expect(first).resolves.toBe(true);
		await expect(f.ask(undefined)).resolves.toBe(true);
		expect(hook).not.toHaveBeenCalled();
	});

	it("evicts the oldest grant after 1024 remembered explicit and exact scopes", async () => {
		const f = open();
		const oldest = f.ask(FETCH);
		f.calls[0].reply.resolve(selected("allow_scope"));
		await oldest;
		const requests = Array.from({ length: 1024 }, (_, i) =>
			f.ask(undefined, undefined, { input: { number: i } }),
		);
		f.calls
			.slice(1)
			.forEach(({ reply }) => reply.resolve(selected("allow_scope")));
		const allowed = await Promise.all(requests);
		expect(allowed.every(Boolean)).toBe(true);
		await f.bridge.finishTurn();
		await expect(
			f.ask(undefined, undefined, { input: { number: 0 } }),
		).resolves.toBe(true);
		await expect(
			f.ask(undefined, undefined, { input: { number: 1023 } }),
		).resolves.toBe(true);
		expect(f.calls).toHaveLength(1025);
		const evicted = f.ask(FETCH);
		expect(f.calls).toHaveLength(1026);
		f.calls.at(-1)!.reply.resolve(selected("allow_scope"));
		await expect(evicted).resolves.toBe(true);
		const exactEvicted = f.ask(undefined, undefined, { input: { number: 0 } });
		expect(f.calls).toHaveLength(1027);
		f.calls.at(-1)!.reply.resolve(selected("reject"));
		await expect(exactEvicted).resolves.toBe(false);
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
