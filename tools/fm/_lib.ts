// Thin wrapper around gray-matter so the rest of the package never
// imports gray-matter directly. Keeps frontmatter parsing/serialisation
// in one swappable spot.

import matter from "gray-matter";

export interface ParsedFm {
	data: Record<string, unknown>;
	body: string;
}

export const parseFm = (raw: string): ParsedFm => {
	const parsed = matter(raw);
	return {
		data: parsed.data as Record<string, unknown>,
		body: parsed.content,
	};
};

export const stringifyFm = (
	data: Record<string, unknown>,
	body: string,
): string => matter.stringify(body, data);
