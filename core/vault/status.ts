export interface VaultLintFinding {
	rule: string;
	message: string;
	path?: string;
}

export interface VaultLintSummary {
	errors: number;
	warnings: number;
}

export interface VaultStatus {
	views: string[];
	danglingLinks: string[];
	lint: {
		findings: VaultLintFinding[];
		summary: VaultLintSummary;
	};
}

// Returns an empty sentinel so the CLI rendering path is exercisable
// before the real registry / lint integration lands.
export const vaultStatus = async (): Promise<VaultStatus> => ({
	views: [],
	danglingLinks: [],
	lint: {
		findings: [],
		summary: { errors: 0, warnings: 0 },
	},
});
