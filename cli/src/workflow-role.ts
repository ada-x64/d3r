import { type Workflow } from "@d3r/core";
import { type EngineState } from "@d3r/core/engine";
import { type AgentDefinition } from "./resources.ts";

/** Private engine identity; it is not added to the user's commands or Phase picker. */
export const STANDALONE_COMMAND = "standalone";

/** A one-role graph reuses reporting, cancellation, and checkpoints without changing phase definitions. */
export const standaloneWorkflow = (
	workflow: Workflow,
	agents: readonly AgentDefinition[],
	role: string,
): Workflow => {
	if (
		role === "orchestrator" ||
		!agents.some(({ spec }) => spec.name === role)
	) {
		throw new Error("Unknown or non-delegable standalone role");
	}
	return {
		commands: {
			[STANDALONE_COMMAND]: {
				description: `Run ${role} independently`,
				chain: [{ kind: "agent", name: role }],
			},
		},
		vault: structuredClone(workflow.vault),
	};
};

/** Restore derives the only allowed graph from pinned role resources, never from a model-supplied chain. */
export const executionWorkflow = (
	workflow: Workflow,
	agents: readonly AgentDefinition[],
	{
		engine,
		phase,
		orchestrated,
		standaloneRole,
		routingInterrupted,
	}: {
		engine: EngineState | null;
		phase: string;
		orchestrated?: boolean;
		standaloneRole?: string;
		routingInterrupted: boolean;
	},
): Workflow => {
	if (standaloneRole === undefined) {
		return workflow;
	}
	if (
		!orchestrated ||
		!engine ||
		(phase !== "routing" &&
			(engine.status !== "completed" ||
				!Object.hasOwn(workflow.commands, phase))) ||
		routingInterrupted ||
		engine.command !== STANDALONE_COMMAND ||
		(standaloneRole === "implementor" && engine.mode === null)
	) {
		throw new Error("Invalid standalone role execution checkpoint");
	}
	return standaloneWorkflow(workflow, agents, standaloneRole);
};
