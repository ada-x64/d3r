// Shared output-shape helpers for verbs that produce JSON or surface
// thrown values. Keep the concern self-contained so a future change
// to JSON formatting or unknown-error stringification is one diff.

/** Indent width passed to `JSON.stringify` for human-readable verb output. */
export const JSON_INDENT = 2;

/** Render an unknown thrown value as a string (Error.message or String()). */
export const errMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
