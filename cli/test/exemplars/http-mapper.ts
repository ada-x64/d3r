// Exemplar for the testing conventions doc; not consumed by
// production code. Demonstrates a "fetch + map" seam that an
// MSW-intercepted test exercises. When `feat/cli/update-notify`
// (or any other production HTTP consumer) lands, replace this
// exemplar with the real call site.

export const fetchAndMapVersion = async (
	url: string,
): Promise<{ latest: string }> => {
	const r = await fetch(url);
	if (!r.ok) {
		throw new Error(`http ${r.status}`);
	}
	const body = (await r.json()) as { version: string };
	return { latest: body.version };
};
