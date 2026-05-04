// Stub entry point for the d3r-tools pi extension.
//
// The real factory (zod -> TypeBox bridge over the @d3r/tools registry)
// will replace this body in a follow-up. Today the export exists only
// so the package manifest's pi.extensions array can list this slot
// without forward references.

const register = (_pi: unknown): void => {};

export default register;
