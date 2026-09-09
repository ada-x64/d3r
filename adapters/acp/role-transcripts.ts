import { type ToolCall, type ToolCallUpdate } from "@agentclientprotocol/sdk";
import { type RuntimeChunk } from "@d3r/core/runtime";

/** Presentation limits do not apply to structured results or model context. */
const CHARACTER_LIMIT = 65_536;
/** Bound metadata as well as text, including streams of tiny distinct messages. */
const BLOCK_LIMIT = 128;
/** Only the adapter's presentation is truncated, never the role's outcome. */
const TRUNCATION_MARKER = "[Role transcript truncated for display.]";

/** One bounded transcript belongs to one already-announced tool in the current turn. */
export interface RoleTranscript {
	tool: ToolCall;
	readonly blocks: {
		messageId: string;
		kind: RuntimeChunk["kind"];
		text: string;
	}[];
	characters: number;
	truncated: boolean;
}

/** Retain original tool content separately so final results cannot replace the transcript. */
export const createRoleTranscript = (tool: ToolCall): RoleTranscript => ({
	tool,
	blocks: [],
	characters: 0,
	truncated: false,
});

/** Stop accepting presentation text after the first omitted character or block. */
export const appendRoleChunk = (
	transcript: RoleTranscript,
	chunk: RuntimeChunk,
): boolean => {
	if (transcript.truncated || !chunk.text) {
		return false;
	}
	let block = transcript.blocks.find(
		(row) => row.messageId === chunk.messageId && row.kind === chunk.kind,
	);
	const remaining = CHARACTER_LIMIT - transcript.characters;
	if (remaining === 0 || (!block && transcript.blocks.length === BLOCK_LIMIT)) {
		transcript.truncated = true;
		return true;
	}
	if (!block) {
		block = { messageId: chunk.messageId, kind: chunk.kind, text: "" };
		transcript.blocks.push(block);
	}
	const text = chunk.text.slice(0, remaining);
	block.text += text;
	transcript.characters += text.length;
	transcript.truncated = text.length !== chunk.text.length;
	return true;
};

/** ACP has no cancelled tool status; completed and failed are both settled cards. */
export const isTerminalToolStatus = (status: ToolCall["status"]): boolean =>
	status === "completed" || status === "failed";

/** A delayed progress event cannot reopen a finished role or replace its result. */
export const updateRoleTool = (
	transcript: RoleTranscript,
	tool: ToolCall,
): void => {
	if (
		isTerminalToolStatus(transcript.tool.status) &&
		(tool.status === "pending" || tool.status === "in_progress")
	) {
		return;
	}
	transcript.tool = { ...transcript.tool, ...tool };
};

/** ACP content updates are replacement snapshots; thought and response blocks stay separate. */
export const roleTranscriptUpdate = (
	transcript: RoleTranscript,
): ToolCallUpdate & { sessionUpdate: "tool_call_update" } => ({
	...transcript.tool,
	sessionUpdate: "tool_call_update",
	content: [
		...(transcript.tool.content ?? []),
		...transcript.blocks.map(({ kind, text }) => ({
			type: "content" as const,
			content: {
				type: "text" as const,
				text: `${kind === "thought" ? "Thought" : "Response"}\n\n${text}`,
			},
		})),
		...(transcript.truncated
			? [
					{
						type: "content" as const,
						content: { type: "text" as const, text: TRUNCATION_MARKER },
					},
				]
			: []),
	],
});
