import type { AccuracyTrend, AccuracyWindow } from "../types/index.js";
import { computeAccuracyMetrics } from "./analytics.js";
import { getCalibrationData } from "./feedback.js";
import { getEstimationResearch } from "./supplementary-data.js";

export function computeAccuracyTrend(params?: {
  windowSize?: number;
  teamId?: string;
}): AccuracyTrend {
  const windowSize = params?.windowSize ?? 50;
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
    a.completedAt.localeCompare(b.completedAt),
  );

  // If fewer records than windowSize, return single window
  if (sorted.length < windowSize) {
    const metrics = computeAccuracyMetrics(sorted);
    const window: AccuracyWindow = {
      period: `Window 1 (estimates 1-${sorted.length})`,
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
    const windowIndex = Math.floor(i / windowSize) + 1;
    const startEstimate = i + 1;
    const endEstimate = i + windowRecords.length;
    windows.push({
      period: `Window ${windowIndex} (estimates ${startEstimate}-${endEstimate})`,
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

  const mapeValues = windows.map(w => w.mape);
  const windowSummary = windows.length === 1
    ? `1 window with MAPE ${windows[0]?.mape ?? 0}%`
    : `${windows.length} windows, MAPE range: ${mapeValues.length > 0 ? Math.min(...mapeValues) : 0}% to ${mapeValues.length > 0 ? Math.max(...mapeValues) : 0}%`;

  return `Accuracy trend is ${trendLabel}. Current MAPE: ${currentMape}%, ${vsIndustry}. ${windowSummary} across ${windows.reduce((sum, w) => sum + w.sampleSize, 0)} estimates.`;
}
