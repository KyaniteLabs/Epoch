// ---------------------------------------------------------------------------
// Epoch Benchmark Export Guarding (Phase 2 Task 5)
// ---------------------------------------------------------------------------
//
// Shared, testable logic routing the community/public benchmark export
// pipeline (scripts/export-public-benchmark.mjs,
// scripts/validate-community-data.mjs, scripts/validate-public-benchmark.mjs)
// through the shared exclusion predicate (isExcluded) and overlay-merge
// loader (loadLedgerWithOverlays), per Pre-mortem Scenario 5: contaminated/
// quarantined rows must never leak into the PUBLIC benchmark.
//
// Two guards:
//  1. loadLocalBenchmarkPairs() — the operator's own live ~/.epoch ledger,
//     joined + exclusion-filtered through the full shared predicate (has
//     complete id/flags/date context).
//  2. isBackfillSignaturePair() — a defense-in-depth reuse of isExcluded()'s
//     "backfill_signature" rule (exact-match epsilon AND the 2026-05-05 date
//     signature, both required — Pre-mortem Scenario 1) for pair sources
//     (community-contributed JSON, cocomo calibration data) that carry a
//     ratio + optional date but no full ExclusionRecord (no id/flags). Reuses
//     the SAME constants from exclusion.ts rather than a reimplemented
//     threshold.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 5, Pre-mortem Scenario 5.

import { loadLedgerWithOverlays } from "./ledger.js";
import { isExcluded, EXACT_MATCH_EPSILON, BACKFILL_SIGNATURE_DATE } from "./exclusion.js";
import { extractEstimatedHours } from "./feedback.js";
import { canonicalizeToolName } from "./tool-aliases.js";

export interface BenchmarkPair {
  task_type: string;
  complexity: number | null;
  tool: string;
  estimated_hours: number;
  actual_hours: number;
  ratio: number;
  date?: string;
  source: "local";
}

export interface LocalBenchmarkResult {
  pairs: BenchmarkPair[];
  includedIds: string[];
  excludedCount: number;
}

/**
 * Load the operator's own live ledger as exclusion-filtered, anonymized
 * benchmark pairs — the single sanctioned path for export-public-benchmark
 * .mjs's local contribution, and for validate-public-benchmark.mjs's
 * re-verification that no quarantined/orphan row is present.
 */
export function loadLocalBenchmarkPairs(): LocalBenchmarkResult {
  const merged = loadLedgerWithOverlays();
  const pairs: BenchmarkPair[] = [];
  const includedIds: string[] = [];
  let excludedCount = 0;

  for (const rec of merged) {
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
    if (verdict.excluded) {
      excludedCount++;
      continue;
    }

    const taskType = typeof rec.inputs["task_type"] === "string" ? (rec.inputs["task_type"] as string) : "feature";
    const complexity = typeof rec.inputs["complexity"] === "number" ? (rec.inputs["complexity"] as number) : null;
    const tool = canonicalizeToolName(rec.tool) ?? rec.tool;
    const completedAt = rec.actual.completedAt ?? rec.actual.reportedAt;

    pairs.push({
      task_type: taskType,
      complexity,
      tool,
      estimated_hours: Math.round(estimatedHours * 100) / 100,
      actual_hours: Math.round(rec.actual.actualHours * 100) / 100,
      ratio: Math.round((rec.actual.actualHours / estimatedHours) * 10000) / 10000,
      ...(completedAt && { date: completedAt.slice(0, 10) }),
      source: "local",
    });
    includedIds.push(rec.id);
  }

  return { pairs, includedIds, excludedCount };
}

/**
 * Defense-in-depth check for pair sources that lack full ExclusionRecord
 * context (community-contributed / cocomo data has only a ratio + optional
 * date, no id/overlay-flags). Mirrors isExcluded()'s "backfill_signature"
 * rule using the same constants — not a reimplemented threshold.
 */
export function isBackfillSignaturePair(ratio: number, dateIso: string | undefined | null): boolean {
  if (!dateIso) return false;
  const day = dateIso.slice(0, 10);
  if (day !== BACKFILL_SIGNATURE_DATE) return false;
  return Math.abs(ratio - 1) <= EXACT_MATCH_EPSILON;
}
