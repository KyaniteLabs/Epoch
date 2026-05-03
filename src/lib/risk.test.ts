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

vi.mock("./profiles.js", () => ({
  getDeveloperProfileGradient: vi.fn((aiRatio: number) => ({
    mode: aiRatio >= 1.0 ? "ai_native" : aiRatio <= 0.0 ? "human" : "hybrid",
    aiRatio,
    featureDevTimeDays: aiRatio >= 1.0 ? 0.72 : 14 * (1 - aiRatio) + 0.72 * aiRatio,
    bugfixTimeHours: aiRatio >= 1.0 ? 6.15 : 72 * (1 - aiRatio) + 6.15 * aiRatio,
    sprintVelocityPoints: 80,
    estimationMape: 15 * aiRatio + 25 * (1 - aiRatio),
    underestimationBias: 0.2 * aiRatio + 0.575 * (1 - aiRatio),
    correctionFactor: 1.07 * aiRatio + 1.8 * (1 - aiRatio),
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
    expect(result.historicalAccuracy.mape).toBe(15);
    expect(result.riskLevel).toBe("low");
  });

  it("computes risk from historical data", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 20 });
    expect(result.historicalAccuracy.mape).toBeGreaterThan(0);
    expect(result.historicalAccuracy.sampleSize).toBe(10);
    expect(result.riskLevel).toBeDefined();
  });

  it("confidence intervals widen with higher MdAPE", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 10));
    const lowRisk = scheduleRisk({ estimatedHours: 40 });

    mockGetCalibrationData.mockReturnValue(makeRecords(10, 50));
    const highRisk = scheduleRisk({ estimatedHours: 40 });

    expect(highRisk.confidenceIntervals.p95).toBeGreaterThan(lowRisk.confidenceIntervals.p95);
  });

  it("low risk for accurate history", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 5));
    const result = scheduleRisk({ estimatedHours: 16 });
    expect(result.riskLevel).toBe("low");
  });

  it("critical risk for very inaccurate history", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 150));
    const result = scheduleRisk({ estimatedHours: 8 });
    expect(result.riskLevel).toBe("critical");
  });

  it("hybrid mode (0.5) interpolates MAPE between AI and human", () => {
    mockGetCalibrationData.mockReturnValue([]);
    const result = scheduleRisk({ estimatedHours: 40, aiNative: 0.5 });
    // MAPE should be 20 (midpoint between AI=15 and human=25)
    expect(result.historicalAccuracy.mape).toBe(20);
  });

  it("human mode (0.0) uses higher MAPE baseline", () => {
    mockGetCalibrationData.mockReturnValue([]);
    const result = scheduleRisk({ estimatedHours: 40, aiNative: 0.0 });
    expect(result.historicalAccuracy.mape).toBe(25);
  });

  it("risk level uses MdAPE (outlier-robust)", () => {
    // 5 records with 10% error, 5 records with 10% error, but one massive outlier
    // Using actual-based APE: |actual-est|/actual
    // 9 records: est=10, actual=11 → APE=9.09%
    // 1 outlier: est=10, actual=510 → APE=98.04%
    const records = makeRecords(9, 10);
    records.push({
      taskType: "feature",
      estimatedHours: 10,
      actualHours: 510,
      completedAt: new Date(2026, 0, 10).toISOString(),
    });
    mockGetCalibrationData.mockReturnValue(records);
    const result = scheduleRisk({ estimatedHours: 20 });
    // MdAPE is median of ~9% values, so risk should be low (<20)
    expect(result.riskLevel).toBe("low");
    // MAPE pulled up by outlier but MdAPE stays low
    expect(result.humanReadable).toContain("MdAPE:");
  });

  it("humanReadable includes MdAPE", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 20 });
    expect(result.humanReadable).toContain("MdAPE:");
    expect(result.humanReadable).toContain("MAPE:");
  });

  it("humanReadable includes task type label when provided", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 20, taskType: "feature" });
    expect(result.humanReadable).toContain("for feature");
  });

  it("humanReadable omits task type label when not provided", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 20 });
    expect(result.humanReadable).not.toContain("for ");
    expect(result.humanReadable).toContain("Schedule risk:");
  });

  it("high complexity widens confidence intervals", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const normal = scheduleRisk({ estimatedHours: 40 });
    const complex = scheduleRisk({ estimatedHours: 40, complexity: 5 });

    expect(complex.confidenceIntervals.p95).toBeGreaterThan(normal.confidenceIntervals.p95);
    expect(complex.confidenceIntervals.p80).toBeGreaterThan(normal.confidenceIntervals.p80);
    // p50 (median) stays the same regardless of complexity
    expect(complex.confidenceIntervals.p50).toBe(normal.confidenceIntervals.p50);
  });

  it("low complexity (1-3) does not widen intervals", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const normal = scheduleRisk({ estimatedHours: 40 });
    const simple = scheduleRisk({ estimatedHours: 40, complexity: 2 });

    expect(simple.confidenceIntervals.p95).toBe(normal.confidenceIntervals.p95);
  });

  it("humanReadable includes complexity label when provided", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 20, complexity: 4 });
    expect(result.humanReadable).toContain("complexity 4");
  });

  it("humanReadable omits complexity label when not provided", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 20 });
    expect(result.humanReadable).not.toContain("complexity");
  });

  it("includes taskTypeBreakdown with multiple task types", () => {
    const records = [
      ...makeRecords(5, 10), // feature, low risk (mdape ~10)
      ...Array.from({ length: 5 }, (_, i) => ({
        taskType: "bugfix",
        estimatedHours: 10,
        actualHours: Math.round(10 * 3.0 * 10) / 10, // 200% over → actual=30, error=|30-10|/30=66.7% → critical
        completedAt: new Date(2026, 0, i + 1).toISOString(),
      })),
    ];
    mockGetCalibrationData.mockReturnValue(records);
    const result = scheduleRisk({ estimatedHours: 20 });
    expect(result.taskTypeBreakdown).toBeDefined();
    expect(result.taskTypeBreakdown!["feature"]).toBeDefined();
    expect(result.taskTypeBreakdown!["feature"]!.riskLevel).toBe("low");
    expect(result.taskTypeBreakdown!["bugfix"]).toBeDefined();
    expect(result.taskTypeBreakdown!["bugfix"]!.riskLevel).toBe("critical");
  });

  it("omits task types with fewer than 3 records from breakdown", () => {
    const records = [
      ...makeRecords(5, 20),
      { taskType: "migration", estimatedHours: 10, actualHours: 15, completedAt: new Date().toISOString() },
    ];
    mockGetCalibrationData.mockReturnValue(records);
    const result = scheduleRisk({ estimatedHours: 20 });
    expect(result.taskTypeBreakdown).toBeDefined();
    expect(result.taskTypeBreakdown!["migration"]).toBeUndefined();
    expect(result.taskTypeBreakdown!["feature"]).toBeDefined();
  });

  it("includes estimatedTokenCost (estimatedHours × 50000)", () => {
    mockGetCalibrationData.mockReturnValue(makeRecords(10, 30));
    const result = scheduleRisk({ estimatedHours: 10 });
    expect(result.estimatedTokenCost).toBeGreaterThan(0);
    expect(result.estimatedTokenCost).toBeCloseTo(result.estimatedHours * 50000, -2);
  });
});
