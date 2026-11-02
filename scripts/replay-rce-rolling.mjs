#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Rolling-origin replay of reference_class_estimate correction-factor training
// THROUGH THE LANDED WAVE-2 IMPLEMENTATION (src/lib/calibration-factors.ts:
// computeToolTaskCorrectionFactors + RecencyOptions + weightedMedian).
//
// This is the literal "apply the landed wave-2 recency-weighting implementation
// to reference_class correction-factor training" measurement requested by
// issue #42: for every matched reference_class_estimate pair on the live
// production ledger copy, train the (reference_class_estimate, task_type)
// factor exactly the way the landed machinery does (pre-correction basis =
// outputs.rawEstimate, the analog of loadPertMatchedRecords' `expected`;
// recency scheme asOf = the row's estimate time; MIN_RECORDS_PER_FACTOR gate),
// predict, and measure actual/predicted.
//
// READ-ONLY on the source data dir (copied to a temp dir first, like
// scripts/backtest-rce-correction.mjs).
//
// Policies: the brief's recency grid (none / exp30 / exp45 / exp90 / win60 /
// win90 / win180) on the pre-correction basis, plus:
//  - "recorded-ledger"        : the ledger as produced (the 0.545 family)
//  - "as-landed-replay"       : current-code behavior replay (post-correction
//                               basis, unweighted, trailing-90d window) for
//                               instrument validation
//  - "weighting-only-<scheme>": post-correction basis + recency scheme (the
//                               literal weighting-only reading of the change)
//
// Usage: EPOCH_DATA_DIR=<ledger-copy> node scripts/replay-rce-rolling.mjs
// ---------------------------------------------------------------------------

import { existsSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const SOURCE_DATA_DIR = process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
const OUT_PATH = process.env["RCE_REPLAY_OUT"] ?? "rce-replay-ts-results.json";

const FILES_TO_COPY = [
  "estimates.jsonl",
  "feedback.jsonl",
  "estimates.flags.jsonl",
  "estimates.labels.jsonl",
  "estimates.quarantine.jsonl",
  "reference-database.json",
];

const RCE_TOOL = "reference_class_estimate";
const BAND_LO = 0.8;
const BAND_HI = 1.2;
const WINDOW_DAYS = 90; // getCalibrationData windowDays for reference_class_estimate
const INLINE_GATE = 5; // referenceClassEstimate inline data-driven gate

const SCHEME_GRID = [
  { label: "none", recency: { scheme: { kind: "none" } } },
  { label: "exp30", recency: { scheme: { kind: "exponential", halfLifeDays: 30 } } },
  { label: "exp45", recency: { scheme: { kind: "exponential", halfLifeDays: 45 } } },
  { label: "exp90", recency: { scheme: { kind: "exponential", halfLifeDays: 90 } } },
  { label: "win60", recency: { scheme: { kind: "window", windowDays: 60 } } },
  { label: "win90", recency: { scheme: { kind: "window", windowDays: 90 } } },
  { label: "win180", recency: { scheme: { kind: "window", windowDays: 180 } } },
];

function round3(x) { return Math.round(x * 1000) / 1000; }
function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function apeOf(predicted, actual) { return (Math.abs(predicted - actual) / actual) * 100; }

function summarize(preds, label, basis, scheme) {
  const ratios = preds.filter((p) => p.predicted > 0 && p.actual > 0).map((p) => p.actual / p.predicted);
  const apes = preds.map((p) => apeOf(p.predicted, p.actual));
  const n = preds.length;
  const tail = preds.slice(Math.floor(n * 0.8));
  const tailRatios = tail.filter((p) => p.predicted > 0).map((p) => p.actual / p.predicted);
  const byMonth = {};
  for (const p of preds) {
    const m = (p.completedAt ?? "").slice(0, 7) || "unknown";
    (byMonth[m] ??= []).push(p.actual / p.predicted);
  }
  const monthly = {};
  for (const [m, v] of Object.entries(byMonth).sort()) monthly[m] = round3(median(v));
  const half = Math.floor(n / 2);
  const mapeOf = (list) => list.reduce((s, p) => s + apeOf(p.predicted, p.actual), 0) / list.length * 100;
  const m1 = mapeOf(preds.slice(0, half));
  const m2 = mapeOf(preds.slice(half));
  const trend = m2 > m1 * 1.15 ? "degrading" : m2 < m1 * 0.85 ? "improving" : "stable";
  const bias = preds.reduce((s, p) => s + (p.predicted - p.actual) / p.actual, 0) / n;
  const medAll = median(ratios);
  return {
    label, basis, scheme, n,
    learnedApplied: preds.filter((p) => p.usedLearned).length,
    fallbackUsed: preds.filter((p) => !p.usedLearned).length,
    medianActualOverPredicted_all: round3(medAll),
    medianActualOverPredicted_trailing20pct: round3(median(tailRatios)),
    inBand_all: medAll >= BAND_LO && medAll <= BAND_HI,
    inBand_trailing20pct: median(tailRatios) >= BAND_LO && median(tailRatios) <= BAND_HI,
    mdapePercent: round3(median(apes)),
    mapePercent: round3(mapeOf(preds)),
    biasPredictedMinusActualOverActual: round3(bias),
    trendMapeFirstHalfVsSecond: trend,
    mapeFirstHalfPercent: round3(m1),
    mapeSecondHalfPercent: round3(m2),
    monthlyMedianActualOverPredicted: monthly,
  };
}

async function main() {
  if (!existsSync(SOURCE_DATA_DIR)) {
    console.error(JSON.stringify({ ok: false, reason: "source_data_dir_missing", sourceDataDir: SOURCE_DATA_DIR }));
    process.exitCode = 1;
    return;
  }
  const tempDir = mkdtempSync(join(tmpdir(), "epoch-rce-replay-"));
  try {
    let copiedFiles = 0;
    for (const file of FILES_TO_COPY) {
      const src = join(SOURCE_DATA_DIR, file);
      if (existsSync(src)) { copyFileSync(src, join(tempDir, file)); copiedFiles++; }
    }
    process.env["EPOCH_DATA_DIR"] = tempDir;

    const { loadLedgerWithOverlays } = await import("../src/lib/ledger.ts");
    const { isExcluded } = await import("../src/lib/exclusion.ts");
    const { computeToolTaskCorrectionFactors, MIN_RECORDS_PER_FACTOR } = await import("../src/lib/calibration-factors.ts");
    const { extractEstimatedHours } = await import("../src/lib/feedback-analytics.ts");

    const merged = loadLedgerWithOverlays();
    const pairs = [];
    let excluded = 0;
    for (const rec of merged) {
      if (rec.tool !== RCE_TOOL) continue;
      if (!rec.actual || !(rec.actual.actualHours > 0)) continue;
      const rawEstimate = typeof rec.outputs?.["rawEstimate"] === "number" ? rec.outputs["rawEstimate"]
        : typeof rec.outputs?.["correctedEstimate"] === "number" ? rec.outputs["correctedEstimate"]
        : null;
      if (rawEstimate === null || !(rawEstimate > 0)) continue;
      const verdict = isExcluded({
        id: rec.id, tool: rec.tool, inputs: rec.inputs, estimatedAt: rec.estimatedAt,
        estimatedHours: rawEstimate,
        actual: { actualHours: rec.actual.actualHours, notes: rec.actual.notes, reportedAt: rec.actual.reportedAt, completedAt: rec.actual.completedAt, calibrationProvenance: rec.actual.calibrationProvenance },
        flags: { quarantined: rec.flags.quarantined, orphan: rec.flags.orphan },
        ...(rec.expiresAt && { expiresAt: rec.expiresAt }),
      });
      if (verdict.excluded) { excluded++; continue; }
      const taskType = typeof rec.inputs?.["task_type"] === "string" ? rec.inputs["task_type"] : "feature";
      const complexity = typeof rec.inputs?.["complexity"] === "number" ? rec.inputs["complexity"] : undefined;
      const completedAt = rec.actual.completedAt ?? rec.actual.reportedAt ?? rec.estimatedAt;
      const recordedPredicted = extractEstimatedHours(rec.outputs) ?? rawEstimate;
      // getCalibrationData(calibrationUsage="correction") training-usage rule:
      // backfilled_* provenance and completed-before-estimated rows are held
      // out of correction-factor training (feedback-analytics.ts
      // classifyCalibrationRecord defaults).
      const prov = rec.actual.calibrationProvenance ?? "verified";
      const backfilled = prov.startsWith("backfilled");
      const completedBeforeEstimate = Date.parse(completedAt) < Date.parse(rec.estimatedAt);
      pairs.push({
        id: rec.id, taskType, complexity, rawEstimate, recordedPredicted,
        actualHours: rec.actual.actualHours, estimatedAt: rec.estimatedAt, completedAt,
        trainOk: !backfilled && !completedBeforeEstimate,
      });
    }
    pairs.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? "") || (a.estimatedAt ?? "").localeCompare(b.estimatedAt ?? ""));

    const results = [];

    // Baseline family: the ledger as produced (issue #42's measurement family).
    results.push(summarize(
      pairs.filter((p) => p.recordedPredicted > 0).map((p) => ({ predicted: p.recordedPredicted, actual: p.actualHours, completedAt: p.completedAt, usedLearned: true })),
      "recorded-ledger (baseline family)", "post-correction (recorded)", "as-produced"));

    function historicalRecordsFor(row, basis, selfPreds, applyDataWindow) {
      const records = [];
      const tI = Date.parse(row.estimatedAt);
      for (const q of pairs) {
        if (q.id === row.id || q.taskType !== row.taskType || !q.trainOk) continue;
        if (!(Date.parse(q.completedAt) < tI)) continue; // actual known before this estimate
        if (applyDataWindow && !(tI - WINDOW_DAYS * 86_400_000 <= Date.parse(q.estimatedAt) && Date.parse(q.estimatedAt) < tI)) continue;
        const est = basis === "pre-correction"
          ? q.rawEstimate
          : (selfPreds.get(q.id) ?? q.recordedPredicted);
        if (!(est > 0)) continue;
        records.push({ taskType: q.taskType, estimatedHours: est, actualHours: q.actualHours, tool: RCE_TOOL, completedAt: q.completedAt, ...(q.complexity !== undefined && { complexity: q.complexity }) });
      }
      return records;
    }

    async function runPolicy(label, basis, schemeEntry, selfConsistent, applyDataWindow) {
      const preds = [];
      const selfPreds = new Map();
      for (const row of pairs) {
        const records = historicalRecordsFor(row, basis, selfPreds, applyDataWindow);
        const recency = schemeEntry ? { ...schemeEntry.recency, asOf: row.estimatedAt } : undefined;
        const factors = computeToolTaskCorrectionFactors(records, recency);
        const cellN = records.length;
        const factor = factors[RCE_TOOL]?.[row.taskType];
        const usedLearned = cellN >= INLINE_GATE && factor !== undefined;
        const predicted = usedLearned ? row.rawEstimate * factor : row.recordedPredicted;
        if (selfConsistent) selfPreds.set(row.id, predicted);
        preds.push({ predicted, actual: row.actualHours, completedAt: row.completedAt, usedLearned });
      }
      return summarize(preds, label, basis, schemeEntry?.label ?? "unweighted");
    }

    // As-landed replay (instrument validation): post-correction basis,
    // unweighted, trailing-90d window, self-consistent recursion.
    results.push(await runPolicy("as-landed-replay (post-correction basis, unweighted, 90d window, self-consistent)", "post-correction", { label: "none", recency: { scheme: { kind: "none" } } }, true, true));

    // Literal weighting-only reading: post-correction basis + recency scheme.
    for (const schemeEntry of SCHEME_GRID) {
      results.push(await runPolicy(`weighting-only-${schemeEntry.label} (post-correction basis, conditional)`, "post-correction", schemeEntry, false, false));
    }

    // The change under test: landed wave-2 machinery on the pre-correction
    // basis (loadPertMatchedRecords semantics), recency grid.
    for (const schemeEntry of SCHEME_GRID) {
      results.push(await runPolicy(`wave2-${schemeEntry.label} (pre-correction basis, conditional)`, "pre-correction", schemeEntry, false, false));
    }

    const report = {
      ok: true,
      tool: RCE_TOOL,
      sourceDataDir: SOURCE_DATA_DIR,
      copiedFiles,
      excludedByPredicate: excluded,
      matchedPairs: pairs.length,
      method: "rolling-origin replay THROUGH the landed wave-2 implementation (computeToolTaskCorrectionFactors + RecencyOptions + weightedMedian); factor trained per row on pairs whose actual completed before that row's estimate time; asOf = row estimate time; low-n (<MIN_RECORDS_PER_FACTOR) falls back to the row's recorded prediction (as-landed behavior)",
      minRecordsPerFactor: MIN_RECORDS_PER_FACTOR,
      inlineGate: INLINE_GATE,
      band: { lo: BAND_LO, hi: BAND_HI },
      results,
    };
    writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
