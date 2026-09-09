import { type RuntimeContent, type RuntimePrompt } from "@d3r/core/runtime";
import {
	type Api,
	type ImageContent,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";

/** Resource access stays with the caller's workspace and permission policy. */
export type ResolveResource = (
	resource: Extract<RuntimeContent, { type: "resource_link" }>,
	context: { readonly cwd: string; readonly signal: AbortSignal },
) => Promise<string>;

/** Expand links only through injected IO, preserving input order and awaiting cleanup. */
export const prepareContent = async (
	request: RuntimePrompt,
	model: Model<Api>,
	{
		cwd,
		resolveResource,
	}: { readonly cwd: string; readonly resolveResource?: ResolveResource },
): Promise<(TextContent | ImageContent)[]> => {
	if (
		!model.input.includes("image") &&
		request.content.some((block) => block.type === "image")
	) {
		throw new Error("Selected model does not support images");
	}
	const controller = new AbortController();
	const signal = AbortSignal.any([request.signal, controller.signal]);
	const results = await Promise.allSettled(
		request.content.map(async (block): Promise<TextContent | ImageContent> => {
			try {
				signal.throwIfAborted();
				if (block.type === "text" || block.type === "image") {
					return { ...block };
				}
				if (!resolveResource) {
					throw new Error("Resource links require a configured resolver");
				}
				const text = await resolveResource(block, { cwd, signal });
				return {
					type: "text",
					text: `Resource: ${block.name}\nURI: ${block.uri}\n\n${text}`,
				};
			} catch (error) {
				controller.abort(error);
				throw error;
			}
		}),
	);
	return results.map((result) => {
		if (result.status === "rejected") {
			throw result.reason;
		}
		return result.value;
	});
};
