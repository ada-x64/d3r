// Pin the on-disk shape of `core/seed/` against an inline expected list.
// Walks the seed tree at runtime; failure means a contributor added,
// removed, or renamed a path without updating this list. The list is
// reviewable in diffs (unlike a written snapshot file) and survives
// accidental `--update-snapshot` runs.

import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SEED_ROOT = path.resolve(import.meta.dirname, "..", "seed");

const collect = (dir: string, prefix = ""): string[] => {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			files.push(...collect(path.join(dir, entry.name), rel));
		} else {
			files.push(rel);
		}
	}
	return files.toSorted();
};

const EXPECTED_SEED_PATHS: readonly string[] = [
	".gitattributes",
	".misc/archive/.gitkeep",
	".misc/templates/.gitkeep",
	".misc/templates/audit.md",
	".misc/templates/blueprint.md",
	".misc/templates/design.md",
	".misc/templates/implementation-log.md",
	".misc/templates/issue.md",
	".misc/templates/note.md",
	".misc/templates/plan.md",
	".misc/templates/remember.md",
	".misc/templates/research.md",
	".misc/templates/review.md",
	".misc/templates/schema.md",
	".misc/templates/summary.md",
	".misc/templates/umbrella-issue.md",
	"AGENTS.md",
	"README.md",
	"blueprints/.gitkeep",
	"d3r.md",
	"issues/.umbrellas/.gitkeep",
	"issues/0-backlog/.gitkeep",
	"issues/1-todo/.gitkeep",
	"issues/2-in-progress/.gitkeep",
	"issues/3-in-review/.gitkeep",
	"notes/.gitkeep",
	"process/designs/.gitkeep",
	"process/tasks/.gitkeep",
	"reference/.gitkeep",
];

describe("seed shape", () => {
	it("matches the canonical path enumeration", () => {
		expect(collect(SEED_ROOT)).toEqual([...EXPECTED_SEED_PATHS]);
	});
});
