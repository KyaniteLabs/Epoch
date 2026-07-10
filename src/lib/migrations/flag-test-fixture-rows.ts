// ---------------------------------------------------------------------------
// Epoch Migration — Flag Test-Fixture Leakage (loose-ends cleanup)
// ---------------------------------------------------------------------------
//
// Old http-test-harness / feedback-batch-test runs leaked synthetic ids into
// the live ~/.epoch ledger. Verified 2026-07-10 against a read-only copy of
// the live corpus: zero estimates.jsonl rows carry the leaked prefixes — all
// 472 rows are ORPHANED feedback.jsonl actuals (an estimateId with no
// matching estimate on file), under exactly these prefixes:
//   http-test-estimate-, fb-batch-, fb-max-, fb-single- (newly added to
//   exclusion.ts's SYNTHETIC_ID_PREFIXES by this same change), plus
//   batch-test-, batch-max-, batch-single- (already present beforehand).
//
// Orphan feedback rows never join to an estimate in feedback.ts's
// matchEstimatesToActuals() (the join key is estimate id; an orphan actual's
// estimateId matches nothing), so they were already harmless to matched-pair
// math — this migration does not move matchedPairs/seedRecordsFiltered.
// Its purpose is the explicit, auditable overlay flag itself (exclusion.ts's
// "an auditable human/pipeline decision recorded via the shared ledger,
// never inferred" rationale): a durable, timestamped record that these
// specific ids were reviewed and classified as test-fixture leakage,
// appended to estimates.flags.jsonl via the shared appendOverlayRecord —
// never a rewrite of the hot ledger.
//
// Two candidate sources, handled uniformly:
//  - Estimates (live + archived, via loadLedgerWithOverlays()): flagged
//    quarantined:true — this ALSO excludes them from matched-pair math,
//    same as quarantine-backfill.ts's estimates-side flags. (0 candidates
//    on the verified live corpus; kept generic/tested for any future
//    leakage that lands on the estimates side.)
//  - Orphaned feedback rows (ledger.ts's readLines(ACTUALS_FILE) minus any
//    id present among the merged estimates): flagged orphan:true,
//    quarantined:true. Not currently joined by loadLedgerWithOverlays() (no
//    matching ESTIMATES_FILE/QUARANTINE_ARCHIVE_FILE row for these ids) —
//    recorded for audit-trail completeness and forward compatibility.
//
// Thin CLI wrapper: scripts/flag-test-fixture-rows.mjs
// Rollback: delete the appended lines from estimates.flags.jsonl (reason
// "test_fixture"), or restore the printed backupPath over
// estimates.flags.jsonl.

import { loadLedgerWithOverlays, readLines, FLAGS_FILE, ACTUALS_FILE, type OverlayRecord, type ActualRecord } from "../ledger.js";
import { computeCleanPairStats, type CleanPairStats } from "../migration-stats.js";
import { appendOverlay, backupFile, migrationStamp, type MigrationMode } from "./shared.js";

const FLAG_REASON = "test_fixture";
const SAMPLE_LIMIT = 20;

/** Verified 2026-07-10 against a read-only copy of the live ~/.epoch corpus (loose-ends cleanup): id prefixes for leaked test-harness rows. Mirrors dashboard-data.ts's TEST_FIXTURE_ORPHAN_PREFIXES (reporting-only there; this module is the write-path). */
export const TEST_FIXTURE_ID_PREFIXES = [
  "http-test-estimate-",
  "fb-batch-",
  "fb-max-",
  "fb-single-",
  "batch-test-",
  "batch-max-",
  "batch-single-",
] as const;

export function isTestFixtureId(id: string): boolean {
  return TEST_FIXTURE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export interface FlagTestFixtureOptions {
  mode: MigrationMode;
}

export interface EstimateFixtureCandidate {
  id: string;
  tool: string;
  archived: boolean;
}

export interface OrphanFixtureCandidate {
  estimateId: string;
}

export interface FlagTestFixtureReport {
  mode: MigrationMode;
  estimateCandidateCount: number;
  estimateSample: EstimateFixtureCandidate[];
  orphanCandidateCount: number;
  orphanSample: OrphanFixtureCandidate[];
  before: CleanPairStats;
  after: CleanPairStats;
  written: number;
  backupPath: string | null;
}

export function runFlagTestFixtureRows(options: FlagTestFixtureOptions): FlagTestFixtureReport {
  const merged = loadLedgerWithOverlays();
  const before = computeCleanPairStats(merged);

  // ---- Estimate-side candidates (live + archived) ----
  const estimateCandidates: EstimateFixtureCandidate[] = [];
  for (const rec of merged) {
    if (rec.flags.quarantined) continue; // already flagged — idempotent
    if (!isTestFixtureId(rec.id)) continue;
    estimateCandidates.push({ id: rec.id, tool: rec.tool, archived: rec.archived });
  }

  // ---- Orphan feedback-side candidates ----
  const estimateIds = new Set(merged.map((r) => r.id));
  const existingFlagIds = new Set(readLines<OverlayRecord>(FLAGS_FILE).map((r) => r.id));
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const orphanCandidates: OrphanFixtureCandidate[] = [];
  const seenOrphanIds = new Set<string>();
  for (const a of actuals) {
    if (estimateIds.has(a.estimateId)) continue; // matched to a real estimate — not orphaned
    if (!isTestFixtureId(a.estimateId)) continue;
    if (existingFlagIds.has(a.estimateId)) continue; // already flagged — idempotent
    if (seenOrphanIds.has(a.estimateId)) continue; // de-dup repeat actuals sharing one fixture id
    seenOrphanIds.add(a.estimateId);
    orphanCandidates.push({ estimateId: a.estimateId });
  }

  let written = 0;
  let backupPath: string | null = null;

  if (options.mode === "apply" && (estimateCandidates.length > 0 || orphanCandidates.length > 0)) {
    backupPath = backupFile(FLAGS_FILE, migrationStamp());
    for (const c of estimateCandidates) {
      appendOverlay(FLAGS_FILE, { id: c.id, quarantined: true, reason: FLAG_REASON });
      written++;
    }
    for (const c of orphanCandidates) {
      appendOverlay(FLAGS_FILE, { id: c.estimateId, quarantined: true, orphan: true, reason: FLAG_REASON });
      written++;
    }
  }

  const after =
    options.mode === "apply"
      ? computeCleanPairStats(loadLedgerWithOverlays())
      : computeCleanPairStats(merged, new Set(estimateCandidates.map((c) => c.id)));

  return {
    mode: options.mode,
    estimateCandidateCount: estimateCandidates.length,
    estimateSample: estimateCandidates.slice(0, SAMPLE_LIMIT),
    orphanCandidateCount: orphanCandidates.length,
    orphanSample: orphanCandidates.slice(0, SAMPLE_LIMIT),
    before,
    after,
    written,
    backupPath,
  };
}
