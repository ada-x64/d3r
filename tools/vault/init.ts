// vault_init agent tool. Thin wrapper around `initVault` from
// `@d3r/core/vault/init` — collapses the params surface to
// `{ vaultRoot }` (the `seedDir` test seam stays in core, not
// here) and re-exports `InitError` so callers do not need a
// parallel error union.

import { z } from "zod";

import {
	initVault,
	type InitError,
	type InitReport,
} from "@d3r/core/vault/init";
import { type Result } from "@d3r/core/result";
import { type Spawn } from "@d3r/core/spawn";

export { type InitError, type InitReport } from "@d3r/core/vault/init";

export const VaultInitParams = z.object({
	vaultRoot: z.string(),
});
export type VaultInitParams = z.infer<typeof VaultInitParams>;

export const vaultInit = (
	params: VaultInitParams,
	deps?: { spawn?: Spawn },
): Promise<Result<InitReport, InitError>> => initVault(params, deps);
