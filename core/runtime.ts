import { type z } from "zod";

/** Prompt content independent of any editor protocol or model provider. */
export type RuntimeContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| {
			readonly type: "resource_link";
			readonly uri: string;
			readonly name: string;
			readonly description?: string;
			readonly mimeType?: string;
	  };

/** A runtime-owned message ID groups related chunks across a session. */
export interface RuntimeChunk {
	readonly kind: "text" | "thought";
	readonly messageId: string;
	readonly text: string;
	/** Presentation owner: a tool call already announced in the current turn. */
	readonly parentToolCallId?: string;
}

/** Categories for tool presentation, independent of execution policy. */
export type RuntimeToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "other";

/** Structured content emitted by a tool. */
export type RuntimeToolContent =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "diff";
			readonly path: string;
			readonly oldText: string | null;
			readonly newText: string;
	  }
	| { readonly type: "terminal"; readonly terminalId: string };

/** File locations use absolute paths and one-based line numbers. */
export interface RuntimeLocation {
	readonly path: string;
	readonly line?: number;
}

/** Work and accounting events accompany ordinary message chunks. */
export type RuntimeActivity =
	| {
			readonly kind: "tool";
			readonly toolCallId: string;
			readonly title: string;
			readonly toolKind: RuntimeToolKind;
			readonly status: "pending" | "in_progress" | "completed" | "failed";
			readonly content?: readonly RuntimeToolContent[];
			readonly locations?: readonly RuntimeLocation[];
			readonly rawInput?: unknown;
			readonly rawOutput?: unknown;
	  }
	| {
			readonly kind: "plan";
			readonly entries: readonly {
				readonly content: string;
				readonly status: "pending" | "in_progress" | "completed";
				readonly priority: "high" | "medium" | "low";
			}[];
	  }
	| {
			readonly kind: "usage";
			readonly used: number;
			readonly size: number;
			readonly cost?: { readonly amount: number; readonly currency: string };
	  };

/** Authorization is requested before privileged effects, never inferred from a title. */
export interface RuntimePermission {
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: RuntimeToolKind;
	readonly input: unknown;
}

/** A command is an executable plus argv, not implicit shell interpolation. */
export interface RuntimeCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
}

/** Captured execution results can reference a client-owned display terminal. */
export interface RuntimeCommandResult {
	readonly output: string;
	readonly exitCode: number | null;
	readonly terminalId?: string;
}

/** Optional client facilities are used only after capability negotiation. */
export interface RuntimeClientServices {
	/** Register transient tool credentials for transcript/checkpoint redaction. */
	readonly registerSecrets?: (values: readonly string[]) => void;
	readonly requestPermission: (
		request: RuntimePermission,
		signal: AbortSignal,
	) => Promise<boolean>;
	readonly readTextFile?: (
		path: string,
		signal: AbortSignal,
	) => Promise<string>;
	readonly writeTextFile?: (
		path: string,
		content: string,
		signal: AbortSignal,
	) => Promise<void>;
	readonly runCommand?: (
		command: RuntimeCommand,
		signal: AbortSignal,
	) => Promise<RuntimeCommandResult>;
	readonly ask?: (
		message: string,
		signal: AbortSignal,
	) => Promise<string | null>;
}

/** Session-supplied tool servers; connection setup remains shell-owned. */
export type RuntimeMcpServer =
	| {
			readonly name: string;
			readonly command: string;
			readonly args: string[];
			readonly env: { name: string; value: string }[];
	  }
	| {
			readonly type: "http" | "sse";
			readonly name: string;
			readonly url: string;
			readonly headers: { name: string; value: string }[];
	  };

/** Tool code parses arguments at its own schema boundary before applying effects. */
export interface RuntimeTool {
	readonly name: string;
	readonly description: string;
	readonly kind: RuntimeToolKind;
	readonly schema: z.ZodTypeAny;
	/** Original schema for tools whose execution validator contains refinements. */
	readonly inputSchema?: Record<string, unknown>;
	readonly permission: "ask" | "none";
	readonly execute: (
		args: unknown,
		context: RuntimeToolContext,
	) => Promise<RuntimeToolResult>;
}

/** Runtime tool inputs are scoped to the current turn. */
export interface RuntimeToolContext {
	readonly toolCallId: string;
	readonly cwd: string;
	readonly roots: readonly string[];
	readonly signal: AbortSignal;
	readonly client?: RuntimeClientServices;
}

/** The model sees text; the editor can additionally render diffs and locations. */
export interface RuntimeToolResult {
	readonly text: string;
	readonly isError?: boolean;
	readonly content?: readonly RuntimeToolContent[];
	readonly locations?: readonly RuntimeLocation[];
}

/** Completion reasons reported by a model/tool loop. */
export type RuntimeStopReason =
	| "completed"
	| "token_limit"
	| "request_limit"
	| "refused"
	| "cancelled";

/** A runtime must honor cancellation and await each emit before settling. */
export interface RuntimePrompt {
	readonly content: readonly RuntimeContent[];
	readonly signal: AbortSignal;
	readonly emit: (chunk: RuntimeChunk) => Promise<void>;
	readonly activity?: (event: RuntimeActivity) => Promise<void>;
}

/** Selectors are plain session metadata, not provider objects. */
export interface RuntimeConfigOption {
	readonly id: string;
	readonly name: string;
	readonly category: "model" | "thought_level" | "mode" | "_d3r";
	readonly value: string;
	readonly options: readonly {
		readonly value: string;
		readonly name: string;
	}[];
}

/** Commands are invoked through the ordinary prompt path. */
export interface RuntimeSlashCommand {
	readonly name: string;
	readonly description: string;
	readonly inputHint?: string;
}

/** A per-conversation runtime; disposal happens only after prompt settlement. */
export interface RuntimeSession {
	readonly prompt: (request: RuntimePrompt) => Promise<RuntimeStopReason>;
	readonly dispose: () => Promise<void>;
	readonly getConfig?: () => readonly RuntimeConfigOption[];
	readonly setConfig?: (
		id: string,
		value: string,
	) => Promise<readonly RuntimeConfigOption[]>;
	readonly getCommands?: () => readonly RuntimeSlashCommand[];
	readonly snapshot?: () => unknown;
	/** Non-mutating preflight runs before a durable restoration intent is written. */
	readonly validateRestore?: (checkpoint: unknown) => void;
	readonly restore?: (checkpoint: unknown) => void;
}

/** Session inputs belong to the editor workspace, not the server startup directory. */
export interface RuntimeSessionInput {
	readonly sessionId: string;
	readonly cwd: string;
	/** Cancels setup only; prompt signals govern subsequent turns. */
	readonly signal?: AbortSignal;
	readonly additionalDirectories?: readonly string[];
	readonly mcpServers?: readonly RuntimeMcpServer[];
	readonly client?: RuntimeClientServices;
}

/** Construct an isolated runtime without starting background work. */
export type CreateRuntimeSession = (
	input: RuntimeSessionInput,
) => RuntimeSession;

/** Shell composition may need asynchronous auth, resource, and tool discovery. */
export type OpenRuntimeSession = (
	input: RuntimeSessionInput,
) => RuntimeSession | Promise<RuntimeSession>;
