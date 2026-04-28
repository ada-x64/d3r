// Stub for d3r sync's core entry. Real body will sweep every
// registered vault view, surface dangling consumer symlinks, and run
// vault_lint across each view's contents.

export const syncAll = async (): Promise<never> => {
	throw new Error("not yet implemented; see designs/vault-architecture");
};
