import type { TaskType, ScheduleRiskAssessment, RiskLevel } from "../types/index.js";
import { assertNever } from "../types/index.js";
import { computeAccuracyMetrics } from "./analytics.js";
import { getCalibrationData } from "./feedback.js";
import { getEstimationResearch } from "./supplementary-data.js";

export function scheduleRisk(params: {
  estimatedHours: number;
  taskType?: TaskType;
  teamId?: string;
}): ScheduleRiskAssessment {
  const { estimatedHours, taskType, teamId } = params;
  const records = getCalibrationData(teamId, taskType);

  let mape: number;
  let sampleSize: number;

  if (records.length >= 5) {
    const metrics = computeAccuracyMetrics(records);
    mape = metrics.mape;
    sampleSize = metrics.sample_size;
  } else {
    mape = getEstimationResearch().expertEstimatesWithinPercent;
    sampleSize = records.length;
  }

  // Confidence intervals using normal approximation
  const p50 = Math.round(estimatedHours * 10) / 10;
  const p80 = Math.round(estimatedHours * (1 + 0.842 * mape / 100) * 10) / 10;
  const p95 = Math.round(estimatedHours * (1 + 1.645 * mape / 100) * 10) / 10;

  // Risk level based on MAPE
  let riskLevel: RiskLevel;
  if (mape < 20) {
    riskLevel = "low";
  } else if (mape <= 35) {
    riskLevel = "medium";
  } else if (mape <= 50) {
    riskLevel = "high";
  } else {
    riskLevel = "critical";
  }

  // Recommendation based on risk level
  const recommendation = getRecommendation(riskLevel);

  const mapeRounded = Math.round(mape * 10) / 10;

  return {
    estimatedHours: p50,
    riskLevel,
    confidenceIntervals: { p50, p80, p95 },
    historicalAccuracy: {
      mape: mapeRounded,
      sampleSize,
    },
    recommendation,
    humanReadable: buildHumanReadable(riskLevel, mapeRounded, p50, p80, p95, sampleSize, recommendation),
  };
}

function getRecommendation(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case "low":
      return "Low risk. Estimate is within normal variance.";
    case "medium":
      return "Moderate risk. Consider adding 20-30% buffer.";
    case "high":
      return "High risk. Recommend re-estimating with more detail.";
    case "critical":
      return "Critical risk. Break down the task and re-estimate each component.";
    default: return assertNever(riskLevel);
  }
}

function buildHumanReadable(
  riskLevel: RiskLevel,
  mape: number,
  p50: number,
  p80: number,
  p95: number,
  sampleSize: number,
  recommendation: string,
): string {
  return `Schedule risk: ${riskLevel}. MAPE: ${mape}% (based on ${sampleSize} historical records). Confidence intervals: p50=${p50}h, p80=${p80}h, p95=${p95}h. ${recommendation}`;
}
