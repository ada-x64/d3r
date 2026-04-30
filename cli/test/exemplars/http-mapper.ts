// Exemplar for the testing conventions doc; not consumed by
// production code. Demonstrates a "fetch + map" seam that an
// MSW-intercepted test exercises. When `feat/cli/update-notify`
// (or any other production HTTP consumer) lands, replace this
// exemplar with the real call site.

import { z } from "zod";

const VersionPayload = z.object({ version: z.string() });

export const fetchAndMapVersion = async (
	url: string,
): Promise<{ latest: string }> => {
	const r = await fetch(url);
	if (!r.ok) {
		throw new Error(`http ${r.status}`);
	}
	const body = VersionPayload.parse(await r.json());
	return { latest: body.version };
};
