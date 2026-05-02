import type { CocomoValidationReport } from "../types/index.js";
import type { ToolResult } from "../types/index.js";
import { getCocomoProjects, getCocomoDerivedFactors } from "./supplementary-data.js";

// ---------------------------------------------------------------------------
// COCOMO Validation — Validate COCOMO model against calibration datasets
// ---------------------------------------------------------------------------

const COCOMO_BASIC: Record<string, { a: number; b: number }> = {
  organic: { a: 2.4, b: 1.05 },
  semidetached: { a: 3.0, b: 1.12 },
  embedded: { a: 3.6, b: 1.20 },
};

export function cocomoValidate(params?: {
  datasetFilter?: string[];
}): ToolResult<CocomoValidationReport> {
  const datasets = getCocomoProjects();
  const derivedFactors = getCocomoDerivedFactors();

  if (datasets.length === 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "COCOMO calibration data not found. Load calibration datasets before validation.",
        retryHint: "Ensure the COCOMO calibration data files are present in the data directory.",
      },
    };
  }

  // Override hardcoded coefficients with derived factors if available
  const coefficients: Record<string, { a: number; b: number }> = { ...COCOMO_BASIC };
  if (derivedFactors?.cocomoBasic) {
    for (const [type, factors] of Object.entries(derivedFactors.cocomoBasic)) {
      coefficients[type] = { a: factors.a, b: factors.b };
    }
  }

  const allErrors: number[] = [];
  const allBiases: number[] = [];
  const byType = new Map<string, { errors: number[]; biases: number[] }>();

  const filteredDatasets = params?.datasetFilter
    ? datasets.filter((d) => params.datasetFilter!.includes(d.name))
    : datasets;

  let projectsEvaluated = 0;

  for (const dataset of filteredDatasets) {
    for (const project of dataset.projects) {
      if (project.kloc <= 0 || project.effortPersonMonths <= 0) continue;

      const projectType = project.type ?? "semidetached";
      const coeffs = coefficients[projectType] ?? coefficients.semidetached;
      if (!coeffs) continue;

      const predicted = coeffs.a * Math.pow(project.kloc, coeffs.b);
      const actual = project.effortPersonMonths;
      const errorPercent = ((predicted - actual) / actual) * 100;
      const absError = Math.abs(errorPercent);

      allErrors.push(absError);
      allBiases.push(errorPercent);
      projectsEvaluated++;

      if (!byType.has(projectType)) {
        byType.set(projectType, { errors: [], biases: [] });
      }
      const typeEntry = byType.get(projectType)!;
      typeEntry.errors.push(absError);
      typeEntry.biases.push(errorPercent);
    }
  }

  if (projectsEvaluated === 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "No valid projects found in COCOMO calibration data (all projects had kloc <= 0 or effort <= 0).",
        retryHint: "Check that calibration datasets contain projects with positive kloc and effort values.",
      },
    };
  }

  const mape = allErrors.reduce((sum, e) => sum + e, 0) / allErrors.length;
  const bias = allBiases.reduce((sum, b) => sum + b, 0) / allBiases.length;

  const byProjectType: Record<string, { mape: number; count: number }> = {};
  for (const [type, entry] of byType) {
    byProjectType[type] = {
      mape: entry.errors.reduce((s, e) => s + e, 0) / entry.errors.length,
      count: entry.errors.length,
    };
  }

  const recommendedAdjustments: Array<{
    parameter: string;
    currentValue: number;
    recommendedValue: number;
    reason: string;
  }> = [];

  for (const [type, entry] of byType) {
    const coeffs = coefficients[type] ?? coefficients.semidetached;
    if (!coeffs) continue;

    const typeMape = entry.errors.reduce((s, e) => s + e, 0) / entry.errors.length;
    const typeBias = entry.biases.reduce((s, b) => s + b, 0) / entry.biases.length;

    if (type === "organic" && typeMape > 30) {
      const adjustedA = coeffs.a * (1 + typeBias / 100);
      recommendedAdjustments.push({
        parameter: `${type}.a`,
        currentValue: coeffs.a,
        recommendedValue: Math.round(adjustedA * 100) / 100,
        reason: `Organic MAPE is ${Math.round(typeMape)}%, exceeding 30% threshold. Adjust coefficient a to reduce prediction error.`,
      });
    }

    if (type === "embedded" && typeMape > 30) {
      const adjustedB = coeffs.b * (1 + typeBias / 200);
      recommendedAdjustments.push({
        parameter: `${type}.b`,
        currentValue: coeffs.b,
        recommendedValue: Math.round(adjustedB * 1000) / 1000,
        reason: `Embedded MAPE is ${Math.round(typeMape)}%, exceeding 30% threshold. Adjust coefficient b to reduce prediction error.`,
      });
    }
  }

  if (Math.abs(bias) > 20) {
    const scaleFactor = 1 - bias / 100;
    recommendedAdjustments.push({
      parameter: "overall_scale_factor",
      currentValue: 1.0,
      recommendedValue: Math.round(scaleFactor * 100) / 100,
      reason: `Overall bias is ${Math.round(bias)}%, exceeding 20% threshold. Apply scale factor to correct systematic over/underprediction.`,
    });
  }

  const humanReadable = [
    `COCOMO Validation Report: ${projectsEvaluated} projects evaluated.`,
    `Overall MAPE: ${Math.round(mape)}%, Bias: ${Math.round(bias)}%.`,
    Object.entries(byProjectType)
      .map(([type, data]) => `  ${type}: MAPE=${Math.round(data.mape)}% (${data.count} projects)`)
      .join("\n"),
    recommendedAdjustments.length > 0
      ? `Recommended adjustments: ${recommendedAdjustments.map((a) => a.parameter).join(", ")}.`
      : "No adjustments recommended — model fits within acceptable thresholds.",
  ].join("\n");

  return {
    ok: true,
    data: {
      projectsEvaluated,
      mape: Math.round(mape * 100) / 100,
      bias: Math.round(bias * 100) / 100,
      byProjectType,
      recommendedAdjustments,
      humanReadable,
    },
  };
}
