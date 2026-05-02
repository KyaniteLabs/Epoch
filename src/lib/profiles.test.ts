import { describe, it, expect, vi } from "vitest";
import { getDeveloperProfile } from "./profiles.js";

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

describe("getDeveloperProfile", () => {
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
