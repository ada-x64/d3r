/* oxlint-disable no-magic-numbers -- HTTP status and fixture counts are protocol assertions. */
import { createEmbeddedRuntime } from "@d3r/adapter-pi/embedded";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { GITHUB_COPILOT_MODELS } from "@earendil-works/pi-ai/providers/github-copilot.models";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createWorkflowPhaseTools,
	createWorkflowRoleTool,
} from "../../cli/src/workflow-phase-tools.ts";

/** Noncapturing groups are portable; positive/negative lookahead and lookbehind are not. */
const lookaround = /\(\?(?:[!=]|<[!=])/;
/** JavaScript's dollar anchor permits a final line terminator; runtime validation must not. */
const invalidTopics = ["a\n", "a\r\n", "a\u2028", "../a", "a/b", "a b"];
/** Parse the actual SDK request body outside provider catches, not an intermediate schema. */
const requestSchema = z.object({
	tools: z.array(
		z.object({
			name: z.string(),
			type: z.literal("function"),
			parameters: z.object({
				type: z.literal("object"),
				properties: z.object({
					topic: z
						.object({ type: z.literal("string"), pattern: z.string() })
						.optional(),
				}),
			}),
		}),
	),
});

afterEach(() => vi.unstubAllGlobals());

it("serializes portable workflow topic schemas without weakening runtime validation", async () => {
	const network = vi.fn(async () => {
		throw new Error("Live provider requests are forbidden");
	});
	vi.stubGlobal("fetch", network);
	const bodies: string[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		const body = String(init?.body);
		bodies.push(body);
		if (lookaround.test(body)) {
			return Response.json(
				{
					message:
						"Invalid JSON schema: regex lookaround is not supported. Found at $.properties.topic.pattern.",
					code: "invalid_request_body",
				},
				{ status: 400 },
			);
		}
		return new Response(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "offline", status: "completed", output: [] },
			})}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	const execute = vi.fn(async () => ({
		text: "Unexpected workflow execution",
	}));
	const tools = [
		...createWorkflowPhaseTools(
			[{ name: "develop", description: "Implement and review" }],
			execute,
		),
		createWorkflowRoleTool(
			[{ name: "auditor", description: "Read-only audit" }],
			execute,
		)!,
	];
	const model = {
		...GITHUB_COPILOT_MODELS["gpt-5.6-sol"],
		baseUrl: "https://copilot.invalid",
	};
	const session = createEmbeddedRuntime({
		model,
		thinkingLevel: "high",
		models: {
			streamSimple: (_model, context, options) =>
				streamSimple(model, context, {
					...options,
					apiKey: "offline-dummy-not-a-credential",
					env: {},
					maxRetries: 0,
					fetch,
				}),
		},
		systemPrompt: "Offline tool schema regression",
		tools,
	})({ cwd: process.cwd(), sessionId: "schema-test" });
	try {
		const outcome = await session
			.prompt({
				content: [{ type: "text", text: "Hello" }],
				signal: new AbortController().signal,
				emit: async () => {},
			})
			.catch((error: unknown) => error);
		expect(bodies).toHaveLength(1);
		const sent = requestSchema.parse(JSON.parse(bodies[0]));
		for (const [name, selection] of [
			["d3r_start_phase", { phase: "develop" }],
			["d3r_run_role", { role: "auditor" }],
		] as const) {
			const topic = sent.tools.find((tool) => tool.name === name)?.parameters
				.properties.topic;
			expect(topic).toBeDefined();
			expect(topic!.pattern).not.toMatch(lookaround);
			expect(new RegExp(topic!.pattern).test("ordinary-topic-123")).toBe(true);
			const { schema } = tools.find((tool) => tool.name === name)!;
			const input = {
				...selection,
				brief: {
					goal: "Audit",
					context: "Offline",
					acceptanceCriteria: ["Safe"],
				},
			};
			expect(
				schema.safeParse({ ...input, topic: "ordinary-topic-123" }).success,
			).toBe(true);
			for (const invalid of invalidTopics) {
				expect(schema.safeParse({ ...input, topic: invalid }).success).toBe(
					false,
				);
			}
		}
		expect(outcome).toBe("completed");
		expect(execute).not.toHaveBeenCalled();
		expect(network).not.toHaveBeenCalled();
	} finally {
		await session.dispose();
	}
});
