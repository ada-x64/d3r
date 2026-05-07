import path from "node:path";

/**
 * Absolute path to the canonical vault seed tree. In the source tier
 * this resolves to `core/seed/`; once the package is built and the
 * postbuild copy has run, the compiled `core/dist/vault/seed-root.js`
 * resolves to `core/dist/seed/`. Consumers import via the package
 * alias so the dist-tier tests exercise the shipped tarball layout.
 */
export const SEED_ROOT = path.resolve(import.meta.dirname, "..", "seed");
