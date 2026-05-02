import { describe, it, expect } from "vitest";
import {
  tokenTimeBridge,
  referenceClassEstimate,
  computeAccuracyMetrics,
  calibrateEstimates,
  MODEL_CALIBRATIONS,
} from "./analytics.js";
import type { HistoricalRecord } from "./analytics.js";

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
      expect(MODEL_CALIBRATIONS[model]!.tokensPerSecond).toBeGreaterThan(0);
    }
  });
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
    expect(result.confidence).toBe("likely");
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
    expect(["likely", "optimistic"]).toContain(result.confidence);
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

  it("defaults to medium scope when not provided", () => {
    const c1 = referenceClassEstimate([], "feature", 1);
    const c3 = referenceClassEstimate([], "feature", 3);
    expect(c1.scopeUsed).toBe("medium");
    expect(c1.scopeInferred).toBe(true);
    expect(c3.scopeUsed).toBe("medium");
    expect(c3.scopeInferred).toBe(true);
  });

  it("applies complexity multiplier on medium default", () => {
    const c1 = referenceClassEstimate([], "feature", 1);
    const c3 = referenceClassEstimate([], "feature", 3);
    const c5 = referenceClassEstimate([], "feature", 5);
    // medium band = 5.72h; c1=5.72*0.7=4.0, c3=5.72*1.0=5.72, c5=5.72*1.5=8.58
    expect(c1.rawEstimate).toBeLessThan(c3.rawEstimate);
    expect(c3.rawEstimate).toBeLessThan(c5.rawEstimate);
    expect(c3.rawEstimate).toBeCloseTo(6.0, 0);
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
});
