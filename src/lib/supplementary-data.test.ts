import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/home/test"),
}));

import { existsSync, readFileSync } from "node:fs";
import {
  loadSupplementaryData,
  loadCocomoData,
  getModelPricing,
  getHumanBaselines,
  getEstimationResearch,
  getAllModelPricing,
  getCocomoProjects,
  getCocomoDerivedFactors,
  resetSupplementaryCache,
} from "./supplementary-data.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const SAMPLE_SUPPLEMENTARY = JSON.stringify({
  version: "1.0.0",
  modelCalibration: {
    "claude-sonnet-4": {
      tokensPerSecond: 100,
      timeToFirstTokenMs: 200,
      avgApiLatencyMs: 500,
      costInput: 3,
      costOutput: 15,
    },
  },
  humanDeveloperBaselines: {
    featureDevTimeDays: { median: 14, p25: 7, p75: 28 },
    bugfixTimeHours: { median: 72, p25: 24, p75: 168 },
    sprintVelocityPoints: { median: 35, p25: 20, p75: 50 },
    commitsPerDayPerDeveloper: { median: 5, p25: 2, p75: 10 },
    prsPerWeekPerDeveloper: { median: 2, p25: 1, p75: 4 },
    activeCodingMinutesPerDay: { median: 240 },
  },
  estimationAccuracyResearch: {
    expertEstimatesWithinPercent: 22,
    taskLevelMRE: { features: 0.55, bugfixes: 0.60 },
    underestimationRate: 52.0,
    averageScheduleOverrunPercent: 150,
  },
  toolCallOverheadMs: 150,
});

const SAMPLE_COCOMO = JSON.stringify({
  cocomoCalibration: {
    datasets: [
      {
        name: "test-dataset",
        projects: [
          { id: 1, kloc: 10, effortPersonMonths: 30, type: "organic" },
        ],
      },
    ],
    derivedFactors: {
      cocomoBasic: {
        organic: { a: 2.4, b: 1.05, c: 2.5, d: 0.38 },
      },
      productivityKlocPerPersonMonth: { median: 0.35, p25: 0.2, p75: 0.5 },
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSupplementaryCache();
  mockExistsSync.mockReturnValue(false);
});

// ---- loadSupplementaryData ----

describe("loadSupplementaryData", () => {
  it("returns null when no supplementary file exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadSupplementaryData()).toBeNull();
  });

  it("returns parsed data when file exists and is valid", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);
    const data = loadSupplementaryData();
    expect(data).not.toBeNull();
    expect(data!.version).toBe("1.0.0");
  });

  it("returns null when file has malformed JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not-json");
    expect(loadSupplementaryData()).toBeNull();
  });

  it("caches the result (returns same object on second call)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);
    const first = loadSupplementaryData();
    const second = loadSupplementaryData();
    expect(first).toBe(second);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---- loadCocomoData ----

describe("loadCocomoData", () => {
  it("returns null when no cocomo file exists", () => {
    expect(loadCocomoData()).toBeNull();
  });

  it("returns parsed data when cocomo file exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_COCOMO);
    const data = loadCocomoData();
    expect(data).not.toBeNull();
    expect(data!.cocomoCalibration.datasets).toHaveLength(1);
  });

  it("skips files without cocomoCalibration key", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "1.0.0" }));
    expect(loadCocomoData()).toBeNull();
  });

  it("continues to next path on parse error", () => {
    mockExistsSync.mockReturnValue(true);
    // First path: malformed JSON, second path: valid cocomo
    mockReadFileSync
      .mockReturnValueOnce("bad json")
      .mockReturnValueOnce(SAMPLE_COCOMO);
    const data = loadCocomoData();
    expect(data).not.toBeNull();
  });
});

// ---- getModelPricing ----

describe("getModelPricing", () => {
  it("returns pricing for a known model", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);
    const pricing = getModelPricing("claude-sonnet-4")!;
    expect(pricing).not.toBeNull();
    expect(pricing.costInput).toBe(3);
    expect(pricing.costOutput).toBe(15);
    expect(pricing.tokensPerSecond).toBe(100);
  });

  it("returns null for unknown model", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);
    expect(getModelPricing("nonexistent-model")).toBeNull();
  });

  it("returns null when no data loaded", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getModelPricing("claude-sonnet-4")).toBeNull();
  });
});

// ---- getHumanBaselines ----

describe("getHumanBaselines", () => {
  it("returns baselines when present", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);
    const baselines = getHumanBaselines()!;
    expect(baselines.featureDevTimeDays.median).toBe(14);
    expect(baselines.bugfixTimeHours.median).toBe(72);
    expect(baselines.sprintVelocityPoints.median).toBe(35);
  });

  it("returns null when no data loaded", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getHumanBaselines()).toBeNull();
  });
});

// ---- getEstimationResearch ----

describe("getEstimationResearch", () => {
  it("returns research data when loaded", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);
    const research = getEstimationResearch();
    expect(research.expertEstimatesWithinPercent).toBe(22);
    expect(research.underestimationRate).toBe(52.0);
  });

  it("returns hardcoded defaults when no data loaded", () => {
    mockExistsSync.mockReturnValue(false);
    const research = getEstimationResearch();
    expect(research.expertEstimatesWithinPercent).toBe(25);
    expect(research.underestimationRate).toBe(57.5);
    expect(research.averageScheduleOverrunPercent).toBe(189);
  });
});

// ---- getAllModelPricing ----

describe("getAllModelPricing", () => {
  it("returns base pricing when no community data", () => {
    mockExistsSync.mockReturnValue(false);
    // Load supplementary first
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);
    resetSupplementaryCache();

    const pricing = getAllModelPricing();
    expect(pricing["claude-sonnet-4"]).toBeDefined();
    expect(pricing["claude-sonnet-4"]!.costInput).toBe(3);
  });

  it("returns empty object when no data at all", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getAllModelPricing()).toEqual({});
  });
});

// ---- getCocomoProjects ----

describe("getCocomoProjects", () => {
  it("returns datasets when loaded", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_COCOMO);
    const projects = getCocomoProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe("test-dataset");
  });

  it("returns empty array when no data", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getCocomoProjects()).toEqual([]);
  });
});

// ---- getCocomoDerivedFactors ----

describe("getCocomoDerivedFactors", () => {
  it("returns factors when present", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_COCOMO);
    const factors = getCocomoDerivedFactors()!;
    expect(factors).not.toBeNull();
    expect(factors.cocomoBasic.organic?.a).toBe(2.4);
    expect(factors.productivityKlocPerPersonMonth.median).toBe(0.35);
  });

  it("returns null when no data", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getCocomoDerivedFactors()).toBeNull();
  });
});

// ---- resetSupplementaryCache ----

describe("resetSupplementaryCache", () => {
  it("clears cache so data is re-loaded on next call", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_SUPPLEMENTARY);

    loadSupplementaryData();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    resetSupplementaryCache();
    loadSupplementaryData();
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });
});
