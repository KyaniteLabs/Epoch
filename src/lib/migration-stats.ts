// ---------------------------------------------------------------------------
// Epoch Migration Stats — shared before/after diff-report math
// ---------------------------------------------------------------------------
//
// Every Phase 2 migration script (src/lib/migrations/*.ts) and the export
// guarding scripts need the same "clean-pair count + median actual/predicted
// ratio" computation for their dry-run diff reports and to gate acceptance
// (Pre-mortem Scenario 1: quarantine must not shrink the clean-pair floor).
// One function, reused everywhere, rather than reimplemented per script.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 ("each script writes .pre-migration backup + prints diff").

import { loadLedgerWithOverlays, type MergedRecord } from "./ledger.js";
import { isExcluded } from "./exclusion.js";
import { extractEstimatedHours } from "./feedback.js";

export interface CleanPairStats {
  cleanPairCount: number;
  medianActualOverPredicted: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * Compute clean-pair count + median actual/predicted ratio over an already-
 * loaded merged ledger, applying isExcluded() plus an optional extra
 * id-exclusion set. The extra set lets migration scripts simulate a dry-run
 * "after" state (rows that WOULD be newly quarantined/orphaned/archived) —
 * without writing anything or re-reading the ledger.
 */
export function computeCleanPairStats(
  merged: MergedRecord[],
  extraExcludedIds: ReadonlySet<string> = new Set(),
): CleanPairStats {
  const ratios: number[] = [];
  let cleanPairCount = 0;

  for (const rec of merged) {
    if (extraExcludedIds.has(rec.id)) continue;
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
    if (verdict.excluded) continue;

    cleanPairCount++;
    ratios.push(rec.actual.actualHours / estimatedHours);
  }

  return { cleanPairCount, medianActualOverPredicted: median(ratios) };
}

/** Convenience wrapper — loads the merged ledger fresh and computes stats in one call. */
export function loadCleanPairStats(extraExcludedIds?: ReadonlySet<string>): CleanPairStats {
  return computeCleanPairStats(loadLedgerWithOverlays(), extraExcludedIds);
}
