// ---------------------------------------------------------------------------
// Epoch — COCOMO Ground Truth Validation
// Runs COCOMO models against 240 real projects with known effort.
// Compares: COCOMO Basic, COCOMO II Nominal, COCOMO II + AI speedup, LLM + developer profile.
// ---------------------------------------------------------------------------

import type { ToolResult } from "../types/index.js";
import { getCocomoProjects } from "./supplementary-data.js";
import { getDeveloperProfileGradient } from "./profiles.js";

// ---- COCOMO coefficients ---------------------------------------------------

const COCOMO_BASIC: Record<string, { a: number; b: number }> = {
  organic: { a: 2.4, b: 1.05 },
  semidetached: { a: 3.0, b: 1.12 },
  embedded: { a: 3.6, b: 1.20 },
};

const COCOMO_II_A = 2.94;
const COCOMO_II_B = 1.10;

// ---- Types -----------------------------------------------------------------

interface PerProjectResult {
  id: number;
  kloc: number;
  actual: number;
  dataset: string;
  type: string;
  models: {
    basic: number;
    nominal: number;
    aiSpeedup: number;
    aiProfile0: number;
    aiProfile05: number;
    aiProfile1: number;
  };
}

interface ModelMetrics {
  name: string;
  mape: number;
  mmre: number;
  pred25: number;
  pred50: number;
  bias: number;
  count: number;
}

export interface CocomoGroundTruthResult {
  projectsEvaluated: number;
  models: ModelMetrics[];
  byDataset: Record<string, { count: number; bestModel: string; bestMape: number }>;
  byType: Record<string, { count: number; bestModel: string; bestMape: number }>;
  winner: string;
  conclusion: string;
  humanReadable: string;
}

// ---- Per-project prediction ------------------------------------------------

function predictAll(kloc: number, projectType: string): PerProjectResult["models"] {
  // Model A — COCOMO Basic
  const basicCoeffs = COCOMO_BASIC[projectType] ?? COCOMO_BASIC.semidetached!;
  const basic = basicCoeffs!.a * Math.pow(kloc, basicCoeffs!.b);

  // Model B — COCOMO II Nominal (no multipliers)
  const nominal = COCOMO_II_A * Math.pow(kloc, COCOMO_II_B);

  // Model C — COCOMO II + AI speedup (12x divisor, default params)
  // emProduct = 1.0 * 1.0 * 1.0 * 1.0 * 1.0 = 1.0
  // personMonthsNominal = 2.94 * kloc^1.10 * 1.0 = nominal
  // llmOverhead = 1.0 + (1.0 - 1.0) * 0.15 = 1.0
  // aiSpeedupDivisor = max(3.0, 12.0 / 1.0) = 12.0
  const aiSpeedup = nominal / 12.0;

  // Model D — LLM-adjusted + developer profile at ai_native 0.0, 0.5, 1.0
  const profile0 = getDeveloperProfileGradient(0.0);
  const profile05 = getDeveloperProfileGradient(0.5);
  const profile1 = getDeveloperProfileGradient(1.0);

  const aiProfile0 = aiSpeedup * profile0.correctionFactor;
  const aiProfile05 = aiSpeedup * profile05.correctionFactor;
  const aiProfile1 = aiSpeedup * profile1.correctionFactor;

  return { basic, nominal, aiSpeedup, aiProfile0, aiProfile05, aiProfile1 };
}

// ---- Metric computation ----------------------------------------------------

function computeMetrics(predictions: number[], actuals: number[], name: string): ModelMetrics {
  const n = predictions.length;
  if (n === 0) {
    return { name, mape: 0, mmre: 0, pred25: 0, pred50: 0, bias: 0, count: 0 };
  }

  let sumAbsPctErr = 0;
  let sumMre = 0;
  let within25 = 0;
  let within50 = 0;
  let sumBias = 0;

  for (let i = 0; i < n; i++) {
    const pred = predictions[i]!;
    const act = actuals[i]!;
    const absErr = Math.abs(pred - act);
    const relErr = absErr / act;

    sumAbsPctErr += relErr * 100;
    sumMre += relErr;
    if (relErr <= 0.25) within25++;
    if (relErr <= 0.50) within50++;
    sumBias += (pred - act) / act;
  }

  return {
    name,
    mape: Math.round((sumAbsPctErr / n) * 100) / 100,
    mmre: Math.round((sumMre / n) * 1000) / 1000,
    pred25: Math.round((within25 / n) * 1000) / 1000,
    pred50: Math.round((within50 / n) * 1000) / 1000,
    bias: Math.round((sumBias / n) * 10000) / 100,
    count: n,
  };
}

// ---- Main validation -------------------------------------------------------

export function cocomoValidateGroundTruth(params?: {
  datasetFilter?: string[];
}): ToolResult<CocomoGroundTruthResult> {
  const datasets = getCocomoProjects();

  if (datasets.length === 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "No COCOMO calibration data available.",
        retryHint: "Ensure COCOMO calibration data files are present.",
      },
    };
  }

  const filtered = params?.datasetFilter
    ? datasets.filter((d) => params.datasetFilter!.includes(d.name))
    : datasets;

  const projects: PerProjectResult[] = [];

  for (const dataset of filtered) {
    for (const project of dataset.projects) {
      if (project.kloc <= 0 || project.effortPersonMonths <= 0) continue;

      const projectType = project.type ?? "semidetached";
      projects.push({
        id: project.id,
        kloc: project.kloc,
        actual: project.effortPersonMonths,
        dataset: dataset.name,
        type: projectType,
        models: predictAll(project.kloc, projectType),
      });
    }
  }

  if (projects.length === 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "No valid projects found (all had kloc <= 0 or effort <= 0).",
        retryHint: "Check that calibration datasets contain projects with positive kloc and effort.",
      },
    };
  }

  const actuals = projects.map((p) => p.actual);

  const modelEntries: Array<{ key: keyof PerProjectResult["models"]; label: string }> = [
    { key: "basic", label: "COCOMO Basic" },
    { key: "nominal", label: "COCOMO II Nominal" },
    { key: "aiSpeedup", label: "COCOMO II + AI 12x" },
    { key: "aiProfile0", label: "AI + Profile (human)" },
    { key: "aiProfile05", label: "AI + Profile (hybrid)" },
    { key: "aiProfile1", label: "AI + Profile (ai_native)" },
  ];

  const allMetrics: ModelMetrics[] = modelEntries.map(({ key, label }) =>
    computeMetrics(projects.map((p) => p.models[key]), actuals, label),
  );

  // Best model by MAPE
  const winner = allMetrics.reduce((best, m) => (m.mape < best.mape ? m : best));

  // Per-dataset breakdown
  const datasetGroups = new Map<string, PerProjectResult[]>();
  for (const p of projects) {
    if (!datasetGroups.has(p.dataset)) datasetGroups.set(p.dataset, []);
    datasetGroups.get(p.dataset)!.push(p);
  }

  const byDataset: CocomoGroundTruthResult["byDataset"] = {};
  for (const [dsName, dsProjects] of datasetGroups) {
    const dsActuals = dsProjects.map((p) => p.actual);
    let bestModel = "";
    let bestMape = Infinity;
    for (const { key, label } of modelEntries) {
      const m = computeMetrics(dsProjects.map((p) => p.models[key]), dsActuals, label);
      if (m.mape < bestMape) {
        bestMape = m.mape;
        bestModel = label;
      }
    }
    byDataset[dsName] = { count: dsProjects.length, bestModel, bestMape: Math.round(bestMape * 100) / 100 };
  }

  // Per-type breakdown
  const typeGroups = new Map<string, PerProjectResult[]>();
  for (const p of projects) {
    if (!typeGroups.has(p.type)) typeGroups.set(p.type, []);
    typeGroups.get(p.type)!.push(p);
  }

  const byType: CocomoGroundTruthResult["byType"] = {};
  for (const [typeName, typeProjects] of typeGroups) {
    const typeActuals = typeProjects.map((p) => p.actual);
    let bestModel = "";
    let bestMape = Infinity;
    for (const { key, label } of modelEntries) {
      const m = computeMetrics(typeProjects.map((p) => p.models[key]), typeActuals, label);
      if (m.mape < bestMape) {
        bestMape = m.mape;
        bestModel = label;
      }
    }
    byType[typeName] = { count: typeProjects.length, bestModel, bestMape: Math.round(bestMape * 100) / 100 };
  }

  const modelTable = allMetrics
    .map((m) => `  ${m.name}: MAPE=${m.mape}%, MMRE=${m.mmre}, PRED(25)=${m.pred25}, PRED(50)=${m.pred50}, bias=${m.bias}%`)
    .join("\n");

  const aiModels = allMetrics.filter((m) => m.name.includes("AI"));
  const bestAi = aiModels.reduce((best, m) => (m.mape < best.mape ? m : best), aiModels[0]!);
  const traditionalBest = allMetrics.filter((m) => !m.name.includes("AI"))
    .reduce((best, m) => (m.mape < best.mape ? m : best));

  const conclusion = allMetrics.find((m) => m.name === "COCOMO II + AI 12x")!.pred25 < 0.05
    ? `Best model: ${winner.name} (MAPE=${winner.mape}%). WARNING: The 12x AI speedup divisor produces catastrophic underprediction (PRED(25)=0%, bias=${allMetrics.find((m) => m.name === "COCOMO II + AI 12x")!.bias}%). These are pre-LLM projects — the speedup factor needs empirical validation against modern AI-assisted project data, not historical human-only data. Best traditional model: ${traditionalBest.name} at ${traditionalBest.mape}% MAPE.`
    : `Best model: ${winner.name} (MAPE=${winner.mape}%). AI speedup models show ${bestAi.pred25 > traditionalBest.pred25 ? "better" : "comparable"} PRED(25) vs traditional COCOMO.`;

  const humanReadable = [
    `COCOMO Ground Truth Validation: ${projects.length} projects evaluated.`,
    "Model Comparison:",
    modelTable,
    "",
    `By Dataset: ${Object.entries(byDataset).map(([n, d]) => `${n}(${d.count}): ${d.bestModel} at ${d.bestMape}%`).join(" | ")}`,
    `By Type: ${Object.entries(byType).map(([n, d]) => `${n}(${d.count}): ${d.bestModel} at ${d.bestMape}%`).join(" | ")}`,
    "",
    conclusion,
  ].join("\n");

  return {
    ok: true,
    data: {
      projectsEvaluated: projects.length,
      models: allMetrics,
      byDataset,
      byType,
      winner: winner.name,
      conclusion,
      humanReadable,
    },
  };
}
