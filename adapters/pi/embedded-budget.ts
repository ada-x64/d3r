import { type RuntimeTool } from "@d3r/core/runtime";
import { z } from "zod";

/** Resource grants are deliberately separate from remembered tool permissions. */
export const REQUEST_EXTENSION_TOOL = "d3r_request_extension";

/** Defaults leave room for useful work while bounding unattended provider usage. */
const DEFAULT_INITIAL_REQUESTS = 50;

/** Larger legacy initial limits remain valid, but cannot implicitly grow further. */
const DEFAULT_HARD_REQUESTS = 100;

/** A single approval cannot buy an unbounded amount of additional inference. */
const MAX_EXTENSION_REQUESTS = 50;

/** Warn early enough to save work and synthesize a final report. */
const WARNING_REQUESTS = 5;

/** An invocation starts with a finite allowance and cannot exceed its hard limit. */
export interface RequestBudgetLimits {
	readonly initial: number;
	readonly hard: number;
}

/** Mutable accounting and approval state never outlive a single prompt. */
export interface RequestBudget {
	readonly hard: number;
	readonly signal: AbortSignal;
	readonly hasTools: boolean;
	limit: number;
	used: number;
	active: boolean;
	pending: boolean;
	denied: boolean;
	lastRequestedResponse?: number;
}

/** Preserve explicitly larger legacy allowances without introducing an infinite cap. */
export const parseRequestBudgetLimits = (options: {
	readonly maxTurns?: number;
	readonly maxTotalTurns?: number;
}): RequestBudgetLimits => {
	const initial =
		options.maxTurns === undefined
			? DEFAULT_INITIAL_REQUESTS
			: options.maxTurns;
	if (!Number.isSafeInteger(initial) || initial < 1) {
		throw new Error("maxTurns must be a positive safe integer");
	}
	const hard =
		options.maxTotalTurns === undefined
			? Math.max(initial, DEFAULT_HARD_REQUESTS)
			: options.maxTotalTurns;
	if (!Number.isSafeInteger(hard) || hard < 1) {
		throw new Error("maxTotalTurns must be a positive safe integer");
	}
	if (hard < initial) {
		throw new Error("maxTotalTurns must be at least maxTurns");
	}
	return { initial, hard };
};

/** Allocate independently for siblings, subsequent prompts, and restored sessions. */
export const createRequestBudget = (
	limits: RequestBudgetLimits,
	signal: AbortSignal,
	hasTools: boolean,
): RequestBudget => ({
	hard: limits.hard,
	signal,
	hasTools,
	limit: limits.initial,
	used: 0,
	active: true,
	pending: false,
	denied: false,
});

/** Charge at the provider boundary; reminders are not conversation messages. */
export const beginBudgetedRequest = (
	budget: RequestBudget,
	systemPrompt: string | undefined,
): string => {
	budget.signal.throwIfAborted();
	if (
		!budget.active ||
		budget.used >= budget.limit ||
		budget.used >= budget.hard
	) {
		throw new Error("Model request budget exhausted");
	}
	budget.used += 1;
	const remaining = budget.limit - budget.used + 1;
	const headroom = budget.hard - budget.limit;
	const extension =
		budget.hasTools && !budget.denied && headroom > 0
			? `You may call ${REQUEST_EXTENSION_TOOL} with a nonempty reason and optional additionalRequests (1-${Math.min(MAX_EXTENSION_REQUESTS, headroom)}). Only explicit client approval extends this invocation. The response requesting an extension counts against this budget; you may request it on the last permitted response. Never assume approval or increase the limit yourself.`
			: "No extension is available for this invocation. Do not retry a denied extension.";
	return [
		systemPrompt,
		"[D3R request budget - current invocation only]",
		`Response ${budget.used} of ${budget.limit}. Remaining model requests: ${remaining}, including this response and any final synthesis. Hard cap: ${budget.hard}. Extension headroom: ${headroom}.`,
		"Reserve requests to save work, report results, and provide a final response. There is no extra final-response allowance. Earlier invocation budgets do not apply. Extensions still require this tool call; the client may reuse an explicitly remembered identical-request approval within this thread.",
		extension,
		...(remaining <= WARNING_REQUESTS
			? [
					"WARNING: 5 or fewer requests remain. Save work and report/finalize now, or request an available extension before the budget runs out.",
				]
			: []),
		"[/D3R request budget]",
	]
		.filter((line) => line !== undefined && line !== "")
		.join("\n\n");
};

/** Keep the provider schema a root object and validate original arguments in the bridge. */
const extensionSchema = z.object({
	reason: z.string().trim().min(1),
	additionalRequests: z
		.number()
		.int()
		.positive()
		.max(MAX_EXTENSION_REQUESTS)
		.optional(),
});

/** Internal resource control owns atomic approval state rather than the generic ask hook. */
export const createRequestExtensionTool = (
	budget: RequestBudget,
	label?: string,
): RuntimeTool => ({
	name: REQUEST_EXTENSION_TOOL,
	description:
		"Request client authorization for more model requests in this invocation only (a matching thread grant may satisfy approval). Supply a nonempty reason and optionally 1-50 additionalRequests (default: min(50, available headroom)). The requesting response consumes budget. Never increases the hard cap; denied requests must not be retried. Reserve room for saving work and a final report.",
	kind: "other",
	schema: extensionSchema,
	permission: "none",
	execute: async (args, { client, signal, toolCallId }) => {
		signal.throwIfAborted();
		if (!budget.active || budget.signal.aborted) {
			return { text: "Request budget is no longer active.", isError: true };
		}
		if (budget.denied) {
			return {
				text: "Request extension already denied. Do not ask again in this invocation; save work and report within the remaining budget.",
				isError: true,
			};
		}
		if (budget.pending || budget.lastRequestedResponse === budget.used) {
			return {
				text: "Duplicate request extension ignored; at most one approval request is allowed per model response.",
				isError: true,
			};
		}
		const {
			reason,
			additionalRequests = Math.min(
				MAX_EXTENSION_REQUESTS,
				budget.hard - budget.limit,
			),
		} = extensionSchema.parse(args);
		if (
			additionalRequests < 1 ||
			additionalRequests > budget.hard - budget.limit
		) {
			return {
				text: "Request extension exceeds available hard-cap headroom. Save work and report within the remaining budget.",
				isError: true,
			};
		}
		if (!client) {
			budget.denied = true;
			return {
				text: "Request extension requires a client permission service. Budget unchanged.",
				isError: true,
			};
		}
		budget.pending = true;
		budget.lastRequestedResponse = budget.used;
		const requestedLimit = budget.limit + additionalRequests;
		try {
			const approved = await client.requestPermission(
				{
					toolCallId,
					title: `Extend request budget${label ? ` (${label})` : ""}: ${budget.limit} -> ${requestedLimit} (hard cap ${budget.hard})`,
					kind: "other",
					input: {
						reason,
						additionalRequests,
						currentLimit: budget.limit,
						requestedLimit,
						maxTotalTurns: budget.hard,
					},
				},
				signal,
			);
			signal.throwIfAborted();
			budget.signal.throwIfAborted();
			if (!budget.active) {
				return { text: "Request budget is no longer active.", isError: true };
			}
			if (approved !== true) {
				budget.denied = true;
				return {
					text: "Request extension denied. Budget unchanged; do not ask again in this invocation. Save work and report within the remaining budget.",
					isError: true,
				};
			}
			budget.limit = requestedLimit;
			return {
				text: `Request extension approved for this invocation only. Limit: ${budget.limit}; remaining model requests: ${budget.limit - budget.used}, including final synthesis; hard cap: ${budget.hard}. Reserve room to save work and report.`,
			};
		} catch {
			budget.denied = true;
			return {
				text: "Request extension approval failed or was cancelled. Budget unchanged; do not retry in this invocation.",
				isError: true,
			};
		} finally {
			budget.pending = false;
		}
	},
});
