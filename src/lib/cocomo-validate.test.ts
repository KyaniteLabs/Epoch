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
});
