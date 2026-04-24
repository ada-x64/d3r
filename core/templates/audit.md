---
repo: <owner/repo>
created: <ISO Date>
---

# Audit: <label>

## Executive summary

<3-5 sentences. Overall health assessment, most critical findings, recommended priorities.

| Severity | Count |
| -------- | ----- |
| critical | N     |
| high     | N     |
| medium   | N     |
| low      | N     |
| info     | N     |

## Scope

**Audited:** `<path or "full repository">`
**Excluded:** `<explicit exclusions or "none">`
**Commit:** `<git SHA>` on `<branch>`
**Date:** YYYY-MM-DD

## Analysis

### Security

<Synthesised findings. Reference specific tool output where applicable.>

### Testing

<trivial-test smell,
missing test categories, test-to-code churn correlation.>

### Architecture

<Structural concerns, coupling, cohesion, dependency health.>

### Performance

<Algorithmic concerns, unnecessary allocations, blocking calls.>

### Maintenance

<Code smells, duplication, dead code, documentation gaps, over-specified tests.>

## Severity summary

| Severity  | Security | Testing | Architecture | Performance | Maintenance | Total |
| --------- | -------- | ------- | ------------ | ----------- | ----------- | ----- |
| critical  | N        | N       | N            | N           | N           | N     |
| high      | N        | N       | N            | N           | N           | N     |
| medium    | N        | N       | N            | N           | N           | N     |
| low       | N        | N       | N            | N           | N           | N     |
| info      | N        | N       | N            | N           | N           | N     |
| **Total** | N        | N       | N            | N           | N           | **N** |

---

## Reference: severity levels

Audit severity uses **roadmap-priority semantics** - not merge-gate semantics. An audit finding does not block a PR; it informs an engineering roadmap.

| Severity     | Audit meaning                                                                              |
| ------------ | ------------------------------------------------------------------------------------------ |
| **critical** | Active exploit, data loss risk, or regulatory violation. Fix immediately.                  |
| **high**     | Significant vulnerability or quality failure; address within the current sprint.           |
| **medium**   | Noteworthy pattern; address within the quarter.                                            |
| **low**      | Minor quality issue or best-practice gap; worth tracking, not urgent.                      |
| **info**     | Neutral observation with no negative valence (e.g. "test coverage is 80% in this module"). |

Note: `info` is specific to the audit severity model and has no counterpart in the review (`nit/low/medium/high/critical`) format.

---

<!--
Frontmatter notes:
- `repo` is the audited repository (`<owner/repo>`). Audits can
  run independently of the Develop loop, so the repo handle lives
  in frontmatter rather than being inferred from path context.
- `created` is the ISO date the audit was run.

Shape reference: notes/template-shapes/audit.md section 4.
-->
