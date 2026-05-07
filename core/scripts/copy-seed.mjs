// Postbuild: copy `core/seed/` into `core/dist/seed/` so the
// published tarball ships the canonical vault tree alongside the
// compiled JS. Force-overwrites on rebuild.

import { cp } from "node:fs/promises";
import path from "node:path";

const here = import.meta.dirname;
const src = path.join(here, "..", "seed");
const dest = path.join(here, "..", "dist", "seed");

await cp(src, dest, { recursive: true, force: true });
console.log("copied seed → dist/seed");
