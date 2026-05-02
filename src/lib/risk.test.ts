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

  it("confidence intervals widen with higher MAPE", () => {
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
});
