# 04 — Restore the feedback contract (estimate_from_context + full error vocabulary)

**What to build:** `estimate_from_context` estimates can receive actuals again: the missing tool joins the authoritative set (03), and every `record_actual` failure reason — below_threshold, duplicate, write_failed, synthetic_id, unknown_tool, auto_wallclock_out_of_bounds — maps to a distinct actionable message (batch errors carry per-entry reasons). End-to-end matrix: every estimation tool's `feedbackRef` → `record_actual` succeeds.

**Blocked by:** 03 (same PR).

**Status:** ready-for-agent

- [ ] `record_actual` against an `estimate_from_context` feedbackRef returns ok
- [ ] Dispatcher-level test injects each of the six failure reasons and asserts six distinct, actionable messages (no "Unknown error." fallback reachable)
- [ ] Batch path reports per-entry reason strings
- [ ] Contract matrix test: all 9 estimation tools' feedbackRefs accepted by record_actual
