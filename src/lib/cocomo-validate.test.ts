import { describe, it, expect, vi } from "vitest";
import { cocomoValidate } from "./cocomo-validate.js";

vi.mock("./supplementary-data.js", () => ({
  getCocomoProjects: vi.fn(),
  getCocomoDerivedFactors: vi.fn(),
}));

import { getCocomoProjects, getCocomoDerivedFactors } from "./supplementary-data.js";

const mockGetCocomoProjects = vi.mocked(getCocomoProjects);
const mockGetCocomoDerivedFactors = vi.mocked(getCocomoDerivedFactors);

describe("cocomoValidate", () => {
  it("returns error when no calibration data", () => {
    mockGetCocomoProjects.mockReturnValue([]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
      expect(result.error.message).toContain("COCOMO calibration data not found");
    }
  });

  it("validates against mock dataset", () => {
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "test-dataset",
        projects: [
          { id: 1, kloc: 10, effortPersonMonths: 24, type: "organic" },
          { id: 2, kloc: 20, effortPersonMonths: 50, type: "organic" },
          { id: 3, kloc: 5, effortPersonMonths: 15, type: "organic" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mape).toBeGreaterThan(0);
    expect(result.data.projectsEvaluated).toBe(3);
  });

  it("computes correct MAPE", () => {
    // organic: a=2.4, b=1.05 => predicted = 2.4 * 10^1.05 ≈ 26.9 PM
    const predictedEffort = 2.4 * Math.pow(10, 1.05);
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "exact-dataset",
        projects: [
          { id: 1, kloc: 10, effortPersonMonths: predictedEffort, type: "organic" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Prediction should be exact, so MAPE near 0
    expect(result.data.mape).toBeCloseTo(0, 1);
    expect(result.data.bias).toBeCloseTo(0, 1);
  });

  it("groups by project type", () => {
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "mixed-dataset",
        projects: [
          { id: 1, kloc: 10, effortPersonMonths: 24, type: "organic" },
          { id: 2, kloc: 15, effortPersonMonths: 60, type: "embedded" },
          { id: 3, kloc: 8, effortPersonMonths: 30, type: "semidetached" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.byProjectType).toHaveProperty("organic");
    expect(result.data.byProjectType).toHaveProperty("embedded");
    expect(result.data.byProjectType).toHaveProperty("semidetached");
    expect(result.data.byProjectType.organic!.count).toBe(1);
    expect(result.data.byProjectType.embedded!.count).toBe(1);
    expect(result.data.byProjectType.semidetached!.count).toBe(1);
  });

  it("respects dataset filter", () => {
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "dataset-a",
        projects: [
          { id: 1, kloc: 10, effortPersonMonths: 24, type: "organic" },
          { id: 2, kloc: 20, effortPersonMonths: 50, type: "organic" },
        ],
      },
      {
        name: "dataset-b",
        projects: [
          { id: 3, kloc: 30, effortPersonMonths: 80, type: "embedded" },
          { id: 4, kloc: 40, effortPersonMonths: 120, type: "embedded" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate({ datasetFilter: ["dataset-a"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only dataset-a's 2 projects should be evaluated
    expect(result.data.projectsEvaluated).toBe(2);
    // Should only have organic type
    expect(Object.keys(result.data.byProjectType)).toContain("organic");
    expect(Object.keys(result.data.byProjectType)).not.toContain("embedded");
  });

  // --- Uncovered branch tests ---

  it("returns error when all projects have kloc<=0 or effort<=0", () => {
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "bad-dataset",
        projects: [
          { id: 1, kloc: 0, effortPersonMonths: 10, type: "organic" },
          { id: 2, kloc: -5, effortPersonMonths: 20, type: "organic" },
          { id: 3, kloc: 10, effortPersonMonths: 0, type: "organic" },
          { id: 4, kloc: 10, effortPersonMonths: -1, type: "organic" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
      expect(result.error.message).toContain("No valid projects found");
    }
  });

  it("overrides coefficients when derived factors provide cocomoBasic", () => {
    // With custom a=1.0, b=1.0 => predicted = 1.0 * kloc^1.0 = kloc
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "derived-dataset",
        projects: [
          { id: 1, kloc: 50, effortPersonMonths: 50, type: "organic" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue({
      cocomoBasic: {
        organic: { a: 1.0, b: 1.0, c: 0, d: 0 },
      },
      productivityKlocPerPersonMonth: { median: 0, p25: 0, p75: 0 },
    });

    const result = cocomoValidate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // With a=1, b=1: predicted = 1 * 50^1 = 50, actual = 50 => MAPE = 0
    expect(result.data.mape).toBeCloseTo(0, 1);
  });

  it("recommends adjustment for organic type when MAPE > 30%", () => {
    // Use a very small effort to create large prediction error for organic
    // organic: a=2.4, b=1.05 => predicted = 2.4 * 100^1.05 ≈ 304 PM
    // Set actual effort very low to drive MAPE above 30%
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "high-error-organic",
        projects: [
          { id: 1, kloc: 100, effortPersonMonths: 10, type: "organic" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const organicAdj = result.data.recommendedAdjustments.find(
      (a) => a.parameter === "organic.a",
    );
    expect(organicAdj).toBeDefined();
    expect(organicAdj!.reason).toContain("Organic MAPE");
    expect(organicAdj!.reason).toContain("exceeding 30% threshold");
  });

  it("recommends adjustment for embedded type when MAPE > 30%", () => {
    // embedded: a=3.6, b=1.20 => predicted = 3.6 * 100^1.2 ≈ 571 PM
    // Set actual effort very low to drive MAPE above 30%
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "high-error-embedded",
        projects: [
          { id: 1, kloc: 100, effortPersonMonths: 10, type: "embedded" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const embeddedAdj = result.data.recommendedAdjustments.find(
      (a) => a.parameter === "embedded.b",
    );
    expect(embeddedAdj).toBeDefined();
    expect(embeddedAdj!.reason).toContain("Embedded MAPE");
    expect(embeddedAdj!.reason).toContain("exceeding 30% threshold");
  });

  it("recommends overall scale factor when absolute bias > 20%", () => {
    // organic: a=2.4, b=1.05
    // For kloc=100: predicted ≈ 304 PM. Use actual=150 to create positive bias.
    // Bias = (304-150)/150 * 100 ≈ 103%
    mockGetCocomoProjects.mockReturnValue([
      {
        name: "biased-dataset",
        projects: [
          { id: 1, kloc: 100, effortPersonMonths: 150, type: "organic" },
        ],
      },
    ]);
    mockGetCocomoDerivedFactors.mockReturnValue(null);

    const result = cocomoValidate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scaleAdj = result.data.recommendedAdjustments.find(
      (a) => a.parameter === "overall_scale_factor",
    );
    expect(scaleAdj).toBeDefined();
    expect(scaleAdj!.reason).toContain("Overall bias");
    expect(scaleAdj!.reason).toContain("exceeding 20% threshold");
  });
});
