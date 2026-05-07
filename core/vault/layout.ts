/**
 * Dotfile entries at vault root that are admitted as-is rather than
 * flagged as `extra` by lint / repair. Hardcoded; a future
 * `.vault-ignore` parser is future work.
 */
export const DOTFILE_ALLOWLIST: ReadonlySet<string> = new Set([".git"]);
