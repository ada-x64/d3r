export interface MigrateResult {
	applied: string[];
}

export const runPendingMigrations = async (): Promise<MigrateResult> => {
	throw new Error("not yet implemented");
};
