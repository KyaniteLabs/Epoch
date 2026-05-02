import { describe, it, expect, vi } from "vitest";
import { getDeveloperProfile, getDeveloperProfileGradient } from "./profiles.js";

vi.mock("./self-improve.js", () => ({
  getGlobalCorrectionFactor: vi.fn(),
}));

vi.mock("./supplementary-data.js", () => ({
  getHumanBaselines: vi.fn(),
  getEstimationResearch: vi.fn(),
}));

import { getGlobalCorrectionFactor } from "./self-improve.js";
import { getHumanBaselines, getEstimationResearch } from "./supplementary-data.js";

const mockGetGlobalCorrectionFactor = vi.mocked(getGlobalCorrectionFactor);
const mockGetHumanBaselines = vi.mocked(getHumanBaselines);
const mockGetEstimationResearch = vi.mocked(getEstimationResearch);

describe("getDeveloperProfile (deprecated wrapper)", () => {
  it("AI-native profile has faster dev time", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);

    const profile = getDeveloperProfile(true);

    expect(profile.featureDevTimeDays).toBeLessThan(10);
  });

  it("AI-native profile has lower estimation MAPE", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);

    const profile = getDeveloperProfile(true);

    expect(profile.estimationMape).toBeLessThan(20);
  });

  it("Human profile uses human baselines", () => {
    mockGetHumanBaselines.mockReturnValue({
      featureDevTimeDays: { median: 12, p25: 8, p75: 18 },
      bugfixTimeHours: { median: 48, p25: 24, p75: 96 },
      sprintVelocityPoints: { median: 30, p25: 20, p75: 40 },
      commitsPerDayPerDeveloper: { median: 4, p25: 2, p75: 6 },
      prsPerWeekPerDeveloper: { median: 2, p25: 1, p75: 3 },
      activeCodingMinutesPerDay: { median: 240 },
    });
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 30,
      taskLevelMRE: { features: 0.6, bugfixes: 0.7 },
      underestimationRate: 60,
      averageScheduleOverrunPercent: 180,
    });

    const profile = getDeveloperProfile(false);

    expect(profile.featureDevTimeDays).toBe(12);
    expect(profile.bugfixTimeHours).toBe(48);
    expect(profile.sprintVelocityPoints).toBe(30);
    expect(profile.estimationMape).toBe(30);
  });

  it("Human profile has higher correction factor", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const aiProfile = getDeveloperProfile(true);
    const humanProfile = getDeveloperProfile(false);

    expect(humanProfile.correctionFactor).toBeGreaterThan(aiProfile.correctionFactor);
  });

  it("AI-native mode is default", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);

    const profile = getDeveloperProfile(true);

    expect(profile.mode).toBe("ai_native");
  });

  it("Human mode returns correct mode", () => {
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const profile = getDeveloperProfile(false);

    expect(profile.mode).toBe("human");
  });
});

describe("getDeveloperProfileGradient", () => {
  it("returns ai_native mode at ratio 1.0", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);

    const profile = getDeveloperProfileGradient(1.0);

    expect(profile.mode).toBe("ai_native");
    expect(profile.aiRatio).toBe(1.0);
  });

  it("returns human mode at ratio 0.0", () => {
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const profile = getDeveloperProfileGradient(0.0);

    expect(profile.mode).toBe("human");
    expect(profile.aiRatio).toBe(0.0);
  });

  it("returns hybrid mode at ratio 0.5", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const profile = getDeveloperProfileGradient(0.5);

    expect(profile.mode).toBe("hybrid");
    expect(profile.aiRatio).toBe(0.5);
  });

  it("interpolates featureDevTimeDays between human and AI", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const human = getDeveloperProfileGradient(0.0);
    const ai = getDeveloperProfileGradient(1.0);
    const hybrid = getDeveloperProfileGradient(0.5);

    // AI = 0.72, Human = 14.0 → hybrid midpoint ≈ 7.36
    expect(hybrid.featureDevTimeDays).toBeGreaterThan(ai.featureDevTimeDays);
    expect(hybrid.featureDevTimeDays).toBeLessThan(human.featureDevTimeDays);
    expect(hybrid.featureDevTimeDays).toBeCloseTo(7.36, 1);
  });

  it("interpolates MAPE linearly", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const hybrid = getDeveloperProfileGradient(0.5);

    // AI = 15%, Human = 25% → hybrid = 20%
    expect(hybrid.estimationMape).toBe(20);
  });

  it("interpolates correction factor linearly", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const hybrid = getDeveloperProfileGradient(0.5);

    // AI = 1.07, Human = 1.8 → hybrid = 1.435 → rounded 1.44
    expect(hybrid.correctionFactor).toBeGreaterThan(1.07);
    expect(hybrid.correctionFactor).toBeLessThan(1.8);
  });

  it("clamps values outside 0-1 range", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);

    const above = getDeveloperProfileGradient(5.0);
    const below = getDeveloperProfileGradient(-2.0);

    expect(above.aiRatio).toBe(1.0);
    expect(above.mode).toBe("ai_native");
    expect(below.aiRatio).toBe(0.0);
    expect(below.mode).toBe("human");
  });

  it("gradient at 0.25 is between human and midpoint", () => {
    mockGetGlobalCorrectionFactor.mockReturnValue(1.07);
    mockGetHumanBaselines.mockReturnValue(null);
    mockGetEstimationResearch.mockReturnValue({
      expertEstimatesWithinPercent: 25,
      taskLevelMRE: {},
      underestimationRate: 57.5,
      averageScheduleOverrunPercent: 189,
    });

    const human = getDeveloperProfileGradient(0.0);
    const q1 = getDeveloperProfileGradient(0.25);
    const mid = getDeveloperProfileGradient(0.5);

    // 0.25 → MAPE = 15*0.25 + 25*0.75 = 22.5
    expect(q1.estimationMape).toBe(22.5);
    expect(q1.estimationMape).toBeGreaterThan(mid.estimationMape);
    expect(q1.estimationMape).toBeLessThan(human.estimationMape);
  });
});
