// Boundary parser for the shell-owned web-search configuration.
//
// `tools/` and `core/` must not read process.env directly; the shell
// reads env once, parses it through this zod schema, and threads the
// resulting typed value into `selectWebSearchProvider`. Same boundary-
// parse pattern used by `PiSettings` / `InstalledPackageJson` in
// helpers.ts.

import { z } from "zod";
import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	WEB_SEARCH_PROVIDER_ENV,
	type WebProviderConfig,
} from "@d3r/tools";

// Slice of process.env that selects the web-search provider and
// supplies its credentials. Passthrough so unrelated env keys (HOME,
// PATH, ...) do not cause a refuse: the contract here is just "the
// two keys the web-search surface looks at, parsed if present".
const WebProviderEnv = z
	.object({
		[WEB_SEARCH_PROVIDER_ENV]: z.string().min(1).optional(),
		EXA_API_KEY: z.string().min(1).optional(),
	})
	.passthrough();

export const parseWebProviderConfig = (
	env: NodeJS.ProcessEnv,
): WebProviderConfig => {
	const result = WebProviderEnv.safeParse(env);
	const data = result.success ? result.data : {};
	return {
		providerId: data[WEB_SEARCH_PROVIDER_ENV] ?? DEFAULT_WEB_SEARCH_PROVIDER,
		exaApiKey: data.EXA_API_KEY,
	};
};
