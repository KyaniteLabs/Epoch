// ---------------------------------------------------------------------------
// Epoch Migration — Quarantine the 2026-05-05 exact-match backfill (Phase 2 Task 1)
// ---------------------------------------------------------------------------
//
// Identifies rows failing isExcluded()'s "backfill_signature" rule — exact-
// match ratio epsilon AND the 2026-05-05 calendar-date signature, BOTH
// required (Pre-mortem Scenario 1: ratio-alone over-matches legitimate
// low-variance pairs). In apply mode, appends overlay flag records
// {id, quarantined:true, reason, ...} to estimates.flags.jsonl via the
// shared loader's appendOverlayRecord — NEVER rewrites estimates.jsonl.
//
// Thin CLI wrapper: scripts/quarantine-backfill-2026-05-05.mjs
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 1.
//
// Rollback: delete the appended lines from estimates.flags.jsonl (they are
// the last N lines with reason "backfill_signature_2026-05-05"), or restore
// the printed backupPath over estimates.flags.jsonl.

import { loadLedgerWithOverlays, FLAGS_FILE } from "../ledger.js";
import { isExcluded } from "../exclusion.js";
import { extractEstimatedHours } from "../feedback.js";
import { computeCleanPairStats, type CleanPairStats } from "../migration-stats.js";
import { appendOverlay, backupFile, migrationStamp, type MigrationMode } from "./shared.js";

const QUARANTINE_REASON = "backfill_signature_2026-05-05";

export interface QuarantineCandidate {
  id: string;
  tool: string;
  estimatedHours: number;
  actualHours: number;
  estimatedAt: string;
}

export interface QuarantineOptions {
  mode: MigrationMode;
}

export interface QuarantineReport {
  mode: MigrationMode;
  candidateCount: number;
  sample: QuarantineCandidate[];
  before: CleanPairStats;
  after: CleanPairStats;
  written: number;
  backupPath: string | null;
}

const SAMPLE_LIMIT = 20;

export function runQuarantineBackfill(options: QuarantineOptions): QuarantineReport {
  const merged = loadLedgerWithOverlays();
  const before = computeCleanPairStats(merged);

  const candidates: QuarantineCandidate[] = [];
  for (const rec of merged) {
    // Already-quarantined rows are not new candidates — this script only
    // reports/flags rows not yet covered.
    if (rec.flags.quarantined) continue;
    if (!rec.actual) continue;
    if (!(rec.actual.actualHours > 0)) continue;

    const estimatedHours = extractEstimatedHours(rec.outputs);
    if (estimatedHours === null || !(estimatedHours > 0)) continue;

    const verdict = isExcluded({
      id: rec.id,
      tool: rec.tool,
      inputs: rec.inputs,
      estimatedAt: rec.estimatedAt,
      estimatedHours,
      actual: {
        actualHours: rec.actual.actualHours,
        notes: rec.actual.notes,
        reportedAt: rec.actual.reportedAt,
        completedAt: rec.actual.completedAt,
      },
      flags: { quarantined: rec.flags.quarantined, orphan: rec.flags.orphan },
      ...(rec.expiresAt && { expiresAt: rec.expiresAt }),
    });

    if (verdict.excluded && verdict.reason === "backfill_signature") {
      candidates.push({ id: rec.id, tool: rec.tool, estimatedHours, actualHours: rec.actual.actualHours, estimatedAt: rec.estimatedAt });
    }
  }

  let written = 0;
  let backupPath: string | null = null;

  if (options.mode === "apply" && candidates.length > 0) {
    backupPath = backupFile(FLAGS_FILE, migrationStamp());
    for (const c of candidates) {
      appendOverlay(FLAGS_FILE, { id: c.id, quarantined: true, reason: QUARANTINE_REASON });
      written++;
    }
  }

  const after =
    options.mode === "apply"
      ? computeCleanPairStats(loadLedgerWithOverlays())
      : computeCleanPairStats(merged, new Set(candidates.map((c) => c.id)));

  return {
    mode: options.mode,
    candidateCount: candidates.length,
    sample: candidates.slice(0, SAMPLE_LIMIT),
    before,
    after,
    written,
    backupPath,
  };
}
