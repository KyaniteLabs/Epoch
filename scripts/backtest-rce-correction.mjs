#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — reference_class_estimate calibration measurement + recency backtest
// (wave-2 recency-weighting validation for reference_class, per the
// feat/wave2-accuracy brief: "test it there")
// ---------------------------------------------------------------------------
//
// READ-ONLY on the live Epoch data dir (default ~/.epoch, or EPOCH_DATA_DIR):
// copies estimates.jsonl, feedback.jsonl, known overlay sidecars, and the
// reference database to a scratch temp dir, points a *child* EPOCH_DATA_DIR
// at that copy, and never writes back to the source directory.
//
// Mirrors scripts/backtest-pert-correction.mjs exactly (same clean path, same
// variant grid, same chronological 80/20 + 70/30 sanity splits, same winner
// rule), but for the reference_class_estimate tool:
//  - pre-correction basis = outputs.rawEstimate (analog of PERT's `expected`)
//  - current-path prediction = outputs.correctedEstimate (what production
//    returned at estimate time, verbatim from the ledger)
//  - corrected-path prediction = rawEstimate * learned (tool, task_type) factor
//    trained on the train split only (low-n fallback = current path)
//
// Sections:
//  1. baseline            — reproduce the live-ledger median actual/predicted
//                           measurement family (issue #42 regression report)
//  2. feedbackHealth      — feedback_health byTool/overall trend on the copy
//  3. recencyBacktest     — the wave-2 recency-weighting comparison (decisive
//                           time-drift test) on chronological held-out splits
//  4. postChange          — winner scheme trained on full history and applied
//                           to the live ledger (in-sample recompute, labeled)
//
// Usage: npx tsx scripts/backtest-rce-correction.mjs

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

const RCE_TOOL = "reference_class_estimate";
const TEST_FRACTION = 0.2;
const SANITY_TEST_FRACTION = 0.3;

// Task band for this remediation (issue #42 acceptance): median actual/predicted
// in [0.8, 1.2]. PERT's Tier-1 guard ([0.7, 1.3]) is reported alongside for
// comparability with scripts/backtest-pert-correction.mjs.
const BAND_LO = 0.8;
const BAND_HI = 1.2;
const TIER1_LO = 0.7;
const TIER1_HI = 1.3;

// Recency-weighting variants under comparison — identical grid to
// scripts/backtest-pert-correction.mjs (the wave-2 brief's grid).
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

function round3(x) {
  return Math.round(x * 1000) / 1000;
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

/** Median actual/predicted ratio over (predicted, actual) rows. */
function medianRatio(rows) {
  return median(rows.filter((r) => r.predicted > 0 && r.actual > 0).map((r) => r.actual / r.predicted));
}

function byMonthTable(pairs) {
  const byMonth = new Map();
  for (const p of pairs) {
    const m = (p.completedAt ?? "").slice(0, 7) || "unknown";
    const arr = byMonth.get(m) ?? [];
    arr.push(p.actualHours / p.currentAdjusted);
    byMonth.set(m, arr);
  }
  const out = {};
  for (const [m, ratios] of [...byMonth].sort()) {
    out[m] = { n: ratios.length, medianActualOverPredicted: round3(median(ratios)) };
  }
  return out;
}

async function main() {
  if (!existsSync(SOURCE_DATA_DIR)) {
    console.log(JSON.stringify({ ok: false, reason: "source_data_dir_missing", sourceDataDir: SOURCE_DATA_DIR }, null, 2));
    process.exitCode = 1;
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "epoch-rce-backtest-"));
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
    // calibration-factors.ts read EPOCH_DATA_DIR lazily at call time.
    process.env["EPOCH_DATA_DIR"] = tempDir;

    const { loadLedgerWithOverlays } = await import("../src/lib/ledger.ts");
    const { isExcluded } = await import("../src/lib/exclusion.ts");
    const { computeToolTaskCorrectionFactors, MIN_RECORDS_PER_FACTOR } = await import("../src/lib/calibration-factors.ts");
    const { getFeedbackHealthReport } = await import("../src/lib/feedback-health.ts");

    const merged = loadLedgerWithOverlays();
    const pairs = [];
    let excludedCount = 0;

    for (const rec of merged) {
      if (rec.tool !== RCE_TOOL) continue;
      if (!rec.actual) continue;
      if (!(rec.actual.actualHours > 0)) continue;

      // Pre-correction basis: rawEstimate (fallback correctedEstimate for rows
      // that predate the rawEstimate field).
      const rawEstimate = typeof rec.outputs?.["rawEstimate"] === "number" ? rec.outputs["rawEstimate"]
        : typeof rec.outputs?.["correctedEstimate"] === "number" ? rec.outputs["correctedEstimate"]
        : null;
      if (rawEstimate === null || !(rawEstimate > 0)) continue;

      const verdict = isExcluded({
        id: rec.id,
        tool: rec.tool,
        inputs: rec.inputs,
        estimatedAt: rec.estimatedAt,
        estimatedHours: rawEstimate,
        actual: {
          actualHours: rec.actual.actualHours,
          notes: rec.actual.notes,
          reportedAt: rec.actual.reportedAt,
          completedAt: rec.actual.completedAt,
          calibrationProvenance: rec.actual.calibrationProvenance,
        },
        flags: { quarantined: rec.flags.quarantined, orphan: rec.flags.orphan },
        ...(rec.expiresAt && { expiresAt: rec.expiresAt }),
      });
      if (verdict.excluded) {
        excludedCount++;
        continue;
      }

      const taskType = typeof rec.inputs?.["task_type"] === "string" ? rec.inputs["task_type"] : "feature";
      const complexity = typeof rec.inputs?.["complexity"] === "number" ? rec.inputs["complexity"] : undefined;
      // Current-path prediction = correctedEstimate returned at estimate time
      // (verbatim from the ledger, reflects whatever factor was in effect).
      const currentAdjusted = typeof rec.outputs?.["correctedEstimate"] === "number" ? rec.outputs["correctedEstimate"] : rawEstimate;
      const recordedFactor = typeof rec.outputs?.["correctionFactor"] === "number" ? rec.outputs["correctionFactor"] : null;
      const completedAt = rec.actual.completedAt ?? rec.actual.reportedAt ?? rec.estimatedAt;

      pairs.push({
        id: rec.id,
        taskType,
        estimatedHours: rawEstimate,
        actualHours: rec.actual.actualHours,
        currentAdjusted,
        recordedFactor,
        completedAt,
        complexity,
        tool: rec.tool,
        provenance: rec.actual.calibrationProvenance ?? "verified",
        toolRecorded: rec.actual.tool ?? null,
      });
    }

    pairs.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));

    if (pairs.length === 0) {
      console.log(JSON.stringify({ ok: false, reason: "no_matched_reference_class_pairs", sourceDataDir: SOURCE_DATA_DIR, copiedFiles }, null, 2));
      process.exitCode = 1;
      return;
    }

    // ---- 1. Baseline reproduction family -------------------------------
    const ratioRowsAll = pairs.map((p) => ({ predicted: p.currentAdjusted, actual: p.actualHours }));
    const ratioRowsRaw = pairs.map((p) => ({ predicted: p.estimatedHours, actual: p.actualHours }));
    const medianActOverPred = round3(medianRatio(ratioRowsAll));
    const medianActOverRaw = round3(medianRatio(ratioRowsRaw));

    const verifiedOnly = pairs.filter((p) => p.provenance === "verified");
    const factorApplied = pairs.filter((p) => p.recordedFactor !== null && p.recordedFactor !== 1);
    const issueTime = "2026-07-12";
    const atIssueTime = pairs.filter((p) => (p.completedAt ?? "") <= issueTime);
    const postIssue = pairs.filter((p) => (p.completedAt ?? "") > issueTime);

    const taskTypeMedians = {};
    for (const tt of [...new Set(pairs.map((p) => p.taskType))].sort()) {
      const rows = pairs.filter((p) => p.taskType === tt);
      taskTypeMedians[tt] = { n: rows.length, medianActualOverPredicted: round3(medianRatio(rows.map((p) => ({ predicted: p.currentAdjusted, actual: p.actualHours })))) };
    }

    const baseline = {
      matchedPairs: pairs.length,
      excludedByPredicate: excludedCount,
      completedAtRange: [pairs[0]?.completedAt ?? null, pairs[pairs.length - 1]?.completedAt ?? null],
      medianActualOverCorrected_all: medianActOverPred,
      medianActualOverRaw_all: medianActOverRaw,
      medianActualOverCorrected_verifiedOnly: round3(medianRatio(verifiedOnly.map((p) => ({ predicted: p.currentAdjusted, actual: p.actualHours })))),
      medianActualOverCorrected_recordedFactorApplied: round3(medianRatio(factorApplied.map((p) => ({ predicted: p.currentAdjusted, actual: p.actualHours })))),
      medianActualOverCorrected_completedOnOrBefore_issueDate: {
        issueDate: issueTime,
        n: atIssueTime.length,
        value: round3(medianRatio(atIssueTime.map((p) => ({ predicted: p.currentAdjusted, actual: p.actualHours })))),
      },
      medianActualOverCorrected_completedAfter_issueDate: {
        issueDate: issueTime,
        n: postIssue.length,
        value: round3(medianRatio(postIssue.map((p) => ({ predicted: p.currentAdjusted, actual: p.actualHours })))),
      },
      medianOfTaskTypeMedians: round3(median(Object.values(taskTypeMedians).map((v) => v.medianActualOverPredicted).filter((x) => !Number.isNaN(x)))),
      byTaskType: taskTypeMedians,
      byMonth: byMonthTable(pairs),
    };

    // ---- 2. feedback_health on the copy --------------------------------
    let feedbackHealth = null;
    try {
      const report = getFeedbackHealthReport();
      feedbackHealth = {
        totalEstimates: report.totalEstimates,
        matchedPairs: report.matchedPairs,
        matchRate: report.matchRate,
        overallTrendSource: report.overallTrend ?? report.trend ?? null,
        rceByTool: report.byTool?.[RCE_TOOL] ?? null,
        byProvenance: report.byProvenance ?? null,
      };
    } catch (err) {
      feedbackHealth = { error: String(err) };
    }

    // ---- 3. Recency backtest (the decisive time-drift test) ------------
    function buildSplit(testFraction) {
      const splitIdx = Math.max(1, Math.floor(pairs.length * (1 - testFraction)));
      const trainPairs = pairs.slice(0, splitIdx);
      const testPairs = pairs.slice(splitIdx);
      // asOf = the first held-out pair's completedAt (same convention as the
      // PERT backtest): recency weighting relative to "the moment we're about
      // to predict the test set".
      const asOf = testPairs[0]?.completedAt;
      return { trainPairs, testPairs, asOf };
    }

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
        const learnedFactor = trainFactors[RCE_TOOL]?.[p.taskType];
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
      const guardBand = correctedMedianRatio >= BAND_LO && correctedMedianRatio <= BAND_HI;
      const guardTier1 = correctedMedianRatio >= TIER1_LO && correctedMedianRatio <= TIER1_HI;

      return {
        testSetComposition: { learnedFactorApplied: learnedApplied, lowNFallback },
        current: { mdapePercent: round2(currentMdape), medianActualOverPredicted: round2(currentMedianRatio) },
        corrected: { mdapePercent: round2(correctedMdape), medianActualOverPredicted: round2(correctedMedianRatio) },
        guards: {
          correctedMdapeLeCurrentMdape: guardMdapeImproves,
          taskBandMedianRatioInBand_0_8_to_1_2: guardBand,
          tier1MedianRatioInBand_0_7_to_1_3: guardTier1,
          bothPass: guardMdapeImproves && guardBand,
        },
      };
    }

    function runAllVariants(trainPairs, testPairs, asOf) {
      return RECENCY_VARIANTS.map(({ label, recency }) => ({
        label,
        ...evaluateVariant(trainPairs, testPairs, asOf, recency),
      }));
    }

    const primary = buildSplit(TEST_FRACTION);
    if (primary.testPairs.length === 0) {
      console.log(JSON.stringify({ ok: false, reason: "insufficient_pairs_for_holdout_split", totalMatchedPairs: pairs.length }, null, 2));
      process.exitCode = 1;
      return;
    }
    const primaryResults = runAllVariants(primary.trainPairs, primary.testPairs, primary.asOf);

    const leaderboard = [...primaryResults]
      .sort((a, b) => a.corrected.mdapePercent - b.corrected.mdapePercent)
      .map((r) => ({ label: r.label, mdapePercent: r.corrected.mdapePercent, medianActualOverPredicted: r.corrected.medianActualOverPredicted, bothGuardsPass: r.guards.bothPass }));

    const primaryContenders = primaryResults.filter((r) => r.label !== "unweighted" && r.guards.bothPass);
    const winner = primaryContenders.length > 0
      ? primaryContenders.reduce((best, r) => (r.corrected.mdapePercent < best.corrected.mdapePercent ? r : best))
      : null;

    const sanity = buildSplit(SANITY_TEST_FRACTION);
    let sanityCheck = null;
    if (winner && sanity.testPairs.length > 0) {
      const sanityResults = runAllVariants(sanity.trainPairs, sanity.testPairs, sanity.asOf);
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

    // ---- 4. Post-change full-ledger evaluation -------------------------
    // Winner scheme trained on the FULL clean history (asOf = last pair),
    // applied back to the live ledger. In-sample recompute — labeled as such;
    // the out-of-sample evidence is section 3.
    let postChange = null;
    const schemeLabel = recommendedForFlip ? winner.label : "unweighted";
    const schemeEntry = RECENCY_VARIANTS.find((v) => v.label === schemeLabel);
    {
      const asOf = pairs[pairs.length - 1]?.completedAt;
      const fullHistorical = pairs.map((p) => ({
        taskType: p.taskType,
        estimatedHours: p.estimatedHours,
        actualHours: p.actualHours,
        tool: p.tool,
        ...(p.complexity !== undefined && { complexity: p.complexity }),
        completedAt: p.completedAt,
      }));
      const effectiveRecency = schemeEntry.recency ? { ...schemeEntry.recency, asOf } : undefined;
      const factors = computeToolTaskCorrectionFactors(fullHistorical, effectiveRecency);
      const trainN = new Map();
      for (const p of pairs) trainN.set(p.taskType, (trainN.get(p.taskType) ?? 0) + 1);

      const rows = [];
      let learnedApplied = 0;
      let lowNFallback = 0;
      for (const p of pairs) {
        const n = trainN.get(p.taskType) ?? 0;
        const learnedFactor = factors[RCE_TOOL]?.[p.taskType];
        let predicted;
        if (n >= MIN_RECORDS_PER_FACTOR && learnedFactor !== undefined) {
          predicted = p.estimatedHours * learnedFactor;
          learnedApplied++;
        } else {
          predicted = p.currentAdjusted;
          lowNFallback++;
        }
        rows.push({ predicted, actual: p.actualHours, completedAt: p.completedAt });
      }

      // Trailing-window view: last 20% of pairs by time (the regime the
      // degraded measurement was taken in).
      const tailStart = Math.max(0, Math.floor(pairs.length * 0.8));
      const tailRows = rows.slice(tailStart);

      postChange = {
        schemeLabel,
        inSample: true,
        note: "In-sample recompute over the same live-ledger pairs (factor trained on all clean history up to the last pair). Out-of-sample evidence is in recencyBacktest.",
        learnedApplied,
        lowNFallback,
        factors: factors[RCE_TOOL] ?? {},
        medianActualOverPredicted_allPairs: round3(medianRatio(rows)),
        medianActualOverPredicted_trailing20pct: round3(medianRatio(tailRows)),
        band: { lo: BAND_LO, hi: BAND_HI, allPairsInBand: (() => { const v = medianRatio(rows); return v >= BAND_LO && v <= BAND_HI; })() },
      };
    }

    const report = {
      ok: true,
      tool: RCE_TOOL,
      sourceDataDir: SOURCE_DATA_DIR,
      copiedFiles,
      totalMatchedPairs: pairs.length,
      baseline,
      feedbackHealth,
      recencyBacktest: {
        method: "chronological holdout mirroring scripts/backtest-pert-correction.mjs (clean path: loadLedgerWithOverlays + isExcluded)",
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
          ? `PASS — recency-weighted variant "${winner.label}" clears both guards on the 80/20 split and beats the unweighted baseline on the independent 70/30 split; safe to wire as the reference_class correction-training default.`
          : winner
            ? `HOLD — variant "${winner.label}" passed both guards on the 80/20 split but failed the overfitting sanity check on the 70/30 split; do not change the reference_class default yet.`
            : "HOLD — no recency-weighted variant cleared both guards on the primary split; do not change the reference_class default yet.",
      },
      postChange,
    };

    console.log(JSON.stringify(report, null, 2));
    process.exitCode = recommendedForFlip ? 0 : 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
