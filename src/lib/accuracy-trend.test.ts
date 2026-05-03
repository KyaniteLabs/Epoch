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

  it("computes MAPE and MdAPE per window", () => {
    // 100 records with 50% error -> should produce 2 windows of 50
    const records = makeRecords(100, () => 50);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    expect(result.windows.length).toBeGreaterThanOrEqual(2);
    expect(result.totalEstimates).toBe(100);
    for (const w of result.windows) {
      expect(w.sampleSize).toBeGreaterThan(0);
      expect(w.mape).toBeGreaterThan(0);
      expect(w.mdape).toBeGreaterThan(0);
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

  it("includes dateRange in each window", () => {
    const records = makeRecords(100, () => 30);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    for (const w of result.windows) {
      expect(w.dateRange).toBeDefined();
      expect(w.dateRange).toContain(" to ");
      // Date format: YYYY-MM-DD
      expect(w.dateRange).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    }
  });

  it("dateRange spans first to last record in each window", () => {
    const records = makeRecords(100, () => 20);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    // First window: records 0-49, dates Jan 1 - Feb 19
    expect(result.windows[0]!.dateRange).toContain("2026-01-01");
    // Second window: records 50-99, dates Feb 20 - Apr 10
    expect(result.windows[1]!.dateRange).toContain("2026-02-20");
  });

  it("redistributes windows to avoid tiny last window", () => {
    // 120 records with windowSize=50 → would give [50, 50, 20]
    // Adaptive should redistribute to more even windows
    const records = makeRecords(120, () => 20);
    mockGetCalibrationData.mockReturnValue(records);
    const result = computeAccuracyTrend({ windowSize: 50 });
    const lastWindow = result.windows[result.windows.length - 1]!;
    // Last window should have at least half the normal size (25)
    expect(lastWindow.sampleSize).toBeGreaterThanOrEqual(25);
  });

  it("handles records with undefined completedAt without crashing", () => {
    const records = Array.from({ length: 15 }, (_, i) => ({
      taskType: "feature",
      estimatedHours: 5 + i,
      actualHours: 4 + i,
      completedAt: i % 3 === 0 ? (undefined as unknown as string) : `2026-01-${10 + i}T00:00:00Z`,
    }));
    mockGetCalibrationData.mockReturnValue(records as any);
    const result = computeAccuracyTrend({ windowSize: 50 });
    expect(result.windows.length).toBeGreaterThanOrEqual(1);
    expect(result.overallTrend).toBeDefined();
  });
});
