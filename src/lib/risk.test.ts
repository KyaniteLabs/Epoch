import { describe, it, expect, vi } from "vitest";
import { scheduleRisk } from "./risk.js";

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

function makeRecords(count: number, errorPercent: number): Array<{
  taskType: string;
  estimatedHours: number;
  actualHours: number;
  completedAt: string;
}> {
  return Array.from({ length: count }, (_, i) => ({
    taskType: "feature",
    estimatedHours: 10,
    actualHours: Math.round(10 * (1 + errorPercent / 100) * 10) / 10,
    completedAt: new Date(2026, 0, i + 1).toISOString(),
  }));
}

describe("scheduleRisk", () => {
  it("uses industry baseline when no history", () => {
    mockGetCalibrationData.mockReturnValue([]);
    const result = scheduleRisk({ estimatedHours: 40 });
    expect(result.historicalAccuracy.mape).toBe(25);
    expect(result.riskLevel).toBe("medium");
  });

  it("computes risk from historical data", () => {
    // 10 records with ~30% error -> MAPE ~30, risk = medium
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 20 });
    expect(result.historicalAccuracy.mape).toBeGreaterThan(0);
    expect(result.historicalAccuracy.sampleSize).toBe(10);
    expect(result.riskLevel).toBeDefined();
  });

  it("confidence intervals widen with higher MAPE", () => {
    // Low error: MAPE ~10
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 10));
    const lowRisk = scheduleRisk({ estimatedHours: 40 });

    // High error: MAPE ~50
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 50));
    const highRisk = scheduleRisk({ estimatedHours: 40 });

    expect(highRisk.confidenceIntervals.p95).toBeGreaterThan(lowRisk.confidenceIntervals.p95);
  });

  it("low risk for accurate history", () => {
    // 10 records with ~5% error -> MAPE ~5, risk = low
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 5));
    const result = scheduleRisk({ estimatedHours: 16 });
    expect(result.riskLevel).toBe("low");
  });

  it("critical risk for very inaccurate history", () => {
    // 10 records with 150% error -> actual=25, MAPE = |25-10|/25*100 = 60% > 50 -> critical
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 150));
    const result = scheduleRisk({ estimatedHours: 8 });
    expect(result.riskLevel).toBe("critical");
  });
});
