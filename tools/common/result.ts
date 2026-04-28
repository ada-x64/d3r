// Discriminated-union result type used across the tools package to
// distinguish handled refusals (policy errors, validation failures) from
// thrown exceptions (genuine I/O faults, programmer errors). Keep this
// file pure types and tiny factories - no I/O, no zod.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const error = <E>(err: E): Result<never, E> => ({
	ok: false,
	error: err,
});
