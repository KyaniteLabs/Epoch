import { describe, it, expect } from "vitest";
import {
  timeMathSchema,
  pertEstimateSchema,
  cocomoEstimateSchema,
  sprintForecastSchema,
  criticalPathSchema,
  referenceClassEstimateSchema,
  monteCarloSchema,
  calibrateEstimatesSchema,
  tokenTimeBridgeSchema,
  tokenCostEstimateSchema,
  compareModelsSchema,
  accuracyTrendSchema,
  scheduleRiskSchema,
  cocomoValidateSchema,
  timeUnitEnum,
  taskTypeEnum,
  llmModelEnum,
  reasoningDepthEnum,
} from "./index.js";

// ---- Enum schemas ----

describe("enum schemas", () => {
  it("timeUnitEnum rejects invalid unit", () => {
    expect(timeUnitEnum.safeParse("decades").success).toBe(false);
  });

  it("taskTypeEnum rejects invalid type", () => {
    expect(taskTypeEnum.safeParse("hotfix").success).toBe(false);
  });

  it("llmModelEnum rejects unknown model", () => {
    expect(llmModelEnum.safeParse("gpt-5").success).toBe(false);
  });

  it("reasoningDepthEnum rejects invalid depth", () => {
    expect(reasoningDepthEnum.safeParse("extreme").success).toBe(false);
  });
});

// ---- timeMath ----

describe("timeMathSchema", () => {
  it("accepts valid operation with operands", () => {
    expect(timeMathSchema.safeParse({
      operation: "add_days",
      operands: { start_date: "2026-01-01", days: 5 },
    }).success).toBe(true);
  });

  it("rejects invalid operation", () => {
    expect(timeMathSchema.safeParse({
      operation: "multiply",
      operands: {},
    }).success).toBe(false);
  });

  it("rejects missing operation", () => {
    expect(timeMathSchema.safeParse({ operands: {} }).success).toBe(false);
  });

  it("rejects missing operands", () => {
    expect(timeMathSchema.safeParse({ operation: "add_days" }).success).toBe(false);
  });
});

// ---- pertEstimate ----

describe("pertEstimateSchema", () => {
  const valid = { optimistic: 2, most_likely: 5, pessimistic: 10 };

  it("accepts valid input", () => {
    expect(pertEstimateSchema.safeParse(valid).success).toBe(true);
  });

  it("applies defaults for unit and ai_native", () => {
    const r = pertEstimateSchema.safeParse(valid);
    expect(r.success && r.data.unit).toBe("hours");
    expect(r.success && r.data.ai_native).toBe(1.0);
  });

  it("rejects zero optimistic", () => {
    expect(pertEstimateSchema.safeParse({ ...valid, optimistic: 0 }).success).toBe(false);
  });

  it("rejects negative most_likely", () => {
    expect(pertEstimateSchema.safeParse({ ...valid, most_likely: -1 }).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(pertEstimateSchema.safeParse({ optimistic: 2 }).success).toBe(false);
  });

  it("coerces string numbers", () => {
    const r = pertEstimateSchema.safeParse({ optimistic: "2", most_likely: "5", pessimistic: "10" });
    expect(r.success && r.data.optimistic).toBe(2);
  });
});

// ---- cocomoEstimate ----

describe("cocomoEstimateSchema", () => {
  const valid = { kloc: 10 };

  it("accepts valid input with defaults", () => {
    const r = cocomoEstimateSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reasoning_complexity).toBe(1.0);
      expect(r.data.kloc).toBe(10);
    }
  });

  it("rejects zero kloc", () => {
    expect(cocomoEstimateSchema.safeParse({ kloc: 0 }).success).toBe(false);
  });

  it("rejects multiplier below min", () => {
    expect(cocomoEstimateSchema.safeParse({ kloc: 5, reasoning_complexity: 0.1 }).success).toBe(false);
  });

  it("rejects multiplier above max", () => {
    expect(cocomoEstimateSchema.safeParse({ kloc: 5, human_oversight: 3.0 }).success).toBe(false);
  });
});

// ---- sprintForecast ----

describe("sprintForecastSchema", () => {
  const valid = { backlog_points: 100, velocity_history: [20, 25, 22] };

  it("accepts valid input with defaults", () => {
    const r = sprintForecastSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sprint_length_days).toBe(14);
      expect(r.data.hours_per_sprint).toBe(300);
    }
  });

  it("rejects empty velocity_history", () => {
    expect(sprintForecastSchema.safeParse({ ...valid, velocity_history: [] }).success).toBe(false);
  });

  it("rejects zero backlog_points", () => {
    expect(sprintForecastSchema.safeParse({ ...valid, backlog_points: 0 }).success).toBe(false);
  });

  it("rejects missing velocity_history", () => {
    expect(sprintForecastSchema.safeParse({ backlog_points: 50 }).success).toBe(false);
  });
});

// ---- criticalPath ----

describe("criticalPathSchema", () => {
  const valid = { tasks: [{ name: "A", duration: 3, predecessors: [] }] };

  it("accepts valid input", () => {
    expect(criticalPathSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty tasks array", () => {
    expect(criticalPathSchema.safeParse({ tasks: [] }).success).toBe(false);
  });

  it("rejects task with empty name", () => {
    expect(criticalPathSchema.safeParse({
      tasks: [{ name: "", duration: 3, predecessors: [] }],
    }).success).toBe(false);
  });

  it("rejects task with zero duration", () => {
    expect(criticalPathSchema.safeParse({
      tasks: [{ name: "A", duration: 0, predecessors: [] }],
    }).success).toBe(false);
  });

  it("rejects missing tasks field", () => {
    expect(criticalPathSchema.safeParse({}).success).toBe(false);
  });
});

// ---- referenceClassEstimate ----

describe("referenceClassEstimateSchema", () => {
  const valid = { task_type: "feature" as const, complexity: 3 };

  it("accepts valid input", () => {
    expect(referenceClassEstimateSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid task_type", () => {
    expect(referenceClassEstimateSchema.safeParse({ ...valid, task_type: "emergency" }).success).toBe(false);
  });

  it("rejects complexity below 1", () => {
    expect(referenceClassEstimateSchema.safeParse({ ...valid, complexity: 0 }).success).toBe(false);
  });

  it("rejects complexity above 5", () => {
    expect(referenceClassEstimateSchema.safeParse({ ...valid, complexity: 6 }).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(referenceClassEstimateSchema.safeParse({ task_type: "feature" }).success).toBe(false);
  });
});

// ---- monteCarlo ----

describe("monteCarloSchema", () => {
  const valid = {
    tasks: [{ name: "A", optimistic: 2, most_likely: 5, pessimistic: 10 }],
  };

  it("accepts valid input with default iterations", () => {
    const r = monteCarloSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.iterations).toBe(10000);
  });

  it("rejects empty tasks", () => {
    expect(monteCarloSchema.safeParse({ tasks: [] }).success).toBe(false);
  });

  it("rejects optimistic > most_likely via refine", () => {
    expect(monteCarloSchema.safeParse({
      tasks: [{ name: "A", optimistic: 10, most_likely: 5, pessimistic: 15 }],
    }).success).toBe(false);
  });

  it("rejects most_likely > pessimistic via refine", () => {
    expect(monteCarloSchema.safeParse({
      tasks: [{ name: "A", optimistic: 2, most_likely: 15, pessimistic: 10 }],
    }).success).toBe(false);
  });

  it("rejects iterations over 100000", () => {
    expect(monteCarloSchema.safeParse({ ...valid, iterations: 200000 }).success).toBe(false);
  });

  it("rejects zero iterations", () => {
    expect(monteCarloSchema.safeParse({ ...valid, iterations: 0 }).success).toBe(false);
  });
});

// ---- calibrateEstimates ----

describe("calibrateEstimatesSchema", () => {
  it("accepts valid input with defaults", () => {
    const r = calibrateEstimatesSchema.safeParse({ team_id: "team-1" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.period_days).toBe(90);
      expect(r.data.minimum_samples).toBe(10);
    }
  });

  it("rejects missing team_id", () => {
    expect(calibrateEstimatesSchema.safeParse({}).success).toBe(false);
  });

  it("rejects zero period_days", () => {
    expect(calibrateEstimatesSchema.safeParse({ team_id: "t", period_days: 0 }).success).toBe(false);
  });
});

// ---- tokenTimeBridge ----

describe("tokenTimeBridgeSchema", () => {
  const valid = { tokens: 1000, model: "claude-sonnet-4-20250514" };

  it("accepts valid input with defaults", () => {
    const r = tokenTimeBridgeSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tool_calls).toBe(0);
      expect(r.data.reasoning_depth).toBe("moderate");
    }
  });

  it("rejects zero tokens", () => {
    expect(tokenTimeBridgeSchema.safeParse({ ...valid, tokens: 0 }).success).toBe(false);
  });

  it("rejects missing model", () => {
    expect(tokenTimeBridgeSchema.safeParse({ tokens: 100 }).success).toBe(false);
  });

  it("rejects negative tool_calls", () => {
    expect(tokenTimeBridgeSchema.safeParse({ ...valid, tool_calls: -1 }).success).toBe(false);
  });
});

// ---- tokenCostEstimate ----

describe("tokenCostEstimateSchema", () => {
  const valid = { tokens: 5000, model: "gpt-4o" };

  it("accepts valid input with defaults", () => {
    const r = tokenCostEstimateSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tool_calls).toBe(0);
      expect(r.data.reasoning_depth).toBe("moderate");
    }
  });

  it("rejects zero tokens", () => {
    expect(tokenCostEstimateSchema.safeParse({ ...valid, tokens: 0 }).success).toBe(false);
  });
});

// ---- compareModels ----

describe("compareModelsSchema", () => {
  const valid = { tokens: 10000 };

  it("accepts valid input with defaults", () => {
    const r = compareModelsSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sort_by).toBe("cost");
      expect(r.data.tool_calls).toBe(0);
    }
  });

  it("rejects invalid sort_by", () => {
    expect(compareModelsSchema.safeParse({ tokens: 100, sort_by: "speed" }).success).toBe(false);
  });

  it("rejects zero tokens", () => {
    expect(compareModelsSchema.safeParse({ tokens: 0 }).success).toBe(false);
  });
});

// ---- accuracyTrend ----

describe("accuracyTrendSchema", () => {
  it("accepts empty object with defaults", () => {
    const r = accuracyTrendSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.window_size).toBe(50);
  });

  it("rejects window_size below 5", () => {
    expect(accuracyTrendSchema.safeParse({ window_size: 2 }).success).toBe(false);
  });

  it("accepts with team_id", () => {
    expect(accuracyTrendSchema.safeParse({ team_id: "alpha" }).success).toBe(true);
  });
});

// ---- scheduleRisk ----

describe("scheduleRiskSchema", () => {
  const valid = { estimated_hours: 40 };

  it("accepts valid input", () => {
    expect(scheduleRiskSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects zero estimated_hours", () => {
    expect(scheduleRiskSchema.safeParse({ estimated_hours: 0 }).success).toBe(false);
  });

  it("rejects missing estimated_hours", () => {
    expect(scheduleRiskSchema.safeParse({}).success).toBe(false);
  });

  it("accepts with optional fields", () => {
    expect(scheduleRiskSchema.safeParse({
      estimated_hours: 40,
      task_type: "bugfix",
      team_id: "team-a",
    }).success).toBe(true);
  });

  it("rejects invalid task_type", () => {
    expect(scheduleRiskSchema.safeParse({
      estimated_hours: 40,
      task_type: "impossible",
    }).success).toBe(false);
  });
});

// ---- cocomoValidate ----

describe("cocomoValidateSchema", () => {
  it("accepts empty object", () => {
    expect(cocomoValidateSchema.safeParse({}).success).toBe(true);
  });

  it("accepts with dataset_filter", () => {
    expect(cocomoValidateSchema.safeParse({ dataset_filter: ["COCOMO81"] }).success).toBe(true);
  });

  it("rejects non-array dataset_filter", () => {
    expect(cocomoValidateSchema.safeParse({ dataset_filter: "COCOMO81" }).success).toBe(false);
  });
});
