// Cross-cutting helpers for the cli package. Mirrors the `_lib.ts`
// convention used in tools/{fm,vault} so package-internal utilities
// have one obvious home.

/** Indent width passed to `JSON.stringify` for human-readable verb output. */
export const JSON_INDENT = 2;

/** Render an unknown thrown value as a string (Error.message or String()). */
export const errMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
