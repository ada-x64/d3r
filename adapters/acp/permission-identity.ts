import { type RuntimeToolKind } from "@d3r/core/runtime";
import { createHash } from "node:crypto";
import { types } from "node:util";

/** A 1 MiB UTF-8 write can expand sixfold in JSON; allow that plus envelope metadata. */
const LIMITS = { depth: 32, nodes: 4096, bytes: 8_388_608 };
/** Only ACP tool categories can enter a displayed approval. */
const KINDS: ReadonlySet<string> = new Set([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"other",
]);

/** Check proxies before reflection: even getPrototypeOf can execute an untrusted trap. */
const plainRecord = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object" || types.isProxy(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
};

/** Descriptor reads never evaluate getters, including on the permission envelope. */
const dataField = (value: object, key: PropertyKey): unknown => {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor && !("value" in descriptor)) {
		throw new Error("Permission accessors are not reviewable");
	}
	return descriptor?.value;
};

/** Invalid shell metadata may fall back, but must never be interpreted by executing hooks. */
const scopeData = (value: unknown): unknown => {
	try {
		if (!plainRecord(value)) {
			return undefined;
		}
		const keys = Reflect.ownKeys(value);
		const fields = ["id", "label"];
		if (
			keys.length !== fields.length ||
			!fields.every((key) => keys.includes(key))
		) {
			return undefined;
		}
		const id = dataField(value, "id");
		const label = dataField(value, "label");
		return typeof id === "string" && typeof label === "string"
			? { id, label }
			: undefined;
	} catch {
		return undefined;
	}
};

/** Reject lossy container shapes before enumerating their bounded, ordered data fields. */
const jsonKeys = (value: object, remainingNodes: number) => {
	const array = Array.isArray(value);
	if (
		array
			? Object.getPrototypeOf(value) !== Array.prototype
			: !plainRecord(value)
	) {
		throw new Error("Permission input has a custom prototype");
	}
	const keys = Reflect.ownKeys(value);
	if (
		keys.length > remainingNodes ||
		keys.some((key) => typeof key !== "string")
	) {
		throw new Error("Permission input has too many or non-JSON keys");
	}
	const length = array ? (dataField(value, "length") as number) : 0;
	if (array && keys.length !== length + 1) {
		throw new Error("Permission arrays must be dense without extra properties");
	}
	return {
		array,
		keys: array
			? Array.from({ length }, (_, i) => String(i))
			: (keys as string[]).toSorted(),
	};
};

/** Serialize plain JSON without invoking toJSON, coercions, getters, or proxy traps. */
const canonicalJson = (input: unknown) => {
	const chunks: string[] = [];
	const ancestors = new WeakSet<object>();
	let nodes = 0;
	let bytes = 0;
	let normalizationLoss = false;
	const append = (text: string) => {
		bytes += Buffer.byteLength(text, "utf8");
		if (bytes > LIMITS.bytes) {
			throw new Error("Permission JSON exceeds byte limit");
		}
		chunks.push(text);
	};
	const quote = (text: string) => {
		if (text.length > LIMITS.bytes) {
			throw new Error("Permission string exceeds byte limit");
		}
		append(JSON.stringify(text));
	};
	const visit = (value: unknown, depth: number): void => {
		if (++nodes > LIMITS.nodes || depth > LIMITS.depth) {
			throw new Error("Permission JSON exceeds traversal limit");
		}
		if (typeof value === "string") {
			quote(value);
			return;
		}
		if (
			value === null ||
			typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value))
		) {
			normalizationLoss ||= Object.is(value, -0);
			return append(JSON.stringify(value));
		}
		if (
			typeof value !== "object" ||
			types.isProxy(value) ||
			ancestors.has(value)
		) {
			throw new Error("Permission input is not plain JSON");
		}
		const { array, keys } = jsonKeys(value, LIMITS.nodes - nodes);
		ancestors.add(value);
		append(array ? "[" : "{");
		let separator = "";
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				!descriptor?.enumerable ||
				!("value" in descriptor) ||
				key.length > LIMITS.bytes
			) {
				throw new Error(
					"Permission input contains hidden or executable fields",
				);
			}
			if (!array && descriptor.value === undefined) {
				normalizationLoss = true;
				if (++nodes > LIMITS.nodes) {
					throw new Error("Permission JSON exceeds traversal limit");
				}
			} else {
				append(separator);
				if (!array) {
					quote(key);
					append(":");
				}
				visit(descriptor.value, depth + 1);
				separator = ",";
			}
		}
		append(array ? "]" : "}");
		ancestors.delete(value);
	};
	visit(input, 0);
	return { canonical: chunks.join(""), normalizationLoss };
};

/** Snapshot for review, but issue an exact digest only for lossless JSON, excluding call IDs. */
export const permissionIdentity = (request: unknown) => {
	try {
		if (!plainRecord(request)) {
			return undefined;
		}
		const toolCallId = dataField(request, "toolCallId");
		const title = dataField(request, "title");
		const kind = dataField(request, "kind");
		if (
			typeof toolCallId !== "string" ||
			toolCallId.length > LIMITS.bytes ||
			typeof title !== "string" ||
			typeof kind !== "string" ||
			!KINDS.has(kind)
		) {
			return undefined;
		}
		const { canonical, normalizationLoss } = canonicalJson({
			title,
			kind,
			input: dataField(request, "input"),
		});
		const payload = JSON.parse(canonical) as {
			title: string;
			kind: RuntimeToolKind;
			input?: unknown;
		};
		if (!("input" in payload)) {
			return undefined;
		}
		return {
			...payload,
			input: payload.input,
			toolCallId,
			scope: scopeData(dataField(request, "scope")),
			// A valid explicit scope may review normalized JSON: it already covers differing inputs.
			// Exact grants must preserve execution distinctions: own undefined vs absent, and -0 vs 0.
			exactId: normalizationLoss
				? undefined
				: `exact:${createHash("sha256").update(canonical).digest("hex")}`,
		};
	} catch {
		return undefined;
	}
};
