import { describe, it, expect, vi } from "vitest";
import { computeAccuracyTrend } from "./accuracy-trend.js";

vi.mock("./feedback.js", () => ({
  getCalibrationData: vi.fn(),
}));

vi.mock("./supplementary-data.js", () => ({
  getEstimationResearch: vi.fn(() => ({
    expertEstimatesWithinPercent: 25,
    taskLevelMRE: { features: 0.63, bugfixes: 0.70, refactoring: 0.43 },
    underestimationRate: 57.5,
    averageScheduleOverrunPercent: 189,
  })),
}));

import { getCalibrationData } from "./feedback.js";

const mockGetCalibrationData = vi.mocked(getCalibrationData);

function makeRecords(count: number, errorFn: (i: number) => number): Array<{
  taskType: string;
  estimatedHours: number;
  actualHours: number;
  completedAt: string;
}> {
  return Array.from({ length: count }, (_, i) => {
    const estimated = 10;
    const error = errorFn(i);
    return {
      taskType: "feature",
      estimatedHours: estimated,
      actualHours: Math.round((estimated * (1 + error / 100)) * 10) / 10,
      completedAt: new Date(2026, 0, i + 1).toISOString(),
    };
  });
}

describe("computeAccuracyTrend", () => {
  it("returns zeroes for empty data", () => {
    mockGetCalibrationData.mockReturnValue([]);
    const result = computeAccuracyTrend();
    expect(result.totalEstimates).toBe(0);
    expect(result.totalWithActuals).toBe(0);
    expect(result.windows).toEqual([]);
    expect(result.currentMape).toBe(0);
    expect(result.industryBaselineMape).toBe(25);
  });

  it("computes MAPE per window", () => {
    // 100 records with 50% error -> should produce 2 windows of 50
    const records = makeRecords(100, () => 50);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    expect(result.windows.length).toBeGreaterThanOrEqual(2);
    expect(result.totalEstimates).toBe(100);
    for (const w of result.windows) {
      expect(w.sampleSize).toBeGreaterThan(0);
      expect(w.mape).toBeGreaterThan(0);
    }
  });

  it("detects improving trend", () => {
    // First 50: 60% error (dates Jan 1 - Feb 19), last 50: 10% error (dates Feb 20 - Apr 9)
    const highError = makeRecords(50, () => 60);
    const lowError = makeRecords(50, () => 10).map((r, i) => ({
      ...r,
      completedAt: new Date(2026, 1, i + 20).toISOString(),
    }));
    const records = highError.concat(lowError);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    expect(result.overallTrend).toBe("improving");
    expect(result.currentMape).toBeLessThan(result.windows[0]!.mape);
  });

  it("detects stable trend", () => {
    // Uniform 30% error across all records
    const records = makeRecords(100, () => 30);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    expect(result.overallTrend).toBe("stable");
  });

  it("detects degrading trend", () => {
    const lowError = makeRecords(50, () => 10);
    const highError = makeRecords(50, () => 80).map((r, i) => ({
      ...r,
      completedAt: new Date(2026, 1, i + 20).toISOString(),
    }));
    const records = lowError.concat(highError);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    expect(result.overallTrend).toBe("degrading");
    expect(result.currentMape).toBeGreaterThan(result.windows[0]!.mape);
  });

  it("industry baseline is 25%", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(5, () => 10));
    const result = computeAccuracyTrend();
    expect(result.industryBaselineMape).toBe(25);
  });
});
