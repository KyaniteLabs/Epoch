import type { AccuracyTrend, AccuracyWindow } from "../types/index.js";
import { computeAccuracyMetrics } from "./analytics.js";
import { getCalibrationData, minNForVerdict } from "./feedback.js";
import { getEstimationResearch } from "./supplementary-data.js";

/**
 * Compute the accuracy trend, gated on MIN_N_FOR_VERDICT (Phase 1 Task 1):
 * below the threshold, no directional trend claim (improving/degrading) is
 * made — overallTrend is forced to "stable" and humanReadable reports an
 * insufficient-sample verdict instead. Windows/currentMape/etc. are still
 * returned as raw informational data (shape unchanged).
 */
export function computeAccuracyTrend(params?: {
  windowSize?: number;
  teamId?: string;
}): AccuracyTrend {
  const result = computeAccuracyTrendRaw(params);
  const minN = minNForVerdict();
  if (result.totalWithActuals < minN) {
    return {
      ...result,
      overallTrend: "stable",
      humanReadable: `Insufficient sample (n=${result.totalWithActuals}). Need at least ${minN} matched estimate-actual pairs before an accuracy-trend verdict (improving/degrading/stable) can be reported. Raw MAPE so far: ${result.currentMape}%.`,
    };
  }
  return result;
}

function computeAccuracyTrendRaw(params?: {
  windowSize?: number;
  teamId?: string;
}): AccuracyTrend {
  const requestedWindowSize = params?.windowSize ?? 50;
  const records = getCalibrationData(params?.teamId);

  const totalEstimates = records.length;
  const totalWithActuals = records.length; // records are already matched pairs from getCalibrationData

  if (records.length === 0) {
    const industryBaseline = getEstimationResearch().expertEstimatesWithinPercent;
    return {
      windows: [],
      overallTrend: "stable",
      currentMape: 0,
      industryBaselineMape: industryBaseline,
      improvementVsIndustry: industryBaseline - 0,
      totalEstimates: 0,
      totalWithActuals: 0,
      humanReadable: "No historical estimation data available. Start recording estimates and actuals to track accuracy trends.",
    };
  }

  // Sort by completedAt ascending (getCalibrationData already sorts, but ensure it)
  const sorted = [...records].sort((a, b) =>
    (a.completedAt ?? "").localeCompare(b.completedAt ?? ""),
  );

  // Adaptive window sizing: avoid tiny last windows by redistributing evenly
  const minWindowSize = 10;
  let windowSize = requestedWindowSize;
  if (sorted.length >= windowSize * 2) {
    const remainder = sorted.length % windowSize;
    if (remainder > 0 && remainder < windowSize / 2) {
      const numWindows = Math.ceil(sorted.length / windowSize);
      windowSize = Math.ceil(sorted.length / numWindows);
    }
  }
  windowSize = Math.max(minWindowSize, windowSize);

  // If fewer records than windowSize, return single window
  if (sorted.length < windowSize) {
    const metrics = computeAccuracyMetrics(sorted);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const window: AccuracyWindow = {
      period: `Window 1 (estimates 1-${sorted.length})`,
      dateRange: first && last ? `${(first.completedAt ?? "").slice(0, 10)} to ${(last.completedAt ?? "").slice(0, 10)}` : undefined,
      mape: metrics.mape,
      mdape: metrics.mdape,
      bias: metrics.bias,
      sampleSize: sorted.length,
    };
    const industryBaseline = getEstimationResearch().expertEstimatesWithinPercent;
    const currentMape = metrics.mape;
    const improvementVsIndustry = Math.round((industryBaseline - currentMape) * 10) / 10;
    return {
      windows: [window],
      overallTrend: "stable",
      currentMape,
      industryBaselineMape: industryBaseline,
      improvementVsIndustry,
      totalEstimates,
      totalWithActuals,
      humanReadable: buildHumanReadable("stable", currentMape, industryBaseline, improvementVsIndustry, [window]),
    };
  }

  // Split into consecutive windows
  const windows: AccuracyWindow[] = [];
  for (let i = 0; i < sorted.length; i += windowSize) {
    const windowRecords = sorted.slice(i, i + windowSize);
    if (windowRecords.length === 0) break;
    const metrics = computeAccuracyMetrics(windowRecords);
    const first = windowRecords[0];
    const last = windowRecords[windowRecords.length - 1];
    if (!first || !last) continue;
    const windowIndex = Math.floor(i / windowSize) + 1;
    const startEstimate = i + 1;
    const endEstimate = i + windowRecords.length;
    windows.push({
      period: `Window ${windowIndex} (estimates ${startEstimate}-${endEstimate})`,
      dateRange: `${(first.completedAt ?? "").slice(0, 10)} to ${(last.completedAt ?? "").slice(0, 10)}`,
      mape: metrics.mape,
      mdape: metrics.mdape,
      bias: metrics.bias,
      sampleSize: windowRecords.length,
    });
  }

  // Determine overall trend: compare first window MdAPE to last window MdAPE
  const firstMdape = windows[0]?.mdape ?? 0;
  const lastMdape = windows[windows.length - 1]?.mdape ?? 0;
  const lastMape = windows[windows.length - 1]?.mape ?? 0;
  let overallTrend: AccuracyTrend["overallTrend"] = "stable";
  if (lastMdape < firstMdape * 0.85) {
    overallTrend = "improving";
  } else if (lastMdape > firstMdape * 1.15) {
    overallTrend = "degrading";
  }

  const industryBaseline = getEstimationResearch().expertEstimatesWithinPercent;
  const currentMape = lastMape;
  const improvementVsIndustry = Math.round((industryBaseline - currentMape) * 10) / 10;

  return {
    windows,
    overallTrend,
    currentMape,
    industryBaselineMape: industryBaseline,
    improvementVsIndustry,
    totalEstimates,
    totalWithActuals,
    humanReadable: buildHumanReadable(overallTrend, currentMape, industryBaseline, improvementVsIndustry, windows),
  };
}

function buildHumanReadable(
  trend: string,
  currentMape: number,
  industryBaseline: number,
  improvementVsIndustry: number,
  windows: readonly AccuracyWindow[],
): string {
  const trendLabel = trend === "improving" ? "improving" : trend === "degrading" ? "degrading" : "stable";
  const vsIndustry = improvementVsIndustry > 0
    ? `${improvementVsIndustry}% better than industry baseline (${industryBaseline}%)`
    : improvementVsIndustry < 0
      ? `${Math.abs(improvementVsIndustry)}% worse than industry baseline (${industryBaseline}%)`
      : `equal to industry baseline (${industryBaseline}%)`;

  const lastMdape = windows[windows.length - 1]?.mdape ?? 0;
  const mdapeValues = windows.map(w => w.mdape);
  const windowSummary = windows.length === 1
    ? `1 window (MdAPE: ${lastMdape}%, MAPE: ${windows[0]?.mape ?? 0}%)`
    : `${windows.length} windows, MdAPE range: ${Math.min(...mdapeValues)}% to ${Math.max(...mdapeValues)}%`;

  return `Accuracy trend is ${trendLabel}. Current MdAPE: ${lastMdape}% (MAPE: ${currentMape}%), ${vsIndustry}. ${windowSummary} across ${windows.reduce((sum, w) => sum + w.sampleSize, 0)} estimates.`;
}
