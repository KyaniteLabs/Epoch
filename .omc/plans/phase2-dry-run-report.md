# Phase 2 Migration Scripts — Dry-Run Evidence Report

**Date:** 2026-07-10
**Worker:** worker-migrations (tracker task #6)
**Mode:** All scripts run in `EPOCH_DRY_RUN`-safe dry-run mode ONLY, against a temp COPY of `~/.epoch`. **`~/.epoch` was never written to.** See §7 for hash verification.

Source data snapshot (copy-time): `estimates.jsonl` 18,863 rows, `feedback.jsonl` 2,270 rows, plus `reference-database.json` and `cocomo-calibration-data.json` for completeness (unused by these scripts, copied for parity with `backtest-pert-correction.mjs`'s file list).

Commands used (representative — see each section for exact invocation):

```
EPOCH_DATA_DIR=<temp-copy> npx tsx scripts/<name>.mjs [flags]
```

No script was ever invoked with `--apply`, except the one negative test in §6 which intentionally verifies the `archive-quarantined.mjs` safety guard refuses to run.

---

## 1. `quarantine-backfill-2026-05-05.mjs`

**Candidate count: 234** — matches the plan's expected ~234 exactly.

| Metric | Value |
|---|---|
| Rows that would be flagged | **234** |
| Before — clean-pair count | 1,433 |
| Before — median actual/predicted | 0.6875 |
| After (simulated) — clean-pair count | 1,433 |
| After (simulated) — median actual/predicted | 0.6875 |
| Would write | 0 (dry-run) |

**Why before/after clean-pair count is unchanged:** `isExcluded()` already excludes these 234 rows from all calibration math via the `backfill_signature` reason (exact-match ratio epsilon AND the 2026-05-05 date signature — Pre-mortem Scenario 1's mitigation, already effective without any overlay flag). Quarantining does not change *which* rows are excluded from computed statistics — it makes an already-implicit exclusion **explicit and auditable** via `estimates.flags.jsonl`, and is a prerequisite for `archive-quarantined.mjs` (which only acts on rows carrying an explicit `flags.quarantined` overlay).

Sample of flagged row ids (first 5 of 234):
```
f943d224-a015-45e2-a01d-83a6764267c4
e5b2bc68-ca89-4a8a-a40b-1b0ab71cf32e
ec8d872b-1516-43aa-9d5e-5a03631c53c8
422caec8-a90e-439d-82f6-24be369e6c8f
675dcb6c-0cdb-42e2-9a34-3a93772a0815
```

**Anomalies:** none. All 234 candidates share the exact-match (ratio ≈ 1.0, epsilon 0.005) + `2026-05-05` date signature, consistent with the known backfill batch.

---

## 2. `repair-orphaned-actuals.mjs`

| Metric | Value (default 24h window) |
|---|---|
| Total orphaned actuals | **485** |
| Relinked (exactly-one-candidate) | **0** |
| Unresolved — `zero_candidates` | 0 |
| Unresolved — `multiple_candidates` | **485** |
| Would write | 0 (dry-run) |

**Finding — the default 24h window is too wide for this corpus's density.** With ~18.8k estimates spanning roughly two months, the window routinely contains dozens of pending estimates, so the "exactly one candidate" collision policy correctly refuses to guess on all 485 orphans at the default window. This is the **safe, intended behavior** (Pre-mortem: "zero or >1 candidates ⇒ leave orphaned, never guess") — not a bug.

Diagnostic sweep at narrower windows (informational only, not applied):

| `--window-hours` | Relinked | Unresolved (multiple) | Unresolved (zero) |
|---|---|---|---|
| 24 (default) | 0 | 485 | 0 |
| 1 | 0 | 485 | 0 |
| 0.1 (6 min) | 3 | 356 | 126 |
| 0.01 (36 sec) | 5 | 347 | 133 |

**Additional finding — most orphans are test-run leakage, not real orphaned work.** Of the 485 orphaned `estimateId` values, 472 carry recognizable test-fixture prefixes that were written to the live `~/.epoch` directory by test suites at some point (not real user-recorded actuals):

| Prefix | Count |
|---|---|
| `http-test-estimate-` | 192 |
| `fb-batch-` | 114 |
| `fb-max-` | 114 |
| `fb-single-` | 38 |
| `batch-test-` | 6 |
| `batch-max-` | 6 |
| `batch-single-` | 2 |
| **Total test-prefixed** | **472** |
| Other (UUID-shaped / manual / pending labels) | 13 |

`batch-test-`, `batch-max-`, `batch-single-` (14 rows) are already covered by `isSyntheticId()`'s `SYNTHETIC_ID_PREFIXES` (Phase 1) for other exclusion purposes, but `http-test-estimate-`, `fb-batch-`, `fb-max-`, `fb-single-` (458 rows) are **not** in that prefix list — they are not currently excluded from `feedback.jsonl`'s orphan count by any Phase 1 guard. This is flagged for Simon's awareness; it is out of this task's assigned scope (Phase 1's exclusion list is already merged), but is the dominant reason the orphan-repair candidate pool is mostly noise. Recommend either extending `SYNTHETIC_ID_PREFIXES` or hardening the test suites that leak these into `~/.epoch` in a future task.

**Anomalies:** none in the repair logic itself — the 0-relink outcome at the plan-specified default window is the correct, conservative result given the corpus's actual density and the dominance of test-leakage rows in the orphan pool.

---

## 3. `retro-label-estimates.mjs`

| Metric | Value |
|---|---|
| Candidate estimates (clean pair + notes present) | **1,423** |
| Would write | 0 (dry-run) |

1,423 of the 1,433 clean matched pairs (99.3%) carry usable notes and would receive a `task_label` overlay. Sample:

```
e7774914-b4c4-46ad-afff-47ac4b66e865 → "Initial project scaffolding: TypeScript toolchain"
bcb12830-83f2-430c-b630-cbd302b95ac7 → "Core type definitions and Zod schemas for all 5 layers"
c71b18fb-ce6e-4567-a6e8-94e1a329e710 → "Temporal and calendar utilities Layers 1-2"
01b22667-43ea-4b30-bf84-145fe05f596a → "Estimation and analytics algorithms Layers 3-5"
a3c65da7-d910-4f3c-827c-f2c100fa7556 → "MCP tool registration wiring and server entry point"
```

**Anomalies:** none. The gap between 1,433 clean pairs and 1,423 labeled candidates (10 rows) is rows with no `notes` field, correctly skipped rather than guessed.

---

## 4. `normalize-task-types.mjs`

| Metric | Value |
|---|---|
| Candidate rows (non-canonical `task_type`) | **8** |
| Distinct raw values | **7** |
| Would write | 0 (dry-run) |

| taskTypeRaw | taskTypeNormalized |
|---|---|
| `implementation` | feature |
| `writing` (×2) | documentation |
| `writing_system` | documentation |
| `pricing_strategy` | feature |
| `revenue_copy` | documentation |
| `website_offer_surface` | feature |
| `resume-job-search-takeover-packet` | documentation |

This matches the plan's own examples almost verbatim. **Anomalies:** none — small, fully-enumerable candidate set; every mapping was manually reviewed for reasonableness.

---

## 5. `archive-quarantined.mjs`

| Metric | Value |
|---|---|
| Archived (dry-run) | **0** |
| before/after hot+archive total | 18,863 / 18,863 (conserved) |

**Expected zero, not an anomaly.** This dry-run chain never applied `quarantine-backfill-2026-05-05.mjs` (per the hard safety rule — dry-run only, no writes to the copy either), so no row in the copy carries an explicit `flags.quarantined` overlay yet. `archive-quarantined.mjs` only acts on rows with that explicit flag (by design — see script header). In a real apply sequence, this script runs *after* `quarantine-backfill-2026-05-05.mjs --apply` and an audit window has elapsed; at that point it would move the (eventually-flagged) 234 rows to `estimates.quarantine.jsonl`, conserving `count(hot) + count(archive)`.

---

## 6. Safety-guard verification

`archive-quarantined.mjs --apply` (no `--audit-window-confirmed`) against the same temp copy:

```
[archive-quarantined] mode=apply auditWindowConfirmed=false dataDir=<temp-copy>
[archive-quarantined] archive-quarantined requires --audit-window-confirmed for apply mode;
refusing to run without explicit confirmation the audit window has elapsed.
exit=1
```

No file was created or modified by this run (verified: no `.pre-migration-*`, `.tmp-*`, or `.epoch-migration.lock` artifacts appeared in the temp copy afterward).

---

## 7. `~/.epoch` integrity verification

Hash taken immediately before copying, and again after all dry-run script invocations completed:

| File | Pre-work hash (copy-time) | Post-work state |
|---|---|---|
| `estimates.jsonl` | `d267539c3c2112719e2637fe22ebcb3017eab318fa5302e6fffd706c54e92466` (18,863 lines) | Live file grew to 18,865 lines (legitimate concurrent background usage during this session) — **the first 18,863 lines are byte-identical to the pre-work snapshot**, confirmed via `cmp` (EOF-only diff) and re-hashing the truncated prefix (`d267539c3c2112719e2637fe22ebcb3017eab318fa5302e6fffd706c54e92466` — matches exactly) |
| `feedback.jsonl` | `00672e5bede16fc0ba578eda5d47af3ed3b3be408db75c6cdd0b140bee55572d` (2,270 lines) | **Identical** — `00672e5bede16fc0ba578eda5d47af3ed3b3be408db75c6cdd0b140bee55572d`, 2,270 lines, unchanged |

No new sidecar/overlay files (`estimates.flags.jsonl`, `estimates.labels.jsonl`, `estimates.quarantine.jsonl`, `estimates.tasktype.jsonl`), lock files (`.epoch-migration.lock`), or backup markers (`*.pre-migration-*`) appeared anywhere under `~/.epoch`. **All migration-script activity in this task ran exclusively against a temp copy under the scratchpad directory; `~/.epoch` remains exactly as it was, modulo legitimate append-only growth from unrelated concurrent Epoch usage during the session.**

---

## 8. Cross-reference — PERT learned-correction backtest (existing Phase 1 script, re-run for context)

`npx tsx scripts/backtest-pert-correction.mjs` against the same temp copy:

```json
{
  "totalMatchedPairs": 683,
  "current": { "mdapePercent": 94.55, "medianActualOverPredicted": 0.51 },
  "corrected": { "mdapePercent": 78.98, "medianActualOverPredicted": 0.56 },
  "guards": { "correctedMdapeLeCurrentMdape": true, "tier1MedianRatioInBand_0_7_to_1_3": false },
  "recommendation": "HOLD — do not flip EPOCH_PERT_LEARNED_CORRECTION on yet; guard(s) failed."
}
```

Consistent with the team-exec handoff's earlier finding (MdAPE 91.42%→77.28%, grown slightly as the live corpus has grown). The Tier-1 median-ratio band guard still fails, corroborating the plan's own prediction that Phase 2's retro-labeling (§3) is a prerequisite for the PERT flag to safely flip on — this dry-run's retro-label candidate count (1,423) directly addresses that gap once applied.

---

## 9. Export-guarding verification (Phase 2 Task 5)

`export-public-benchmark.mjs` run against the temp copy (output discarded/reverted — never committed):

```
READ local ledger (<temp-copy>): 1433 clean pairs, 292 excluded by isExcluded()
Benchmark exported: 1433 records, 0 contributors
  feature: 1149 records, median ratio 0.7353
  infrastructure: 71 records, median ratio 0.7143
  testing: 59 records, median ratio 0.5
  bugfix: 58 records, median ratio 0.5
  documentation: 39 records, median ratio 0.5
  refactor: 35 records, median ratio 0.4167
  design: 20 records, median ratio 0.5875
  migration: 2 records, median ratio 1.1443
```

`validate-public-benchmark.mjs` against the resulting file: **all checks PASS**, including the new `_quality` block and the live re-verification that re-runs `isExcluded()` against the current ledger state and confirms the export never included more clean pairs than currently verifiable (no quarantined/orphan row leaked through). A dedicated fixture test (`src/lib/benchmark-export.test.ts`) proves a known contaminated (backfill-signature) row is excluded from `loadLocalBenchmarkPairs()`'s output.

---

## Summary for the human gate

| Script | Would touch | Risk assessment |
|---|---|---|
| `quarantine-backfill-2026-05-05.mjs` | 234 overlay flag rows (append-only) | Low — matches expected count exactly; makes an already-effective exclusion explicit |
| `repair-orphaned-actuals.mjs` | 0 relinks at default window (485 correctly left unresolved) | None at default settings — conservative by design; separately flags a pre-existing test-leakage data-hygiene issue (472/485 orphans) for future cleanup |
| `retro-label-estimates.mjs` | 1,423 overlay label rows (append-only) | Low — additive metadata only |
| `normalize-task-types.mjs` | 8 overlay rows (append-only) | Low — tiny, fully-reviewed candidate set |
| `archive-quarantined.mjs` | 0 at this stage (nothing flagged yet); guarded by required `--audit-window-confirmed` | None until quarantine is applied and the audit window elapses |

All five scripts are dry-run-safe, idempotent (verified via vitest), and never touched `~/.epoch` during this evidence-gathering pass (§7).
