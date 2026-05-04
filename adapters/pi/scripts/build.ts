// Package-scoped build entry point for @d3r/adapter-pi.
//
// Wired into package.json as `prebuild` so it runs before `tsc` over the
// package, satisfying the codegen-before-typecheck ordering required by
// extensions/mode/index.ts (which imports the generated orchestrator
// contract). pnpm honours npm's pre/post script wrapping under
// `pnpm -r run`, so this is also load-bearing for workspace-wide builds.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../compile.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const coreDir = path.join(REPO_ROOT, "core");
const distDir = path.join(PACKAGE_ROOT, "dist");

const report = await compile(coreDir, distDir);
console.log(`[adapter-pi] build prepared: agents=${report.agents}`);
