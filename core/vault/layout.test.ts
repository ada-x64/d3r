// Pin the layout constants against `core/workflow.yaml`. The yaml is
// informational; the constants in `layout.ts` are the runtime source
// of truth. The drift trip-wire fails fast if a contributor adds a
// new kind to one place without the other.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
	GOVERNANCE_FILES,
	KANBAN_COLUMNS,
	TEMPLATE_KINDS,
	TOP_LEVEL_DIRS,
} from "./layout.ts";

const workflow = parseYaml(
	readFileSync(
		path.resolve(import.meta.dirname, "..", "workflow.yaml"),
		"utf8",
	),
) as { vault?: { dirs?: string[]; template_kinds?: string[] } };

const EXPECTED_TOP_LEVEL_DIRS = 6;
const EXPECTED_TEMPLATE_KINDS = 13;

describe("layout", () => {
	it("exposes the canonical top-level dirs", () => {
		expect(TOP_LEVEL_DIRS.length).toBe(EXPECTED_TOP_LEVEL_DIRS);
		expect([...TOP_LEVEL_DIRS].toSorted()).toEqual(
			[...(workflow.vault?.dirs ?? [])].toSorted(),
		);
		expect(TOP_LEVEL_DIRS.length).toBe(TOP_LEVEL_DIRS.length);
	});

	it("exposes the kind templates with no governance leakage", () => {
		expect(TEMPLATE_KINDS.length).toBe(EXPECTED_TEMPLATE_KINDS);
		expect(TEMPLATE_KINDS).not.toContain("README");
		expect(TEMPLATE_KINDS).not.toContain("AGENTS");
		expect(TEMPLATE_KINDS).not.toContain("d3r");
		expect(TEMPLATE_KINDS).not.toContain("task");
	});

	it("matches the workflow.yaml template_kinds list (excluding governance)", () => {
		const yamlKinds = (workflow.vault?.template_kinds ?? []).filter(
			(k) => k !== "README" && k !== "AGENTS" && k !== "d3r",
		);
		expect([...TEMPLATE_KINDS].toSorted()).toEqual([...yamlKinds].toSorted());
	});

	it("names the four kanban columns", () => {
		expect(KANBAN_COLUMNS).toEqual([
			"0-backlog",
			"1-todo",
			"2-in-progress",
			"3-in-review",
		]);
	});

	it("names the three governance files", () => {
		expect(GOVERNANCE_FILES).toEqual(["README.md", "AGENTS.md", "d3r.md"]);
	});
});
