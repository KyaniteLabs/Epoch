# 18 — Ledger write integrity (no phantom tokens, no silent loss, no double-joins)

**What to build:** Write-side honesty: ledger write failures propagate to the caller (no feedbackRef issued for a record that never persisted); torn/corrupt lines counted and surfaced (corruptLines in data_status) instead of silently dropped; read-side join deterministic (earliest-reported actual wins) with a duplicateActuals counter; advisory write lock with exclusive-create + PID/staleness detection and a documented recovery path surfaced via data_status; migrations take the lock, fsync, and re-merge tail growth before rename (concurrent appends survive); repair-orphaned tracks claimed targets so two orphans can't relink to one estimate.

**Blocked by:** 17 (cache invalidation interacts with locking).

**Status:** ready-for-agent

- [ ] Append failure (EACCES fixture) → tool error, no feedbackRef in response
- [ ] Torn-last-line fixture → corruptLines counter increments and is visible in data_status
- [ ] Sandbox: 2 processes × record_actual same estimate → exactly one joined pair + duplicateActuals counter
- [ ] Sandbox: append during migration rewrite → appended row survives (tail merge); fsync on migration writes
- [ ] Stale-lock fixture → detected, surfaced, documented removal step works
- [ ] Two-orphan repair case → second relink refused (multiple_candidates)
