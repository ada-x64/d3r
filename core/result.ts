// Canonical discriminated-union result type used across the d3r
// packages to distinguish handled refusals (typed errors) from
// thrown exceptions (genuine I/O faults, programmer errors). Pure
// types and tiny constructors — no I/O, no zod.
//
// History: this used to be duplicated as `tools/common/result.ts`
// (with a constructor named `error`) and `core/vault/seed.ts`
// (with a constructor named `fail`). Audit of the vault-seed-init
// schema collapsed the split here; tools and vault verbs now
// share one shape and one ctor name.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const fail = <E>(err: E): Result<never, E> => ({
	ok: false,
	error: err,
});
