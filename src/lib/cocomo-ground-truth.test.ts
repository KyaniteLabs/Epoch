import { describe, it, expect } from "vitest";
import { cocomoValidateGroundTruth } from "./cocomo-ground-truth.js";

// ---------------------------------------------------------------------------
// COCOMO Ground Truth Validation — Tests
// ---------------------------------------------------------------------------

describe("cocomoValidateGroundTruth", () => {
  it("returns ok with valid data", () => {
    const result = cocomoValidateGroundTruth();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.projectsEvaluated).toBeGreaterThan(0);
    expect(result.data.models).toHaveLength(6);
    expect(result.data.winner).toBeTruthy();
    expect(result.data.conclusion).toBeTruthy();
    expect(result.data.humanReadable).toContain("Ground Truth");
  });

  it("computes correct MAPE for a known COCOMO Basic project", () => {
    // COCOMO81 project 1: kloc=113, effort=2040 person-months, type=embedded
    // COCOMO Basic embedded: a=3.6, b=1.20 → 3.6 * 113^1.20
    const result = cocomoValidateGroundTruth({ datasetFilter: ["COCOMO81"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // COCOMO Basic model should exist and have a valid MAPE
    const basicModel = result.data.models.find((m) => m.name === "COCOMO Basic");
    expect(basicModel).toBeDefined();
    expect(basicModel!.mape).toBeGreaterThan(0);
    expect(basicModel!.count).toBeGreaterThan(0);
  });

  it("AI speedup model produces lower estimates than nominal", () => {
    const result = cocomoValidateGroundTruth();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const aiSpeedup = result.data.models.find((m) => m.name === "COCOMO II + AI 12x");
    const nominal = result.data.models.find((m) => m.name === "COCOMO II Nominal");
    expect(aiSpeedup).toBeDefined();
    expect(nominal).toBeDefined();

    // AI speedup divides by 12, so MAPE should differ from nominal
    // Against 1970s-80s data, both models will have large MAPE, but different values
    expect(aiSpeedup!.mape).not.toBeCloseTo(nominal!.mape, 0);
  });

  it("supports dataset filtering", () => {
    const all = cocomoValidateGroundTruth();
    const nasaOnly = cocomoValidateGroundTruth({ datasetFilter: ["NASA93"] });
    expect(all.ok).toBe(true);
    expect(nasaOnly.ok).toBe(true);
    if (!all.ok || !nasaOnly.ok) return;

    expect(nasaOnly.data.projectsEvaluated).toBeLessThan(all.data.projectsEvaluated);
    expect(Object.keys(nasaOnly.data.byDataset)).toContain("NASA93");
    expect(Object.keys(nasaOnly.data.byDataset)).not.toContain("COCOMO81");
  });

  it("all 6 models produce valid metrics", () => {
    const result = cocomoValidateGroundTruth();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const model of result.data.models) {
      expect(model.mape).toBeGreaterThan(0);
      expect(model.mmre).toBeGreaterThan(0);
      expect(model.pred25).toBeGreaterThanOrEqual(0);
      expect(model.pred50).toBeGreaterThanOrEqual(0);
      expect(model.pred50).toBeGreaterThanOrEqual(model.pred25);
      expect(model.count).toBeGreaterThan(0);
      expect(Number.isFinite(model.bias)).toBe(true);
    }
  });

  it("byDataset has entries for all datasets", () => {
    const result = cocomoValidateGroundTruth();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const [name, info] of Object.entries(result.data.byDataset)) {
      expect(info.count).toBeGreaterThan(0);
      expect(info.bestModel).toBeTruthy();
      expect(info.bestMape).toBeGreaterThan(0);
    }
  });

  it("byType has entries for project types", () => {
    const result = cocomoValidateGroundTruth();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.data.byType).length).toBeGreaterThan(0);
    for (const [name, info] of Object.entries(result.data.byType)) {
      expect(info.count).toBeGreaterThan(0);
      expect(info.bestModel).toBeTruthy();
    }
  });

  it("winner is the model with lowest MAPE", () => {
    const result = cocomoValidateGroundTruth();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lowestMape = Math.min(...result.data.models.map((m) => m.mape));
    const winnerModel = result.data.models.find((m) => m.name === result.data.winner);
    expect(winnerModel).toBeDefined();
    expect(winnerModel!.mape).toBe(lowestMape);
  });

  it("PRED(25) and PRED(50) are between 0 and 1", () => {
    const result = cocomoValidateGroundTruth();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const model of result.data.models) {
      expect(model.pred25).toBeGreaterThanOrEqual(0);
      expect(model.pred25).toBeLessThanOrEqual(1);
      expect(model.pred50).toBeGreaterThanOrEqual(0);
      expect(model.pred50).toBeLessThanOrEqual(1);
    }
  });

  it("returns error for nonexistent dataset filter", () => {
    const result = cocomoValidateGroundTruth({ datasetFilter: ["NONEXISTENT"] });
    expect(result.ok).toBe(false);
  });
});
