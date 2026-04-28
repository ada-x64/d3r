// Stub for d3r init's core entry. Real body will resolve a vault root,
// promote .agents/vault into ~/.d3r/vaults/<id>, and register a
// consumer symlink in ~/.d3r/config.yaml. The signature here is the
// final one; only the body changes when the real implementation lands.

export const initView = async (_opts: { cwd: string }): Promise<never> => {
	throw new Error("not yet implemented; see designs/vault-architecture");
};
