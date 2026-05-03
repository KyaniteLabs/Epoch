import type { TaskType, ScheduleRiskAssessment, RiskLevel } from "../types/index.js";
import { assertNever } from "../types/index.js";
import { computeAccuracyMetrics } from "./analytics.js";
import { getCalibrationData } from "./feedback.js";
import { getEstimationResearch } from "./supplementary-data.js";
import { getDeveloperProfileGradient } from "./profiles.js";

export function scheduleRisk(params: {
  estimatedHours: number;
  taskType?: TaskType;
  teamId?: string;
  aiNative?: number;
}): ScheduleRiskAssessment {
  const { estimatedHours, taskType, teamId } = params;

  if (!estimatedHours || !Number.isFinite(estimatedHours) || estimatedHours <= 0) {
    return {
      estimatedHours: 0,
      riskLevel: "critical" as RiskLevel,
      confidenceIntervals: { p50: 0, p80: 0, p95: 0 },
      historicalAccuracy: { mape: 0, sampleSize: 0 },
      recommendation: "Invalid estimated hours. Provide a positive number.",
      humanReadable: "Cannot assess risk: estimated hours is zero or invalid.",
    };
  }

  const records = getCalibrationData(teamId, taskType);

  let mdape: number;
  let mape: number;
  let sampleSize: number;

  if (records.length >= 5) {
    const metrics = computeAccuracyMetrics(records);
    mdape = metrics.mdape;
    mape = metrics.mape;
    sampleSize = metrics.sample_size;
  } else {
    const profile = getDeveloperProfileGradient(params.aiNative ?? 1.0);
    mdape = profile.estimationMape;
    mape = profile.estimationMape;
    sampleSize = records.length;
  }

  // Confidence intervals using normal approximation with MdAPE (robust to outliers)
  const p50 = Math.round(estimatedHours * 10) / 10;
  const p80 = Math.round(estimatedHours * (1 + 0.842 * mdape / 100) * 10) / 10;
  const p95 = Math.round(estimatedHours * (1 + 1.645 * mdape / 100) * 10) / 10;

  // Risk level based on MdAPE
  let riskLevel: RiskLevel;
  if (mdape < 20) {
    riskLevel = "low";
  } else if (mdape <= 35) {
    riskLevel = "medium";
  } else if (mdape <= 50) {
    riskLevel = "high";
  } else {
    riskLevel = "critical";
  }

  // Recommendation based on risk level
  const recommendation = getRecommendation(riskLevel);

  const mapeRounded = Math.round(mape * 10) / 10;
  const mdapeRounded = Math.round(mdape * 10) / 10;

  return {
    estimatedHours: p50,
    riskLevel,
    confidenceIntervals: { p50, p80, p95 },
    historicalAccuracy: {
      mape: mapeRounded,
      sampleSize,
    },
    recommendation,
    humanReadable: buildHumanReadable(riskLevel, mdapeRounded, mapeRounded, p50, p80, p95, sampleSize, recommendation),
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
  mdape: number,
  mape: number,
  p50: number,
  p80: number,
  p95: number,
  sampleSize: number,
  recommendation: string,
): string {
  return `Schedule risk: ${riskLevel}. MdAPE: ${mdape}% (MAPE: ${mape}%, based on ${sampleSize} historical records). Confidence intervals: p50=${p50}h, p80=${p80}h, p95=${p95}h. ${recommendation}`;
}
