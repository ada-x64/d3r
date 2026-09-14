import { dirname } from "node:path";

/** One budget bounds both instruction discovery and vault candidate enumeration. */
const MAX_RESOURCE_ANCESTORS = 256;

/** Walk a canonical path nearest-first; callers own normalization and access checks. */
export const resourceAncestors = (
	canonicalPath: string,
	limitError: Error,
): string[] => {
	const ancestors: string[] = [];
	let cursor = canonicalPath;
	for (;;) {
		if (ancestors.length >= MAX_RESOURCE_ANCESTORS) {
			throw limitError;
		}
		ancestors.push(cursor);
		const parent = dirname(cursor);
		if (parent === cursor) {
			return ancestors;
		}
		cursor = parent;
	}
};
