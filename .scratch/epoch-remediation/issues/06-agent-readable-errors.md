# 06 — Agent-readable errors (validation formatting + 500/422 split)

**What to build:** Validation failures return short actionable sentences (`path: message` lines) instead of raw zod JSON blobs, and internal errors become distinguishable from validation errors at the HTTP boundary (500-class vs 422). The canary's `zero-tokens` failure-mode case — currently failing against v0.4.0 — becomes the regression guard.

**Blocked by:** 04 (error vocabulary lands first; same file territory).

**Status:** ready-for-agent

- [ ] Invalid numeric input message matches `/must be|greater|positive/i`; no raw JSON-issues blob in any error message
- [ ] Internal (500-class) and validation (422) errors distinguishable at the HTTP seam
- [ ] Canary failure-mode suite 11/11 incl. `zero-tokens` (serve + `--local-only` run documented in CI)
- [ ] All existing 1421 tests remain green (justified updates only)
