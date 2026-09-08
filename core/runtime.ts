/** Prompt content independent of any editor protocol or model provider. */
export type RuntimeContent =
	| { readonly type: "text"; readonly text: string }
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
}

/** A per-conversation runtime; disposal happens only after prompt settlement. */
export interface RuntimeSession {
	readonly prompt: (request: RuntimePrompt) => Promise<RuntimeStopReason>;
	readonly dispose: () => Promise<void>;
}

/** Construct an isolated runtime without starting background work. */
export type CreateRuntimeSession = (input: {
	readonly sessionId: string;
	readonly cwd: string;
}) => RuntimeSession;
