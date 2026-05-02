import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([] as string[]),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/home/test"),
}));

import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  loadSupplementaryData,
  loadCocomoData,
  loadCommunityData,
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
const mockReaddirSync = vi.mocked(readdirSync) as unknown as ReturnType<typeof vi.fn> & { mockReturnValue: (v: string[]) => void };

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

// ---- loadCommunityData ----

const COMMUNITY_MODEL_CAL = JSON.stringify({
  _schema: "model-calibration",
  records: [
    {
      model: "community-model-x",
      tokens_per_second: 80,
      time_to_first_token_ms: 100,
      avg_api_latency_ms: 200,
      cost_input_per_million: 5000,
      cost_output_per_million: 15000,
      measured_at: "2026-01-01",
    },
  ],
});

const COMMUNITY_MODEL_CAL_OVERLAP = JSON.stringify({
  _schema: "model-calibration",
  records: [
    {
      model: "claude-sonnet-4",
      tokens_per_second: 1,
      time_to_first_token_ms: 1,
      avg_api_latency_ms: 1,
      cost_input_per_million: 1,
      cost_output_per_million: 1,
      measured_at: "2026-01-01",
    },
  ],
});

const COMMUNITY_COCOMO = JSON.stringify({
  _schema: "cocomo-project",
  records: [
    {
      name: "proj-a",
      kloc: 200,
      effort_person_months: 48,
      type: "business",
      language: "python",
      year: 2023,
    },
    {
      name: "proj-b",
      kloc: 50,
      effort_person_months: 10,
      type: "embedded",
    },
  ],
});

const COMMUNITY_BAD_SCHEMA = JSON.stringify({
  _schema: "unknown-schema",
  records: [{ foo: "bar" }],
});

const COMMUNITY_NO_RECORDS = JSON.stringify({
  _schema: "model-calibration",
  // no "records" key
});

const COMMUNITY_INVALID_JSON_CONTENT = "not-json-at-all";

describe("loadCommunityData", () => {
  it("returns empty data when community dir does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const data = loadCommunityData();
    expect(data.modelCalibration).toEqual([]);
    expect(data.cocomoProjects).toEqual([]);
  });

  it("loads community model calibration records", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["models.json"]);
    mockReadFileSync.mockReturnValue(COMMUNITY_MODEL_CAL);

    const data = loadCommunityData();
    expect(data.modelCalibration).toHaveLength(1);
    expect(data.modelCalibration[0]!.model).toBe("community-model-x");
  });

  it("loads cocomo community projects", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["cocomo.json"]);
    mockReadFileSync.mockReturnValue(COMMUNITY_COCOMO);

    const data = loadCommunityData();
    expect(data.cocomoProjects).toHaveLength(2);
    expect(data.cocomoProjects[0]!.name).toBe("proj-a");
  });

  it("skips files with unknown _schema", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["bad.json"]);
    mockReadFileSync.mockReturnValue(COMMUNITY_BAD_SCHEMA);

    const data = loadCommunityData();
    expect(data.modelCalibration).toEqual([]);
    expect(data.cocomoProjects).toEqual([]);
  });

  it("skips files without records array", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["no-records.json"]);
    mockReadFileSync.mockReturnValue(COMMUNITY_NO_RECORDS);

    const data = loadCommunityData();
    expect(data.modelCalibration).toEqual([]);
  });

  it("skips files with invalid JSON gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["broken.json", "good.json"]);
    mockReadFileSync
      .mockReturnValueOnce(COMMUNITY_INVALID_JSON_CONTENT)
      .mockReturnValueOnce(COMMUNITY_MODEL_CAL);

    const data = loadCommunityData();
    expect(data.modelCalibration).toHaveLength(1);
  });

  it("returns empty when readdirSync throws", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const data = loadCommunityData();
    expect(data.modelCalibration).toEqual([]);
  });

  it("caches community data (singleton)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["models.json"]);
    mockReadFileSync.mockReturnValue(COMMUNITY_MODEL_CAL);

    const first = loadCommunityData();
    const second = loadCommunityData();
    expect(first).toBe(second);
  });

  it("loads multiple community files merging into one result", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["models.json", "cocomo.json"]);
    mockReadFileSync
      .mockReturnValueOnce(COMMUNITY_MODEL_CAL)
      .mockReturnValueOnce(COMMUNITY_COCOMO);

    const data = loadCommunityData();
    expect(data.modelCalibration).toHaveLength(1);
    expect(data.cocomoProjects).toHaveLength(2);
  });
});

// ---- getAllModelPricing with community data ----

describe("getAllModelPricing with community", () => {
  it("augments with community model without overwriting base", () => {
    // Supplementary data exists
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync
      .mockReturnValueOnce(SAMPLE_SUPPLEMENTARY)    // loadSupplementaryData
      .mockReturnValueOnce(COMMUNITY_MODEL_CAL_OVERLAP); // loadCommunityData
    mockReaddirSync.mockReturnValue(["overlap.json"]);

    const all = getAllModelPricing();

    // Base model should retain its original values
    expect(all["claude-sonnet-4"]!.tokensPerSecond).toBe(100);
    expect(all["claude-sonnet-4"]!.costInput).toBe(3);
  });

  it("adds new community model not in base", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync
      .mockReturnValueOnce(SAMPLE_SUPPLEMENTARY)
      .mockReturnValueOnce(COMMUNITY_MODEL_CAL);
    mockReaddirSync.mockReturnValue(["models.json"]);

    const all = getAllModelPricing();

    expect(all["claude-sonnet-4"]).toBeDefined();
    expect(all["community-model-x"]).toBeDefined();
    expect(all["community-model-x"]!.tokensPerSecond).toBe(80);
    expect(all["community-model-x"]!.costInput).toBe(5000 / 1_000_000);
    expect(all["community-model-x"]!.costOutput).toBe(15000 / 1_000_000);
  });
});

// ---- getCocomoProjects with community data ----

describe("getCocomoProjects with community", () => {
  it("appends community dataset to base datasets", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync
      .mockReturnValueOnce(SAMPLE_COCOMO)    // loadCocomoData
      .mockReturnValueOnce(COMMUNITY_COCOMO); // loadCommunityData
    mockReaddirSync.mockReturnValue(["cocomo.json"]);

    const projects = getCocomoProjects();

    // Base dataset + community dataset
    expect(projects).toHaveLength(2);
    expect(projects[0]!.name).toBe("test-dataset");
    expect(projects[1]!.name).toBe("community");
    expect(projects[1]!.projects).toHaveLength(2);
    // Community projects get id offset 10000+
    expect(projects[1]!.projects[0]!.id).toBe(10000);
    expect(projects[1]!.projects[0]!.kloc).toBe(200);
    expect(projects[1]!.projects[1]!.id).toBe(10001);
    expect(projects[1]!.projects[1]!.kloc).toBe(50);
  });

  it("maps community cocomo fields correctly", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync
      .mockReturnValueOnce(SAMPLE_COCOMO)
      .mockReturnValueOnce(COMMUNITY_COCOMO);
    mockReaddirSync.mockReturnValue(["cocomo.json"]);

    const projects = getCocomoProjects();
    const communityProj = projects[1]!.projects[0]!;

    expect(communityProj.effortPersonMonths).toBe(48);
    expect(communityProj.type).toBe("business");
    expect(communityProj.language).toBe("python");
    expect(communityProj.year).toBe(2023);
  });

  it("returns only base when no community projects", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_COCOMO);
    // community dir doesn't exist
    mockExistsSync
      .mockReturnValueOnce(true)   // cocomo path exists
      .mockReturnValueOnce(false); // community dir doesn't exist

    const projects = getCocomoProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("test-dataset");
  });
});
