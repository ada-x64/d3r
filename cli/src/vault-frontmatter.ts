/* oxlint-disable no-continue -- Metadata validation uses a bounded iterative walk. */
import { isMap, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { checkedText } from "./resource-paths.ts";

/** Metadata remains a small JSON-compatible tree, even after YAML alias resolution. */
const METADATA_LIMITS = { aliases: 50, nodes: 5000, depth: 20 };

/** Parse failures are distinct from IO errors so discovery can report incomplete coverage. */
export class VaultFrontmatterError extends Error {
	override name = "VaultFrontmatterError";
}

/** Validate before serialization can invoke object hooks or emit non-data YAML tags. */
const checkedMetadata = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new VaultFrontmatterError(
			"Frontmatter must be a mapping with string keys",
		);
	}
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	let nodes = 0;
	while (pending.length) {
		const current = pending.pop()!;
		if (
			++nodes > METADATA_LIMITS.nodes ||
			current.depth > METADATA_LIMITS.depth
		) {
			throw new VaultFrontmatterError(
				"Frontmatter exceeds metadata node/depth bounds",
			);
		}
		const item = current.value;
		if (
			item === null ||
			typeof item === "string" ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item))
		) {
			continue;
		}
		if (typeof item !== "object") {
			throw new VaultFrontmatterError(
				"Frontmatter values must be finite JSON-compatible data",
			);
		}
		const prototype = Object.getPrototypeOf(item);
		if (
			prototype !==
				(Array.isArray(item) ? Array.prototype : Object.prototype) &&
			prototype !== null
		) {
			throw new VaultFrontmatterError("Frontmatter objects must be plain data");
		}
		const descriptors = Object.getOwnPropertyDescriptors(item);
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (
				["__proto__", "constructor", "prototype"].includes(key) ||
				!("value" in descriptor)
			) {
				throw new VaultFrontmatterError(
					"Reserved keys and accessors are not supported in frontmatter",
				);
			}
			if (pending.length + nodes >= METADATA_LIMITS.nodes) {
				throw new VaultFrontmatterError(
					"Frontmatter exceeds metadata node bounds",
				);
			}
			pending.push({ value: descriptor.value, depth: current.depth + 1 });
		}
	}
	return value as Record<string, unknown>;
};

/** Inspect raw metadata before Zod's object construction can silently drop reserved keys. */
export const vaultMetadataSchema = z.preprocess((value, context) => {
	try {
		return checkedMetadata(value);
	} catch (error) {
		if (!(error instanceof VaultFrontmatterError)) {
			throw error;
		}
		context.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
		return z.NEVER;
	}
}, z.record(z.unknown()));

/** Only the YAML 1.2 core schema is allowed; warnings include unresolved/custom tags. */
const parseMetadata = (source: string): Record<string, unknown> => {
	try {
		const document = parseDocument(source, {
			schema: "core",
			version: "1.2",
			customTags: [],
			resolveKnownTags: false,
			merge: false,
			strict: true,
			stringKeys: true,
			uniqueKeys: true,
			prettyErrors: false,
		});
		if (document.errors.length || document.warnings.length) {
			throw new VaultFrontmatterError(
				"Invalid YAML frontmatter syntax or unsupported tags",
			);
		}
		if (document.contents === null) {
			return {};
		}
		if (!isMap(document.contents)) {
			throw new VaultFrontmatterError(
				"Frontmatter must be a mapping with string keys",
			);
		}
		return checkedMetadata(
			document.toJS({ maxAliasCount: METADATA_LIMITS.aliases }),
		);
	} catch (error) {
		if (error instanceof VaultFrontmatterError) {
			throw error;
		}
		throw new VaultFrontmatterError(
			"Invalid YAML frontmatter or alias limit exceeded",
			{ cause: error },
		);
	}
};

/** Recognize frontmatter delimiters without delegating language selection to an executable engine. */
export const parseVaultFrontmatter = (
	raw: string,
): { data: Record<string, unknown>; body: string } => {
	checkedText(raw);
	const opening = /^\uFEFF?---([^\r\n]*)(?:\r?\n|$)/.exec(raw);
	if (!opening) {
		return { data: {}, body: raw };
	}
	if (!["", "yaml", "yml"].includes(opening[1].trim().toLowerCase())) {
		throw new VaultFrontmatterError(
			"Unsupported frontmatter language; only YAML is allowed",
		);
	}
	const remainder = raw.slice(opening[0].length);
	const closing = /^---[\t ]*(?:\r?\n|$)/m.exec(remainder);
	if (!closing) {
		throw new VaultFrontmatterError("Unclosed YAML frontmatter");
	}
	return {
		data: parseMetadata(remainder.slice(0, closing.index)),
		body: remainder.slice(closing.index + closing[0].length),
	};
};

/** Serialize only metadata; a body beginning with ---js or ---yaml is still verbatim inert text. */
export const stringifyVaultDocument = (
	metadata: Record<string, unknown>,
	body: string,
): string => {
	checkedText(body);
	const header = stringify(checkedMetadata(metadata), {
		schema: "core",
		customTags: [],
		aliasDuplicateObjects: false,
		lineWidth: 0,
	});
	return checkedText(`---\n${header}---\n${body}`);
};
