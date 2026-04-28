// Stub for d3r migrate's core entry. Real body will scan for a
// legacy in-repo .agents/vault/, relocate it under ~/.d3r/vaults/, and
// rewrite the consumer symlink in place.

export const runPendingMigrations = async (): Promise<never> => {
	throw new Error("not yet implemented; see designs/vault-architecture");
};
