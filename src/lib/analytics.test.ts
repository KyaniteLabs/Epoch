import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tokenTimeBridge,
  referenceClassEstimate,
  computeAccuracyMetrics,
  calibrateEstimates,
  MODEL_CALIBRATIONS,
  GENERIC_MODEL_CALIBRATION,
  resolveModelCalibration,
} from "./analytics.js";
import type { HistoricalRecord } from "./analytics.js";
import type { LLMModel } from "../types/index.js";
import { resetTelemetry } from "./telemetry.js";
import { resetSupplementaryCache } from "./supplementary-data.js";
import { defined } from "../test-support.js";


// ---------------------------------------------------------------------------
// Layer 4-5: Analytics Utilities
// ---------------------------------------------------------------------------

describe("MODEL_CALIBRATIONS", () => {
  it("contains all 12 models", () => {
    const expected = [
      "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3.5-haiku-20241022",
      "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
      "gemini-2.0-flash", "gemini-2.5-pro",
      "llama-3.1-70b", "llama-3.1-405b",
      "mistral-large", "deepseek-v3",
    ];
    for (const model of expected) {
      expect(MODEL_CALIBRATIONS[model]).toBeDefined();
      expect(defined(MODEL_CALIBRATIONS[model]).tokensPerSecond).toBeGreaterThan(0);
    }
  });

  it("LLMModel type stays in sync with the live table (16 models)", () => {
    const keys = Object.keys(MODEL_CALIBRATIONS);
    expect(keys).toHaveLength(16);
    // Compile-time sync guards (enforced by `pnpm run typecheck`): every table
    // key must be assignable to LLMModel and vice versa. LLMModel is derived
    // from the table (keyof typeof MODEL_CALIBRATIONS), so drift is a type
    // error, not a silent runtime mismatch — these lines keep that contract
    // exercised from the test suite too.
    const fromTable: LLMModel[] = keys;
    const sampleFromType: LLMModel = "claude-fable-5";
    expect(fromTable).toContain(sampleFromType);
  });
});

// ---------------------------------------------------------------------------
// Token-time calibration + unknown-model fallback honesty (ticket 15)
//
// These tests isolate the telemetry store and supplementary-data cache into a
// temp EPOCH_DATA_DIR so confidence labels (which now reflect provenance —
// telemetry / reference-db / table / generic fallback) are deterministic
// regardless of the developer's real ~/.epoch contents.
// ---------------------------------------------------------------------------

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-analytics-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
  resetTelemetry();
  resetSupplementaryCache();
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env["EPOCH_DATA_DIR"];
  } else {
    process.env["EPOCH_DATA_DIR"] = previousDataDir;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
  resetTelemetry();
  resetSupplementaryCache();
});

describe("tokenTimeBridge", () => {
  it("estimates time for a known model", () => {
    const result = tokenTimeBridge({
      tokens: 10000,
      model: "claude-sonnet-4-20250514",
      toolCalls: 5,
      reasoningDepth: "moderate",
    });
    expect(result.tokens).toBe(10000);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.estimatedSeconds).toBeGreaterThan(0);
    expect(result.estimatedMinutes).toBeGreaterThan(0);
    // "optimistic": curated-table provenance — calibration data exists but is
    // not locally measured telemetry (was "likely" before provenance-based
    // labeling; see ticket 15).
    expect(result.confidence).toBe("optimistic");
  });

  it("estimates time for an unknown model with fallback", () => {
    const result = tokenTimeBridge({
      tokens: 5000,
      model: "unknown-model",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(result.model).toBe("unknown-model");
    expect(result.estimatedSeconds).toBeGreaterThan(0);
    // "pessimistic": generic-fallback provenance — no model-specific data at
    // all (75 tps documented default), never a borrowed or benchmark number.
    expect(result.confidence).toBe("pessimistic");
  });

  it("deep reasoning takes longer than shallow", () => {
    const shallow = tokenTimeBridge({
      tokens: 10000,
      model: "claude-opus-4-20250514",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    const deep = tokenTimeBridge({
      tokens: 10000,
      model: "claude-opus-4-20250514",
      toolCalls: 0,
      reasoningDepth: "deep",
    });
    expect(deep.estimatedSeconds).toBeGreaterThan(shallow.estimatedSeconds);
  });

  it("more tool calls increase estimated time", () => {
    const noTools = tokenTimeBridge({
      tokens: 10000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "moderate",
    });
    const manyTools = tokenTimeBridge({
      tokens: 10000,
      model: "gpt-4o",
      toolCalls: 20,
      reasoningDepth: "moderate",
    });
    expect(manyTools.estimatedSeconds).toBeGreaterThan(noTools.estimatedSeconds);
  });

  it("breakdown shows prompt and completion token split", () => {
    const result = tokenTimeBridge({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 3,
      reasoningDepth: "moderate",
    });
    expect(result.breakdown.promptTokens + result.breakdown.completionTokens).toBe(1000);
    expect(result.breakdown.toolOverheadSeconds).toBeGreaterThan(0);
  });

  it("assigns urgency category", () => {
    const short = tokenTimeBridge({
      tokens: 100,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(short.urgency).toBe("short");
  });

  it("includes estimatedTokenCost", () => {
    const result = tokenTimeBridge({
      tokens: 100000,
      model: "gpt-4o",
      toolCalls: 3,
      reasoningDepth: "moderate",
    });
    expect(result.estimatedTokenCost).toBeGreaterThan(0);
    const expectedHours = result.estimatedSeconds / 3600;
    expect(result.estimatedTokenCost).toBeCloseTo(expectedHours * 50000, -2);
  });
});

describe("referenceClassEstimate", () => {
  const records: HistoricalRecord[] = [
    { taskType: "feature", estimatedHours: 10, actualHours: 18, completedAt: "2026-01-15" },
    { taskType: "feature", estimatedHours: 8, actualHours: 14, completedAt: "2026-02-01" },
    { taskType: "feature", estimatedHours: 12, actualHours: 20, completedAt: "2026-02-15" },
    { taskType: "feature", estimatedHours: 6, actualHours: 12, completedAt: "2026-03-01" },
    { taskType: "feature", estimatedHours: 15, actualHours: 25, completedAt: "2026-03-15" },
    { taskType: "bugfix", estimatedHours: 4, actualHours: 5, completedAt: "2026-01-20" },
  ];

  it("computes correction factor from historical data", () => {
    const result = referenceClassEstimate(records, "feature", 3);
    expect(result.sampleSize).toBe(5);
    expect(result.correctionFactor).toBeGreaterThan(1);
    expect(result.correctedEstimate).toBeGreaterThan(result.rawEstimate);
  });

  it("uses the median actual/estimated ratio as the data-driven correction factor", () => {
    const calibratedRecords: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 12, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 14, completedAt: "2026-01-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 15, completedAt: "2026-01-03" },
      { taskType: "feature", estimatedHours: 10, actualHours: 16, completedAt: "2026-01-04" },
      { taskType: "feature", estimatedHours: 10, actualHours: 18, completedAt: "2026-01-05" },
    ];

    const result = referenceClassEstimate(calibratedRecords, "feature", 3, "medium", false);

    expect(result.sampleSize).toBe(5);
    expect(result.correctionFactor).toBe(1.5);
    expect(result.correctedEstimate).toBeCloseTo(result.rawEstimate * 1.5, 5);
  });

  it("falls back to industry correction when insufficient data", () => {
    const result = referenceClassEstimate(records, "migration", 3);
    expect(result.sampleSize).toBe(0);
    expect(result.confidence).toBe("pessimistic");
    expect(result.correctionFactor).toBeGreaterThan(1);
  });

  it("adjusts for complexity levels", () => {
    const low = referenceClassEstimate(records, "feature", 1);
    const high = referenceClassEstimate(records, "feature", 5);
    expect(high.rawEstimate).toBeGreaterThan(low.rawEstimate);
    expect(high.correctedEstimate).toBeGreaterThan(low.correctedEstimate);
  });

  it("confidence improves with more data", () => {
    const manyRecords: HistoricalRecord[] = Array.from({ length: 15 }, (_, i) => ({
      taskType: "bugfix",
      estimatedHours: 5,
      actualHours: 7,
      completedAt: `2026-${String(i % 12 + 1).padStart(2, "0")}-01`,
    }));
    const result = referenceClassEstimate(manyRecords, "bugfix", 3);
    expect(result.confidence).toBe("likely");
    expect(result.sampleSize).toBe(15);
  });
});

describe("referenceClassEstimate scope signal", () => {
  it("uses scope band for raw estimate", () => {
    const small = referenceClassEstimate([], "feature", 3, "small");
    const large = referenceClassEstimate([], "feature", 3, "large");
    expect(large.rawEstimate).toBeGreaterThan(small.rawEstimate);
    expect(small.scopeUsed).toBe("small");
    expect(large.scopeUsed).toBe("large");
  });

  it("applies complexity multiplier within scope band", () => {
    const c1 = referenceClassEstimate([], "feature", 1, "medium");
    const c3 = referenceClassEstimate([], "feature", 3, "medium");
    const c5 = referenceClassEstimate([], "feature", 5, "medium");
    expect(c1.rawEstimate).toBeLessThan(c3.rawEstimate);
    expect(c3.rawEstimate).toBeLessThan(c5.rawEstimate);
    expect(c3.rawEstimate).toBeCloseTo(6.0, 0);
  });

  it("infers scope from complexity when not provided", () => {
    const c1 = referenceClassEstimate([], "feature", 1);
    const c2 = referenceClassEstimate([], "feature", 2);
    const c3 = referenceClassEstimate([], "feature", 3);
    const c4 = referenceClassEstimate([], "feature", 4);
    const c5 = referenceClassEstimate([], "feature", 5);
    expect(c1.scopeUsed).toBe("small");
    expect(c1.scopeInferred).toBe(true);
    expect(c2.scopeUsed).toBe("small");
    expect(c3.scopeUsed).toBe("medium");
    expect(c4.scopeUsed).toBe("large");
    expect(c5.scopeUsed).toBe("xl");
  });

  it("applies complexity multiplier on inferred scope", () => {
    const c1 = referenceClassEstimate([], "feature", 1);
    const c3 = referenceClassEstimate([], "feature", 3);
    const c5 = referenceClassEstimate([], "feature", 5);
    // medium band = 5.72h; c1=5.72*0.7=4.0, c3=5.72*1.0=5.72, c5=5.72*1.5=8.58
    expect(c1.rawEstimate).toBeLessThan(c3.rawEstimate);
    expect(c3.rawEstimate).toBeLessThan(c5.rawEstimate);
    expect(c3.rawEstimate).toBeCloseTo(6.0, 0);
  });

  it("handles out-of-range and boundary complexity for scope inference", () => {
    expect(referenceClassEstimate([], "feature", 0).scopeUsed).toBe("small");
    expect(referenceClassEstimate([], "feature", 2.5).scopeUsed).toBe("medium");
    expect(referenceClassEstimate([], "feature", 3.5).scopeUsed).toBe("large");
    expect(referenceClassEstimate([], "feature", 4.5).scopeUsed).toBe("xl");
    expect(referenceClassEstimate([], "feature", 6).scopeUsed).toBe("xl");
  });

  it("clamps correction factor from historical data to [0.1, 3.0]", () => {
    const extremeRecords: HistoricalRecord[] = Array.from({ length: 7 }, (_, i) => ({
      taskType: "feature", estimatedHours: 10, actualHours: 100 + i * 10, completedAt: `2026-0${i + 1}-01`,
    }));
    const result = referenceClassEstimate(extremeRecords, "feature", 3);
    expect(result.correctionFactor).toBeGreaterThanOrEqual(0.1);
    expect(result.correctionFactor).toBeLessThanOrEqual(3.0);
  });

  it("returns sample_size 0 when all records have actualHours===0", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 0, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 0, completedAt: "2026-02-01" },
    ];
    const result = computeAccuracyMetrics(records);
    expect(result.sample_size).toBe(0);
    expect(result.mape).toBe(0);
    expect(result.trend).toBe("stable");
  });

  it("inferred medium is same as explicit medium", () => {
    const inferred = referenceClassEstimate([], "feature", 3);
    const explicit = referenceClassEstimate([], "feature", 3, "medium");
    expect(inferred.rawEstimate).toBe(explicit.rawEstimate);
  });

  it("explicit scope is not marked as inferred", () => {
    const result = referenceClassEstimate([], "feature", 3, "large");
    expect(result.scopeInferred).toBe(false);
    expect(result.scopeUsed).toBe("large");
  });

  it("xl scope produces larger estimates than small", () => {
    const small = referenceClassEstimate([], "feature", 3, "small");
    const xl = referenceClassEstimate([], "feature", 3, "xl");
    expect(xl.rawEstimate / small.rawEstimate).toBeGreaterThan(5);
  });

  it("scope bands vary by task type", () => {
    const featRange = referenceClassEstimate([], "feature", 3, "xl").rawEstimate
      - referenceClassEstimate([], "feature", 3, "small").rawEstimate;
    const bugRange = referenceClassEstimate([], "bugfix", 3, "xl").rawEstimate
      - referenceClassEstimate([], "bugfix", 3, "small").rawEstimate;
    // Both should have meaningful range (xl > small)
    expect(featRange).toBeGreaterThan(5);
    expect(bugRange).toBeGreaterThan(5);
    // They should differ (different task types have different distributions)
    expect(featRange).not.toBeCloseTo(bugRange, 0);
  });

  it("baselineSource indicates scope band", () => {
    const result = referenceClassEstimate([], "feature", 3, "large");
    expect(result.baselineSource).toBe("scope_large_real_tasks");
  });

  it("baselineSource indicates inferred scope", () => {
    const result = referenceClassEstimate([], "feature", 3);
    expect(result.baselineSource).toBe("inferred_scope_medium_real_tasks");
  });

  it("includes estimatedTokenCost (correctedEstimate × 50000)", () => {
    const result = referenceClassEstimate([], "feature", 3, "medium");
    expect(result.estimatedTokenCost).toBeGreaterThan(0);
    expect(result.estimatedTokenCost).toBeCloseTo(result.correctedEstimate * 50000, -2);
  });
});

describe("computeAccuracyMetrics", () => {
  it("returns zeros for empty records", () => {
    const result = computeAccuracyMetrics([]);
    expect(result.mape).toBe(0);
    expect(result.bias).toBe(0);
    expect(result.variance).toBe(0);
    expect(result.sample_size).toBe(0);
    expect(result.trend).toBe("stable");
  });

  it("computes MAPE correctly", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 12, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 8, completedAt: "2026-02-01" },
    ];
    const result = computeAccuracyMetrics(records);
    // MAPE: (|10-12|/12 + |10-8|/8) / 2 * 100 = (0.167 + 0.25) / 2 * 100 = 20.8%
    expect(result.mape).toBeCloseTo(20.8, 0);
  });

  it("computes positive bias for underestimation", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 5, actualHours: 10, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 5, actualHours: 10, completedAt: "2026-02-01" },
    ];
    const result = computeAccuracyMetrics(records);
    expect(result.bias).toBeGreaterThan(0); // positive = underestimation
  });

  it("computes negative bias for overestimation", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 20, actualHours: 10, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 20, actualHours: 10, completedAt: "2026-02-01" },
    ];
    const result = computeAccuracyMetrics(records);
    expect(result.bias).toBeLessThan(0);
  });

  it("detects improving trend", () => {
    // First half: bad accuracy, second half: good accuracy
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 30, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 25, completedAt: "2026-02-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-03-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 12, completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 11, completedAt: "2026-05-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-06-01" },
    ];
    const result = computeAccuracyMetrics(records);
    expect(result.trend).toBe("improving");
  });

  it("returns sample_size matching input", () => {
    const records: HistoricalRecord[] = Array.from({ length: 5 }, (_, i) => ({
      taskType: "feature",
      estimatedHours: 10,
      actualHours: 12,
      completedAt: `2026-0${i + 1}-01`,
    }));
    const result = computeAccuracyMetrics(records);
    expect(result.sample_size).toBe(5);
  });
});

describe("calibrateEstimates", () => {
  it("returns calibration from reference DB or industry factors", () => {
    const result = calibrateEstimates("team-a", 90, 10);
    expect(result.correctionFactor).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("detects degrading trend and adds warning recommendation", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-02-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 11, completedAt: "2026-03-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 30, completedAt: "2026-05-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 40, completedAt: "2026-06-01" },
    ];
    const result = calibrateEstimates("team-a", 90, 5, records);
    expect(result.accuracyTrend).toBe("degrading");
    expect(result.recommendations.some(r => r.includes("degrading"))).toBe(true);
  });

  it("falls back to global correction when mape is 0 with enough samples", () => {
    const records: HistoricalRecord[] = Array.from({ length: 10 }, (_, i) => ({
      taskType: "feature",
      estimatedHours: 10,
      actualHours: 10,
      completedAt: `2026-${String(i + 1).padStart(2, "0")}-01`,
    }));
    const result = calibrateEstimates("team-a", 90, 5, records);
    expect(result.correctionFactor).toBeGreaterThan(0);
    expect(result.accuracyTrend).toBe("stable");
  });

  it("uses MdAPE for correction factor (robust to outliers)", () => {
    // 5 good estimates + 1 extreme outlier
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 9, completedAt: "2026-01-01" },   // 11.1%
      { taskType: "feature", estimatedHours: 10, actualHours: 11, completedAt: "2026-02-01" },  // 9.1%
      { taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-03-01" },  // 0%
      { taskType: "feature", estimatedHours: 10, actualHours: 8, completedAt: "2026-04-01" },   // 25%
      { taskType: "feature", estimatedHours: 10, actualHours: 12, completedAt: "2026-05-01" },  // 16.7%
      { taskType: "feature", estimatedHours: 10, actualHours: 0.01, completedAt: "2026-06-01" },// 99900% outlier
    ];
    const result = calibrateEstimates("team-a", 90, 5, records);
    // MdAPE-based CF should be small (~1.1), not inflated by the outlier
    expect(result.correctionFactor).toBeLessThan(1.5);
    // Recommendations should include MdAPE
    expect(result.recommendations.some(r => r.includes("MdAPE"))).toBe(true);
  });
});

describe("computeAccuracyMetrics MdAPE", () => {
  it("returns mdape 0 for empty records", () => {
    const result = computeAccuracyMetrics([]);
    expect(result.mdape).toBe(0);
  });

  it("computes MdAPE as median of absolute percentage errors", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 12, completedAt: "2026-01-01" }, // 16.7%
      { taskType: "feature", estimatedHours: 10, actualHours: 8, completedAt: "2026-02-01" },  // 25%
      { taskType: "feature", estimatedHours: 10, actualHours: 5, completedAt: "2026-03-01" },  // 100%
    ];
    const result = computeAccuracyMetrics(records);
    // MAPE = (16.7 + 25 + 100) / 3 = 47.2
    expect(result.mape).toBeCloseTo(47.2, 0);
    // MdAPE = median(16.7, 25, 100) = 25
    expect(result.mdape).toBeCloseTo(25, 0);
    expect(result.mdape).toBeLessThan(result.mape);
  });

  it("MdAPE is robust to extreme outliers that inflate MAPE", () => {
    const records: HistoricalRecord[] = [
      { taskType: "bugfix", estimatedHours: 4, actualHours: 3.8, completedAt: "2026-01-01" },    // 5.3%
      { taskType: "bugfix", estimatedHours: 4, actualHours: 3.5, completedAt: "2026-02-01" },    // 14.3%
      { taskType: "bugfix", estimatedHours: 4, actualHours: 4.2, completedAt: "2026-03-01" },    // 4.8%
      { taskType: "bugfix", estimatedHours: 4, actualHours: 0.01, completedAt: "2026-04-01" },   // 39900%
      { taskType: "bugfix", estimatedHours: 4, actualHours: 3.9, completedAt: "2026-05-01" },    // 2.6%
    ];
    const result = computeAccuracyMetrics(records);
    // MAPE dominated by the 39900% outlier → huge
    expect(result.mape).toBeGreaterThan(5000);
    // MdAPE = median(2.6, 4.8, 5.3, 14.3, 39900) = 5.3
    expect(result.mdape).toBeLessThan(20);
  });

  it("MdAPE equals MAPE when all errors are equal", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 8, actualHours: 10, completedAt: "2026-01-01" },
      { taskType: "feature", estimatedHours: 8, actualHours: 10, completedAt: "2026-02-01" },
      { taskType: "feature", estimatedHours: 8, actualHours: 10, completedAt: "2026-03-01" },
    ];
    const result = computeAccuracyMetrics(records);
    expect(result.mdape).toBeCloseTo(result.mape, 1);
  });

  it("computes MdAPE for even-length arrays (average of two middle values)", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 9, completedAt: "2026-01-01" },   // 11.1%
      { taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-02-01" },  // 50%
    ];
    const result = computeAccuracyMetrics(records);
    // Two values: 11.1, 50 → MdAPE = (11.1 + 50) / 2 = 30.55
    expect(result.mdape).toBeCloseTo(30.6, 0);
  });
});

describe("referenceClassEstimate AI-native baselines", () => {
  it("uses AI-native scope baselines when aiNative is true", () => {
    const human = referenceClassEstimate([], "bugfix", 1, "small", false);
    const ai = referenceClassEstimate([], "bugfix", 1, "small", true);
    // AI-native small bugfix: 0.1h * 0.7 (complexity 1) = 0.07
    // Human: much larger
    expect(ai.rawEstimate).toBeLessThan(human.rawEstimate);
    expect(ai.rawEstimate).toBeLessThan(1);
  });

  it("sets CF=1.0 when using AI-native baselines without enough data", () => {
    const ai = referenceClassEstimate([], "feature", 3, "medium", true);
    expect(ai.correctionFactor).toBe(1.0);
  });

  it("uses data-driven CF with AI baselines when enough records exist", () => {
    // 5 records where actual = 0.5 * estimated → median ratio = 0.5
    const records = Array.from({ length: 5 }, () => ({
      taskType: "feature" as const,
      estimatedHours: 10,
      actualHours: 5,
      tool: "reference_class_estimate",
      completedAt: new Date().toISOString(),
    }));
    const result = referenceClassEstimate(records, "feature", 3, "medium", true);
    expect(result.correctionFactor).toBeLessThan(1.0);
    expect(result.correctionFactor).toBeCloseTo(0.5, 1);
  });

  it("falls back to human baselines when aiNative is false", () => {
    const human = referenceClassEstimate([], "feature", 3, "medium", false);
    // Human baselines have medium=5.72 for feature
    expect(human.rawEstimate).toBeGreaterThan(3);
  });

  it("AI-native estimates are realistic for all task types", () => {
    const types = ["feature", "bugfix", "infrastructure", "testing", "refactor", "documentation", "design", "migration"] as const;
    for (const type of types) {
      const ai = referenceClassEstimate([], type, 3, "small", true);
      // Small AI-native tasks should be under 1 hour
      expect(ai.rawEstimate).toBeLessThan(1.5);
      expect(ai.rawEstimate).toBeGreaterThan(0);
    }
  });

  it("AI-native medium task scales correctly with complexity", () => {
    const c1 = referenceClassEstimate([], "feature", 1, "medium", true);
    const c3 = referenceClassEstimate([], "feature", 3, "medium", true);
    const c5 = referenceClassEstimate([], "feature", 5, "medium", true);
    expect(c1.rawEstimate).toBeLessThan(c3.rawEstimate);
    expect(c3.rawEstimate).toBeLessThan(c5.rawEstimate);
    // medium feature = 2.0h base; c1=2.0*0.7=1.4, c3=2.0*1.0=2.0, c5=2.0*1.5=3.0
    expect(c3.rawEstimate).toBeCloseTo(2.0, 0);
  });

  it("migration task type has valid baselines", () => {
    const result = referenceClassEstimate([], "migration", 3, "medium", true);
    expect(result.rawEstimate).toBeGreaterThan(0);
    expect(result.correctionFactor).toBe(1.0);
    expect(result.scopeUsed).toBe("medium");
    // AI-native migration medium = 2.0h * 1.0 = 2.0
    expect(result.rawEstimate).toBeCloseTo(2.0, 0);
  });

  it("design task type has valid baselines", () => {
    const result = referenceClassEstimate([], "design", 3, "large", true);
    expect(result.rawEstimate).toBeGreaterThan(0);
    expect(result.correctionFactor).toBe(1.0);
    // AI-native design large = 5.0h * 1.0 = 5.0
    expect(result.rawEstimate).toBeCloseTo(5.0, 0);
  });
});

// ---------------------------------------------------------------------------
// Unknown-model fallback honesty (ticket 15)
// ---------------------------------------------------------------------------

describe("model calibration provenance", () => {
  it("unknown models get the documented generic default (75 tps), never a borrowed number", () => {
    const { calibration, provenance } = resolveModelCalibration("nonexistent-model-zz9");
    expect(provenance).toBe("generic_fallback");
    expect(calibration.tokensPerSecond).toBe(GENERIC_MODEL_CALIBRATION.tokensPerSecond);
    expect(calibration.tokensPerSecond).toBe(75);
  });

  it("table models resolve with calibrated_table provenance", () => {
    const { calibration, provenance } = resolveModelCalibration("gpt-4o");
    expect(provenance).toBe("calibrated_table");
    expect(calibration.tokensPerSecond).toBe(85);
  });

  it("telemetry-backed models override tps and report telemetry provenance", () => {
    // 12 recorded token-tool calls → median tps = 1000 tokens / 1s = 1000.
    const lines = Array.from({ length: 12 }, () =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        tool: "token_time_bridge",
        inputHash: "x",
        outputOk: true,
        elapsedMs: 1000,
        model: "my-measured-model",
        tokens: 1000,
      }),
    ).join("\n");
    writeFileSync(join(tempDataDir, "telemetry.jsonl"), `${lines}\n`);
    resetTelemetry(); // fresh store so the file is seen

    const { calibration, provenance } = resolveModelCalibration("my-measured-model");
    expect(provenance).toBe("telemetry");
    expect(calibration.tokensPerSecond).toBe(1000);

    const result = tokenTimeBridge({ tokens: 5000, model: "my-measured-model", toolCalls: 0, reasoningDepth: "shallow" });
    expect(result.confidence).toBe("likely");
  });
});

describe("unknown-model fallback via the shipped reference DB (no loader mock)", () => {
  it("unknown model default is 75-based with an honest confidence label, even though the shipped DB's raw-benchmark _default exists", () => {
    // The real loadReferenceDb() runs here (self-improve.js is NOT mocked).
    // On CI (no ~/.epoch) it resolves to the repo-bundled
    // src/data/reference-database.json — the exact shipped artifact.
    const result = tokenTimeBridge({
      tokens: 7500,
      model: "totally-unknown-model-v1",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    // 7500 tokens / 75 tps = 100s generation + 2.5s shallow reasoning
    // overhead = 102.5s. The old bug used the shipped DB's `_default`
    // (~1686 tps raw model-server benchmark) and estimated ~7s — 22x
    // optimistic.
    expect(result.estimatedSeconds).toBe(103);
    expect(result.confidence).toBe("pessimistic");

    // Prove the shipped DB really carries that `_default` entry (and it is a
    // big raw-benchmark number), so the 75-based result above is the code
    // ignoring it — not the DB lacking it.
    const shippedDb = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "src", "data", "reference-database.json"), "utf-8"),
    ) as { tokenTimeCalibration?: Record<string, { medianTokensPerSecond?: number; medianTps?: number }> };
    const dbDefault = shippedDb.tokenTimeCalibration?.["_default"];
    expect(dbDefault).toBeDefined();
    expect(dbDefault?.medianTokensPerSecond ?? dbDefault?.medianTps ?? 0).toBeGreaterThan(1000);
  });

  it("reference-DB per-model stats still calibrate models the curated table lacks", () => {
    // The shipped DB carries per-model community stats for MiniMax-M2 etc.
    // Those are real per-model data and must still be used (with an honest
    // non-"likely" label) — only the `_default` aggregate is ignored.
    const db = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "src", "data", "reference-database.json"), "utf-8"),
    ) as { tokenTimeCalibration?: Record<string, { medianTokensPerSecond?: number; medianTps?: number }> };
    const entry = db.tokenTimeCalibration?.["MiniMax-M2"];
    if (!entry) return; // DBs without per-model entries: nothing to assert

    const { calibration, provenance } = resolveModelCalibration("MiniMax-M2");
    expect(provenance).toBe("reference_db");
    expect(calibration.tokensPerSecond).toBe(entry.medianTokensPerSecond ?? entry.medianTps);
    expect(tokenTimeBridge({ tokens: 1000, model: "MiniMax-M2", toolCalls: 0, reasoningDepth: "shallow" }).confidence).toBe("optimistic");
  });
});

describe("compare_models telemetry read amortization", () => {
  it("reads the telemetry file once per model, not once per model per call (60s TTL cache)", async () => {
    const { compareModels } = await import("./cost.js");
    const { getTelemetry } = await import("./telemetry.js");
    // A telemetry file WITHOUT model data: every getModelStats miss reads the
    // full file (the pre-cache behavior: 16 reads per compare_models call).
    writeFileSync(join(tempDataDir, "telemetry.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), tool: "pert_estimate", inputHash: "x", outputOk: true, elapsedMs: 5 })}\n`);
    resetTelemetry();

    const store = getTelemetry();
    // computeModelStats() performs exactly one full telemetry-file read per
    // invocation (proven 1:1 in telemetry.test.ts under a mocked fs), so its
    // call count is the telemetry read count.
    type StoreWithPrivates = { computeModelStats: (model: string, windowDays?: number) => unknown };
    const spy = vi.spyOn(store as unknown as StoreWithPrivates, "computeModelStats");
    try {
      compareModels({ tokens: 10_000, toolCalls: 0, reasoningDepth: "shallow" });
      expect(spy).toHaveBeenCalledTimes(16); // one per catalog model

      compareModels({ tokens: 10_000, toolCalls: 0, reasoningDepth: "shallow" });
      expect(spy).toHaveBeenCalledTimes(16); // fully served from the TTL cache
    } finally {
      spy.mockRestore();
    }
  });
});
