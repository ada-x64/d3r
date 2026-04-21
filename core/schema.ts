import { z } from "zod";

export const Capability = z.enum([
	"read",
	"write",
	"edit",
	"bash",
	"web",
	"delegate",
]);
export type Capability = z.infer<typeof Capability>;

export const AgentSpec = z.object({
	name: z.string(),
	tier: z.enum(["low", "moderate", "high"]),
	description: z.string(),
	capabilities: z.array(Capability),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

// ChainStep is recursive (loop.body holds ChainSteps). z.lazy + an explicit
// ZodType<ChainStep> annotation is the working shape; the design's bare
// z.lazy inside z.union/z.array does not produce a usable inferred type.
export type ChainStep =
	| { kind: "agent"; name: string }
	| { kind: "parallel"; agents: string[] }
	| { kind: "human"; prompt: string }
	| { kind: "loop"; max: number; body: ChainStep[] };

export const ChainStep: z.ZodType<ChainStep> = z.lazy(() =>
	z.union([
		z.object({ kind: z.literal("agent"), name: z.string() }),
		z.object({ kind: z.literal("parallel"), agents: z.array(z.string()) }),
		z.object({ kind: z.literal("human"), prompt: z.string() }),
		z.object({
			kind: z.literal("loop"),
			max: z.number(),
			body: z.array(ChainStep),
		}),
	]),
);

export const Workflow = z.object({
	commands: z.record(
		z.string(),
		z.object({
			description: z.string(),
			chain: z.array(ChainStep),
			reviews_default: z.number().optional(),
		}),
	),
	vault: z.object({
		dirs: z.array(z.string()),
		template_kinds: z.array(z.string()),
	}),
});
export type Workflow = z.infer<typeof Workflow>;
