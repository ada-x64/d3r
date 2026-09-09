import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createEmbeddedRuntime } from "@d3r/adapter-pi/embedded";
import { type RuntimeActivity, type RuntimeSession } from "@d3r/core/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { connectMcpTools } from "../../cli/src/mcp.ts";

/** Exercise only explicitly injected model, activity, and transport callbacks. */
const prompt = async (
	session: RuntimeSession,
	events: RuntimeActivity[] = [],
) =>
	session.prompt({
		content: [{ type: "text", text: "call remote tool" }],
		signal: new AbortController().signal,
		emit: async () => {},
		activity: async (event) => {
			events.push(event);
		},
	});

/** Exercise the real MCP/Ajv boundary without connecting to a server or starting a process. */
describe("embedded MCP schema registration", () => {
	const cleanups: (() => Promise<void>)[] = [];
	const open = async (allowed = true) => {
		const inputSchema = {
			type: "object",
			properties: {
				count: { type: "integer", minimum: 1 },
				action: { type: "string", enum: ["write", "read"] },
			},
			required: ["count", "action"],
			additionalProperties: false,
		};
		const order: string[] = [];
		const callTool = vi.fn(async () => {
			order.push("effect");
			return { content: [{ type: "text", text: "remote effect completed" }] };
		});
		const close = vi.fn(async () => {});
		const mcp = await connectMcpTools(
			[
				{
					type: "http",
					name: "schema-test",
					url: "https://mcp.invalid",
					headers: [],
				},
			],
			{
				cwd: resolve("embedded-mcp-workspace"),
				createConnection: async () => ({
					listTools: async () => ({
						tools: [
							{
								name: "remote_write",
								description: "Remote write",
								inputSchema,
							},
						],
					}),
					callTool,
					close,
				}),
			},
		);
		cleanups.push(mcp.dispose);
		const validate = vi.spyOn(mcp.tools[0].schema, "safeParseAsync");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const requestPermission = vi.fn(async () => {
			order.push("permission");
			expect(callTool).not.toHaveBeenCalled();
			return allowed;
		});
		const session = createEmbeddedRuntime({
			models,
			model: faux.getModel(),
			systemPrompt: "MCP bridge test",
			tools: mcp.tools,
		})({
			sessionId: "mcp",
			cwd: resolve("embedded-mcp-workspace"),
			client: { requestPermission },
		});
		cleanups.push(session.dispose);
		return {
			session,
			faux,
			tool: mcp.tools[0],
			inputSchema,
			callTool,
			requestPermission,
			validate,
			order,
			close,
		};
	};

	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
	});

	it("registers the original JSON schema rather than the Zod record approximation", async () => {
		const f = await open();
		f.faux.setResponses([
			(context) => {
				expect(context.tools?.[0].parameters).toEqual(f.inputSchema);
				expect(context.tools?.[0].parameters).not.toBe(f.tool.inputSchema);
				const parameters = context.tools?.[0].parameters;
				expect(
					parameters && "properties" in parameters
						? parameters.properties
						: undefined,
				).not.toBe(f.tool.inputSchema.properties);
				return fauxAssistantMessage(
					fauxToolCall(f.tool.name, { count: 1, action: "write" }),
				);
			},
			fauxAssistantMessage("done"),
		]);
		await expect(prompt(f.session)).resolves.toBe("completed");
		expect(f.validate).toHaveBeenCalledOnce();
		expect(f.callTool).toHaveBeenCalledWith(
			"remote_write",
			{ count: 1, action: "write" },
			expect.any(AbortSignal),
		);
		expect(f.order).toEqual(["permission", "effect"]);
	});

	it("enforces originating Ajv validation on raw arguments before permission despite Pi coercion", async () => {
		const f = await open();
		const args = { count: "1", action: "write" };
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall(f.tool.name, args)),
			fauxAssistantMessage("invalid"),
		]);
		const events: RuntimeActivity[] = [];
		await expect(prompt(f.session, events)).resolves.toBe("completed");
		expect(f.validate).toHaveBeenCalledWith(args);
		expect(f.requestPermission).not.toHaveBeenCalled();
		expect(f.callTool).not.toHaveBeenCalled();
		expect(events.findLast((event) => event.kind === "tool")).toMatchObject({
			status: "failed",
			content: [
				{ type: "text", text: "Tool arguments failed schema validation" },
			],
		});
	});

	it("does not bypass approval for tools with original schemas", async () => {
		const f = await open(false);
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(f.tool.name, { count: 1, action: "read" }),
			),
			fauxAssistantMessage("denied"),
		]);
		await expect(prompt(f.session)).resolves.toBe("completed");
		expect(f.requestPermission).toHaveBeenCalledOnce();
		expect(f.callTool).not.toHaveBeenCalled();
		await f.session.dispose();
		// Embedded disposal cannot close caller-owned MCP connections behind its back.
		expect(f.close).not.toHaveBeenCalled();
	});
});
