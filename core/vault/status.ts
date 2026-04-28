// Stub for d3r status's core entry. Returns a typed sentinel so the
// CLI's render-and-exit path is exercisable end-to-end before the
// real vault implementation lands. The discriminator flips from
// "stub" to "ok" / "error" when the real body wires up; the JSON
// shape and the CLI render code do not change.
//
// VaultAccessor is duplicated here as a structural type rather than
// imported from @d3r/tools to keep @d3r/core free of any runtime or
// project-graph edge into @d3r/tools (which itself depends on
// @d3r/core). Tree-shaken type-only imports would not breach the
// boundary, but the workspace edge still confuses tsc's project
// resolution -- so we duplicate the four-line shape.

interface VaultResolverLike {
	resolve: () => Promise<string>;
}
type VaultAccessor = { vaultRoot: string } | { resolver: VaultResolverLike };

export interface VaultStatusView {
	id: string;
	consumer: string;
	target: string;
}

// Single-arm union for now; the real body will introduce "ok" / "error"
// arms and the discriminated-union shape lint expects.
// oxlint-disable-next-line consistent-type-definitions
export type VaultStatus = {
	kind: "stub";
	views: VaultStatusView[];
	dangling: string[];
	lint: { kind: "skipped"; reason: string };
};

export const vaultStatus = async (_opts?: {
	accessor?: VaultAccessor;
}): Promise<VaultStatus> => ({
	kind: "stub",
	views: [],
	dangling: [],
	lint: {
		kind: "skipped",
		reason:
			"vault implementation not yet wired; see designs/vault-architecture",
	},
});
