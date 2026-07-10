#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Backtest PERT Learned Correction (Phase 1 Task 0 backtest guard)
// ---------------------------------------------------------------------------
//
// Gates the recommendation to flip EPOCH_PERT_LEARNED_CORRECTION on.
//
// READ-ONLY on the live Epoch data dir (default ~/.epoch, or EPOCH_DATA_DIR):
// copies estimates.jsonl, feedback.jsonl, known overlay sidecars, and the
// reference database to a scratch temp dir, points a *child* EPOCH_DATA_DIR
// at that copy, and never writes back to the source directory.
//
// Joins matched pert_estimate (estimate, actual) pairs through the shared
// exclusion predicate (src/lib/exclusion.ts) and overlay-merge loader
// (src/lib/ledger.ts) — "the clean path" — chronologically splits 80/20,
// trains the learned (tool, task_type) correction factor on the train split
// ONLY (via computeToolTaskCorrectionFactors), and compares current-path vs
// corrected-path MdAPE and median actual/predicted on the held-out test split.
//
// Recency-weighting comparison (Phase 1 accuracy remediation): the plain
// unweighted factor trains on ALL history with equal weight, which fails the
// Tier-1 median-ratio guard because the operator has been getting faster
// over time and the chronological split trains mostly on the older/slower
// era. This script now evaluates the unweighted baseline AGAINST several
// recency-weighted variants (exponential decay at 30/45/90-day half-life;
// hard rolling window at 60/90/180 days with min-n fallback to all-history)
// on the SAME held-out 80/20 split, reports MdAPE + median ratio + both
// guards per variant, picks a winner, and then re-runs every variant on a
// second 70/30 split as an overfitting sanity check (the winner should also
// beat the unweighted baseline there, not just on the split it was picked on).
//
// Usage: npx tsx scripts/backtest-pert-correction.mjs
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 1 Task 0 ("Verification: ... backtest guard").

import { existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const SOURCE_DATA_DIR = process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");

// Every file this script may read — all copied, never mutated, never written
// back to SOURCE_DATA_DIR.
const FILES_TO_COPY = [
  "estimates.jsonl",
  "feedback.jsonl",
  "estimates.flags.jsonl",
  "estimates.labels.jsonl",
  "estimates.quarantine.jsonl",
  "reference-database.json",
];

const TEST_FRACTION = 0.2;
const SANITY_TEST_FRACTION = 0.3;

// Recency-weighting variants under comparison, per Task 1 scope: exponential
// decay at 30/45/90-day half-life, and hard rolling window at 60/90/180 days
// (window falls back to all-history for a cell when the window itself has
// fewer than MIN_RECORDS_PER_FACTOR pairs — see calibration-factors.ts).
const RECENCY_VARIANTS = [
  { label: "unweighted", recency: undefined },
  { label: "exponential_halfLife_30d", recency: { scheme: { kind: "exponential", halfLifeDays: 30 } } },
  { label: "exponential_halfLife_45d", recency: { scheme: { kind: "exponential", halfLifeDays: 45 } } },
  { label: "exponential_halfLife_90d", recency: { scheme: { kind: "exponential", halfLifeDays: 90 } } },
  { label: "window_60d", recency: { scheme: { kind: "window", windowDays: 60 } } },
  { label: "window_90d", recency: { scheme: { kind: "window", windowDays: 90 } } },
  { label: "window_180d", recency: { scheme: { kind: "window", windowDays: 180 } } },
];

function round2(x) {
  return Math.round(x * 100) / 100;
}

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function apeOf(predicted, actual) {
  return (Math.abs(predicted - actual) / actual) * 100;
}

/** Mirrors calibration-factors.ts's extractPertEstimatedHours (pert_estimate output shape). */
function extractPertEstimatedHours(outputs) {
  if (typeof outputs?.["expected"] !== "number") return null;
  const expected = outputs["expected"];
  const unit = outputs["unit"];
  if (typeof unit !== "string") return expected;
  switch (unit) {
    case "hours": return expected;
    case "days": return expected * 8;
    case "weeks": return expected * 40;
    case "months": return expected * 160;
    default: return null; // unrecognized unit — skip to avoid corrupting the backtest
  }
}

async function main() {
  if (!existsSync(SOURCE_DATA_DIR)) {
    console.log(JSON.stringify({ ok: false, reason: "source_data_dir_missing", sourceDataDir: SOURCE_DATA_DIR }, null, 2));
    process.exitCode = 1;
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "epoch-pert-backtest-"));
  let copiedFiles = 0;
  try {
    for (const file of FILES_TO_COPY) {
      const src = join(SOURCE_DATA_DIR, file);
      if (existsSync(src)) {
        copyFileSync(src, join(tempDir, file));
        copiedFiles++;
      }
    }

    // Point ONLY this process's env at the scratch copy. ledger.ts/exclusion.ts/
    // calibration-factors.ts read EPOCH_DATA_DIR lazily at call time, so this
    // is sufficient to keep every downstream read off the live directory.
    process.env["EPOCH_DATA_DIR"] = tempDir;

    const { loadLedgerWithOverlays } = await import("../src/lib/ledger.ts");
    const { isExcluded } = await import("../src/lib/exclusion.ts");
    const { computeToolTaskCorrectionFactors, MIN_RECORDS_PER_FACTOR } = await import("../src/lib/calibration-factors.ts");

    const merged = loadLedgerWithOverlays();
    const pairs = [];

    for (const rec of merged) {
      if (rec.tool !== "pert_estimate") continue;
      if (!rec.actual) continue;
      if (!(rec.actual.actualHours > 0)) continue;

      const estimatedHours = extractPertEstimatedHours(rec.outputs);
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

      const taskType = typeof rec.inputs?.["task_type"] === "string" ? rec.inputs["task_type"] : "feature";
      const complexity = typeof rec.inputs?.["complexity"] === "number" ? rec.inputs["complexity"] : undefined;
      // Current-path prediction = the adjustedEstimate the production handler
      // actually returned at estimate time (stored verbatim in outputs) — not
      // recomputed now, so it reflects whatever developerProfile factor was
      // in effect historically.
      const currentAdjusted = typeof rec.outputs?.["adjustedEstimate"] === "number" ? rec.outputs["adjustedEstimate"] : estimatedHours;
      const completedAt = rec.actual.completedAt ?? rec.actual.reportedAt ?? rec.estimatedAt;

      pairs.push({ id: rec.id, taskType, estimatedHours, actualHours: rec.actual.actualHours, currentAdjusted, completedAt, complexity, tool: rec.tool });
    }

    pairs.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));

    if (pairs.length === 0) {
      console.log(JSON.stringify({ ok: false, reason: "no_matched_pert_pairs", sourceDataDir: SOURCE_DATA_DIR, copiedFiles }, null, 2));
      process.exitCode = 1;
      return;
    }

    function buildSplit(testFraction) {
      const splitIdx = Math.max(1, Math.floor(pairs.length * (1 - testFraction)));
      const trainPairs = pairs.slice(0, splitIdx);
      const testPairs = pairs.slice(splitIdx);
      // asOf = the first held-out pair's completedAt: recency weighting is
      // relative to "the moment we're about to predict the test set", which
      // is what a production call to getPertToolTaskCorrection() approximates
      // by weighting relative to "now".
      const asOf = testPairs[0]?.completedAt;
      return { trainPairs, testPairs, asOf };
    }

    /** Train + evaluate one recency variant on one train/test split. */
    function evaluateVariant(trainPairs, testPairs, asOf, recency) {
      const trainHistorical = trainPairs.map((p) => ({
        taskType: p.taskType,
        estimatedHours: p.estimatedHours,
        actualHours: p.actualHours,
        tool: p.tool,
        ...(p.complexity !== undefined && { complexity: p.complexity }),
        completedAt: p.completedAt,
      }));
      const effectiveRecency = recency ? { ...recency, asOf } : undefined;
      const trainFactors = computeToolTaskCorrectionFactors(trainHistorical, effectiveRecency);
      const trainN = new Map();
      for (const p of trainPairs) trainN.set(p.taskType, (trainN.get(p.taskType) ?? 0) + 1);

      const currentApes = [];
      const correctedApes = [];
      const currentRatios = [];
      const correctedRatios = [];
      let learnedApplied = 0;
      let lowNFallback = 0;

      for (const p of testPairs) {
        currentApes.push(apeOf(p.currentAdjusted, p.actualHours));
        currentRatios.push(p.actualHours / p.currentAdjusted);

        const n = trainN.get(p.taskType) ?? 0;
        const learnedFactor = trainFactors["pert_estimate"]?.[p.taskType];
        let correctedPrediction;
        if (n >= MIN_RECORDS_PER_FACTOR && learnedFactor !== undefined) {
          correctedPrediction = p.estimatedHours * learnedFactor;
          learnedApplied++;
        } else {
          // Low-n fallback per the composition rule: keep current behavior.
          correctedPrediction = p.currentAdjusted;
          lowNFallback++;
        }
        correctedApes.push(apeOf(correctedPrediction, p.actualHours));
        correctedRatios.push(p.actualHours / correctedPrediction);
      }

      const currentMdape = median(currentApes);
      const correctedMdape = median(correctedApes);
      const currentMedianRatio = median(currentRatios);
      const correctedMedianRatio = median(correctedRatios);
      const guardMdapeImproves = correctedMdape <= currentMdape;
      const guardTier1Band = correctedMedianRatio >= 0.7 && correctedMedianRatio <= 1.3;

      return {
        testSetComposition: { learnedFactorApplied: learnedApplied, lowNFallback },
        current: { mdapePercent: round2(currentMdape), medianActualOverPredicted: round2(currentMedianRatio) },
        corrected: { mdapePercent: round2(correctedMdape), medianActualOverPredicted: round2(correctedMedianRatio) },
        guards: {
          correctedMdapeLeCurrentMdape: guardMdapeImproves,
          tier1MedianRatioInBand_0_7_to_1_3: guardTier1Band,
          bothPass: guardMdapeImproves && guardTier1Band,
        },
      };
    }

    function runAllVariants(trainPairs, testPairs, asOf) {
      return RECENCY_VARIANTS.map(({ label, recency }) => ({
        label,
        ...evaluateVariant(trainPairs, testPairs, asOf, recency),
      }));
    }

    // ---- Primary chronological 80/20 split: compare every variant --------
    const primary = buildSplit(TEST_FRACTION);
    if (primary.testPairs.length === 0) {
      console.log(JSON.stringify({ ok: false, reason: "insufficient_pairs_for_holdout_split", totalMatchedPairs: pairs.length, sourceDataDir: SOURCE_DATA_DIR, copiedFiles }, null, 2));
      process.exitCode = 1;
      return;
    }
    const primaryResults = runAllVariants(primary.trainPairs, primary.testPairs, primary.asOf);

    // Transparency leaderboard: every variant (including unweighted) ranked
    // by corrected MdAPE, so a HOLD verdict still shows how close (or far)
    // each recency scheme came, rather than only reporting a bare null.
    const leaderboard = [...primaryResults]
      .sort((a, b) => a.corrected.mdapePercent - b.corrected.mdapePercent)
      .map((r) => ({ label: r.label, mdapePercent: r.corrected.mdapePercent, medianActualOverPredicted: r.corrected.medianActualOverPredicted, bothGuardsPass: r.guards.bothPass }));

    // Winner = best (lowest) corrected MdAPE among non-baseline variants that
    // pass BOTH guards on the primary split. Ties broken by array order
    // (simplest scheme first: shortest half-life, then shortest window).
    const primaryContenders = primaryResults.filter((r) => r.label !== "unweighted" && r.guards.bothPass);
    const winner = primaryContenders.length > 0
      ? primaryContenders.reduce((best, r) => (r.corrected.mdapePercent < best.corrected.mdapePercent ? r : best))
      : null;

    // ---- Overfitting sanity check: second 70/30 split ---------------------
    // The winner (picked on the 80/20 split) must also beat the unweighted
    // baseline on an independently-drawn split, not just the one it was
    // selected on.
    const sanity = buildSplit(SANITY_TEST_FRACTION);
    let sanityResults = null;
    let sanityCheck = null;
    if (winner && sanity.testPairs.length > 0) {
      sanityResults = runAllVariants(sanity.trainPairs, sanity.testPairs, sanity.asOf);
      const sanityUnweighted = sanityResults.find((r) => r.label === "unweighted");
      const sanityWinner = sanityResults.find((r) => r.label === winner.label);
      sanityCheck = {
        split: "70/30",
        winnerLabel: winner.label,
        winnerBeatsUnweightedMdape: sanityWinner.corrected.mdapePercent <= sanityUnweighted.corrected.mdapePercent,
        winnerBothGuardsPass: sanityWinner.guards.bothPass,
        unweighted: sanityUnweighted,
        winner: sanityWinner,
      };
    }

    const recommendedForFlip = winner !== null && (sanityCheck === null || (sanityCheck.winnerBeatsUnweightedMdape && sanityCheck.winnerBothGuardsPass));

    const report = {
      ok: true,
      sourceDataDir: SOURCE_DATA_DIR,
      copiedFiles,
      totalMatchedPairs: pairs.length,
      primarySplit: {
        fraction: "80/20",
        trainPairs: primary.trainPairs.length,
        testPairs: primary.testPairs.length,
        asOf: primary.asOf,
        variants: primaryResults,
        leaderboardByMdape: leaderboard,
      },
      winner: winner ? { label: winner.label, corrected: winner.corrected, guards: winner.guards } : null,
      overfittingSanityCheck: sanityCheck,
      recommendation: recommendedForFlip
        ? `PASS — recency-weighted variant "${winner.label}" clears both guards on the 80/20 split and beats the unweighted baseline on the independent 70/30 split; safe to wire as the default and consider flipping EPOCH_PERT_LEARNED_CORRECTION on.`
        : winner
          ? `HOLD — variant "${winner.label}" passed both guards on the 80/20 split but failed the overfitting sanity check on the 70/30 split; do not flip EPOCH_PERT_LEARNED_CORRECTION on yet.`
          : "HOLD — no recency-weighted variant cleared both guards on the primary split; do not flip EPOCH_PERT_LEARNED_CORRECTION on yet.",
    };

    console.log(JSON.stringify(report, null, 2));
    process.exitCode = recommendedForFlip ? 0 : 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
