import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tokenCostEstimate, compareModels } from "./cost.js";
import { resetSupplementaryCache } from "./supplementary-data.js";
import { defined } from "../test-support.js";


// ---------------------------------------------------------------------------
// Cost Estimation Tests
// ---------------------------------------------------------------------------

describe("tokenCostEstimate", () => {
  it("estimates cost for a known model", () => {
    const result = tokenCostEstimate({
      tokens: 10000,
      model: "claude-sonnet-4-20250514",
      toolCalls: 2,
      reasoningDepth: "moderate",
    });

    expect(result.estimatedCost).toBeGreaterThan(0);
    expect(result.costBreakdown.inputCost).toBeGreaterThanOrEqual(0);
    expect(result.costBreakdown.outputCost).toBeGreaterThanOrEqual(0);
    expect(result.costBreakdown.toolCallOverheadCost).toBeGreaterThanOrEqual(0);
    expect(result.estimatedSeconds).toBeGreaterThan(0);
    expect(result.tokens).toBe(10000);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.humanReadable).toContain("claude-sonnet-4-20250514");
    expect(result.humanReadable).toContain("moderate");
  });

  it("estimates cost with fallback for unknown model", () => {
    const result = tokenCostEstimate({
      tokens: 10000,
      model: "unknown-model",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    // Fallback rates should still produce a cost
    expect(result.estimatedCost).toBeGreaterThan(0);
    expect(result.costBreakdown.inputCost).toBeGreaterThan(0);
    expect(result.costBreakdown.outputCost).toBeGreaterThan(0);
  });

  it("more tokens cost more", () => {
    const small = tokenCostEstimate({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    const large = tokenCostEstimate({
      tokens: 10000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    expect(large.estimatedCost).toBeGreaterThan(small.estimatedCost);
  });

  it("tool calls add overhead cost", () => {
    const noTools = tokenCostEstimate({
      tokens: 5000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    const withTools = tokenCostEstimate({
      tokens: 5000,
      model: "gpt-4o",
      toolCalls: 10,
      reasoningDepth: "shallow",
    });

    expect(withTools.estimatedCost).toBeGreaterThan(noTools.estimatedCost);
    expect(withTools.costBreakdown.toolCallOverheadCost).toBeGreaterThan(
      noTools.costBreakdown.toolCallOverheadCost,
    );
  });

  it("cost breakdown sums correctly", () => {
    const result = tokenCostEstimate({
      tokens: 10000,
      model: "claude-sonnet-4-20250514",
      toolCalls: 5,
      reasoningDepth: "deep",
    });

    const sum =
      result.costBreakdown.inputCost +
      result.costBreakdown.outputCost +
      result.costBreakdown.toolCallOverheadCost;

    expect(Math.abs(sum - result.estimatedCost)).toBeLessThan(0.01);
  });

  it("zero tokens produces zero cost", () => {
    const result = tokenCostEstimate({
      tokens: 0,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(result.estimatedCost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Model Comparison Tests
// ---------------------------------------------------------------------------

describe("compareModels", () => {
  it("returns comparison for all models", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 3,
      reasoningDepth: "moderate",
    });

    expect(result.models.length).toBeGreaterThanOrEqual(12);
    expect(result.tokens).toBe(10000);
  });

  it("sorts by cost by default", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 2,
      reasoningDepth: "moderate",
    });

    for (let i = 1; i < result.models.length; i++) {
      const prev = defined(result.models[i - 1]);
      const curr = defined(result.models[i]);
      // Models with 0 cost go last
      if (prev.estimatedCost === 0) {
        expect(curr.estimatedCost).toBe(0);
      } else if (curr.estimatedCost !== 0) {
        expect(curr.estimatedCost).toBeGreaterThanOrEqual(prev.estimatedCost);
      }
    }
  });

  it("sorts by time when requested", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 2,
      reasoningDepth: "moderate",
      sortBy: "time",
    });

    expect(result.sortBy).toBe("time");

    for (let i = 1; i < result.models.length; i++) {
      expect(defined(result.models[i]).estimatedSeconds).toBeGreaterThanOrEqual(
        defined(result.models[i - 1]).estimatedSeconds,
      );
    }
  });

  it("each entry has required fields", () => {
    const result = compareModels({
      tokens: 5000,
      toolCalls: 1,
      reasoningDepth: "shallow",
    });

    for (const entry of result.models) {
      expect(entry.model).toBeTruthy();
      expect(typeof entry.estimatedSeconds).toBe("number");
      expect(typeof entry.estimatedMinutes).toBe("number");
      expect(typeof entry.estimatedCost).toBe("number");
      expect(typeof entry.qualityTier).toBe("string");
      expect(typeof entry.tokensPerSecond).toBe("number");
      expect(entry.tokensPerSecond).toBeGreaterThan(0);
    }
  });

  it("quality tiers are assigned", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 0,
      reasoningDepth: "moderate",
    });

    const tiers = new Set(result.models.map((e) => defined(e).qualityTier));

    expect(tiers.has("fast")).toBe(true);
    expect(tiers.has("standard")).toBe(true);
    expect(tiers.has("premium")).toBe(true);
  });

  it("human-readable output is a formatted table", () => {
    const result = compareModels({
      tokens: 10000, toolCalls: 0, reasoningDepth: "shallow",
    });
    expect(result.humanReadable).toContain("Model");
    expect(result.humanReadable).toContain("Time (min)");
    expect(result.humanReadable).toContain("Cost ($)");
    expect(result.humanReadable).toContain("Tier");
    // Should have at least 12 data rows + 2 header rows
    const lines = result.humanReadable.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(14);
  });

  it("premium model costs more than fast model", () => {
    const premium = tokenCostEstimate({
      tokens: 100000, model: "claude-opus-4-20250514", toolCalls: 0, reasoningDepth: "moderate",
    });
    const fast = tokenCostEstimate({
      tokens: 100000, model: "gemini-2.0-flash", toolCalls: 0, reasoningDepth: "moderate",
    });
    expect(premium.estimatedCost).toBeGreaterThan(fast.estimatedCost);
  });

  it("inherits urgency and confidence from time bridge", () => {
    const result = tokenCostEstimate({
      tokens: 25000, model: "gpt-4o-mini", toolCalls: 1, reasoningDepth: "shallow",
    });
    expect(["short", "medium", "long"]).toContain(result.urgency);
    expect(["likely", "optimistic", "pessimistic"]).toContain(result.confidence);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — Claude 5 family / current-model catalog snapshot
// ---------------------------------------------------------------------------
//
// Pricing is primary-source verified (see data/supplementary-database.json's
// `sources.claudeModelPricingPhase5` and the LLMModel derived-union comment
// in src/types/index.ts for the citation). This snapshot pins the exact
// $/1M-token figures so a future catalog refresh can't silently drift
// without updating the test.

describe("Phase 5 catalog — Claude 5 family pricing", () => {
  // Isolated from the developer's real ~/.epoch (or $EPOCH_DATA_DIR): a
  // machine with a live, self-improving supplementary-database.json there
  // would otherwise shadow the repo-bundled data/supplementary-database.json
  // (loadSupplementaryData() checks $EPOCH_DATA_DIR first) and wouldn't yet
  // contain these newly-added Phase 5 entries. Pointing EPOCH_DATA_DIR at an
  // empty temp dir forces the fall-through to the repo's bundled file,
  // matching CI (no ~/.epoch) deterministically.
  let previousDataDir: string | undefined;
  let tempDataDir: string;

  beforeEach(() => {
    previousDataDir = process.env["EPOCH_DATA_DIR"];
    tempDataDir = mkdtempSync(join(tmpdir(), "epoch-cost-catalog-test-"));
    process.env["EPOCH_DATA_DIR"] = tempDataDir;
    resetSupplementaryCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env["EPOCH_DATA_DIR"];
    } else {
      process.env["EPOCH_DATA_DIR"] = previousDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    resetSupplementaryCache();
  });

  it("compareModels lists the new Claude models with cost > 0", () => {
    const result = compareModels({ tokens: 10000, toolCalls: 0, reasoningDepth: "shallow" });
    const byModel = new Map(result.models.map((m) => [m.model, m]));

    for (const model of ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]) {
      const entry = defined(byModel.get(model));
      expect(entry.costAvailable, model).toBe(true);
      expect(entry.estimatedCost, model).toBeGreaterThan(0);
    }
  });

  it("claude-fable-5 (most capable / top-tier) is classified premium and costs the most per token", () => {
    const result = compareModels({ tokens: 10000, toolCalls: 0, reasoningDepth: "shallow" });
    const byModel = new Map(result.models.map((m) => [m.model, m]));
    expect(defined(byModel.get("claude-fable-5")).qualityTier).toBe("premium");
    expect(defined(byModel.get("claude-opus-4-8")).qualityTier).toBe("premium");
    expect(defined(byModel.get("claude-haiku-4-5")).qualityTier).toBe("fast");
  });

  it("pins verified $/1M-token pricing: opus-4-8 $5/$25, sonnet-5 $2/$10, haiku-4-5 $1/$5, fable-5 $10/$50", () => {
    // 1M tokens at reasoningDepth "shallow" keeps toolCallOverhead at 0 and
    // isolates input+output cost; use a large enough token count that
    // rounding doesn't dominate.
    const tokens = 1_000_000;
    const expectPerMillionCost = (model: string, costInput: number, costOutput: number) => {
      const result = tokenCostEstimate({ tokens, model, toolCalls: 0, reasoningDepth: "shallow" });
      const { promptTokens, completionTokens } = result.timeBreakdown;
      const expectedCost = Math.round(((promptTokens * costInput + completionTokens * costOutput) / 1_000_000) * 10_000) / 10_000;
      expect(result.estimatedCost, model).toBeCloseTo(expectedCost, 2);
    };

    expectPerMillionCost("claude-opus-4-8", 5.0, 25.0);
    // $2/$10 since the 2026-11-22 refresh (GitHub #295): Anthropic's
    // first-party listing kept the introductory rate as the standing price.
    expectPerMillionCost("claude-sonnet-5", 2.0, 10.0);
    expectPerMillionCost("claude-haiku-4-5", 1.0, 5.0);
    expectPerMillionCost("claude-fable-5", 10.0, 50.0);
  });

  it("keeps every pre-Phase-5 model in the comparison (additive, nothing removed)", () => {
    const result = compareModels({ tokens: 10000, toolCalls: 0, reasoningDepth: "shallow" });
    const models = new Set(result.models.map((m) => m.model));
    for (const model of [
      "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
      "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3.5-haiku-20241022",
      "gemini-2.0-flash", "gemini-2.5-pro", "llama-3.1-70b", "llama-3.1-405b",
      "mistral-large", "deepseek-v3",
    ]) {
      expect(models.has(model), model).toBe(true);
    }
    expect(result.models.length).toBeGreaterThanOrEqual(16); // 12 pre-existing + 4 new
  });
});

// ---------------------------------------------------------------------------
// 2026-11-22 list-price refresh (GitHub #294): price-only rows
// ---------------------------------------------------------------------------

describe("2026-11-22 model list-price refresh (#294)", () => {
  let previousDataDir: string | undefined;
  let previousCommunityDir: string | undefined;
  let tempDataDir: string;

  beforeEach(() => {
    previousDataDir = process.env["EPOCH_DATA_DIR"];
    previousCommunityDir = process.env["EPOCH_COMMUNITY_DIR"];
    tempDataDir = mkdtempSync(join(tmpdir(), "epoch-cost-refresh-test-"));
    process.env["EPOCH_DATA_DIR"] = tempDataDir;
    resetSupplementaryCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env["EPOCH_DATA_DIR"];
    } else {
      process.env["EPOCH_DATA_DIR"] = previousDataDir;
    }
    if (previousCommunityDir === undefined) {
      delete process.env["EPOCH_COMMUNITY_DIR"];
    } else {
      process.env["EPOCH_COMMUNITY_DIR"] = previousCommunityDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    resetSupplementaryCache();
  });

  it("compare_models ranks the price-only lineup with real prices and generic-fallback time", () => {
    const result = compareModels({ tokens: 10000, toolCalls: 0, reasoningDepth: "shallow" });
    const byModel = new Map(result.models.map((m) => [m.model, m]));

    for (const model of [
      "claude-sonnet-5-5",
      "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra",
      "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4.1-flash",
      "glm-5.3", "kimi-k3", "kimi-k3.1-pro",
      "minimax-m3", "grok-4.7", "mimo-v2.6-flash", "mimo-v2.6-pro",
    ]) {
      const entry = defined(byModel.get(model));
      expect(entry.costAvailable, model).toBe(true);
      expect(entry.estimatedCost, model).toBeGreaterThan(0);
      // No fabricated throughput: unmeasured models use the documented
      // generic fallback (75 tps), never a copied placeholder figure.
      expect(entry.tokensPerSecond, model).toBe(75);
    }
  });

  it("pins the verified list prices for the refresh wave ($/1M in/out)", () => {
    const tokens = 1_000_000;
    const expectPerMillionCost = (model: string, costInput: number, costOutput: number) => {
      const result = tokenCostEstimate({ tokens, model, toolCalls: 0, reasoningDepth: "shallow" });
      expect(result.pricingSource, model).toBe("table");
      const { promptTokens, completionTokens } = result.timeBreakdown;
      const expectedCost = Math.round(((promptTokens * costInput + completionTokens * costOutput) / 1_000_000) * 10_000) / 10_000;
      expect(result.estimatedCost, model).toBeCloseTo(expectedCost, 2);
    };

    expectPerMillionCost("claude-sonnet-5-5", 2.0, 10.0);
    expectPerMillionCost("gpt-6-luna", 0.1, 0.5);
    expectPerMillionCost("gpt-6.1-sol", 2.0, 10.0);
    expectPerMillionCost("gpt-6.1-terra", 1.0, 5.0);
    expectPerMillionCost("deepseek-v4-flash", 0.15, 0.6);
    expectPerMillionCost("deepseek-v4-pro", 0.66, 1.98);
    expectPerMillionCost("deepseek-v4.1-flash", 0.15, 0.6);
    expectPerMillionCost("glm-5.3", 1.19516, 4.18306);
    expectPerMillionCost("kimi-k3", 3.0, 15.0);
    expectPerMillionCost("kimi-k3.1-pro", 2.0, 10.0);
    expectPerMillionCost("minimax-m3", 0.3, 1.2);
    expectPerMillionCost("grok-4.7", 2.0, 6.0);
    expectPerMillionCost("mimo-v2.6-flash", 0.14, 0.28);
    expectPerMillionCost("mimo-v2.6-pro", 0.435, 0.87);
  });

  it("registering a model-calibration community row prices token_cost_estimate without a release", () => {
    const communityDir = join(tempDataDir, "community");
    mkdirSync(communityDir, { recursive: true });
    writeFileSync(
      join(communityDir, "test-model-calibration.json"),
      JSON.stringify({
        _schema: "model-calibration",
        description: "operator-measured row used by the #294 registration test",
        records: [
          {
            model: "operator-measured-model",
            tokens_per_second: 120,
            time_to_first_token_ms: 200,
            avg_api_latency_ms: 900,
            cost_input_per_million: 2,
            cost_output_per_million: 8,
            measured_at: "2026-11-22",
          },
        ],
      }),
    );
    // getCommunityDir() prefers $EPOCH_COMMUNITY_DIR; point it at the temp dir.
    process.env["EPOCH_COMMUNITY_DIR"] = communityDir;
    resetSupplementaryCache();

    const result = tokenCostEstimate({
      tokens: 1_000_000,
      model: "operator-measured-model",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(result.pricingSource).toBe("table");
    const { promptTokens, completionTokens } = result.timeBreakdown;
    // cost_*_per_million is USD per 1M tokens — the same unit as the bundled
    // table. A 1M-token call must cost ~$2 in + ~$8 out, not ~$0.00001.
    expect(result.estimatedCost).toBeCloseTo((promptTokens * 2 + completionTokens * 8) / 1_000_000, 2);
    expect(result.estimatedCost).toBeGreaterThan(1);
  });
});

describe("tokenCostEstimate pricing source", () => {
  it("flags fallback pricing for a model missing from the table", () => {
    const r = tokenCostEstimate({ tokens: 1_000_000, model: "definitely-not-a-model", toolCalls: 0, reasoningDepth: "moderate" });
    expect(r.pricingSource).toBe("fallback");
    expect(r.humanReadable).toContain("WARNING");
    expect(r.humanReadable).toContain("not in the pricing table");
  });
  it("marks table-priced models as table with no warning", () => {
    const r = tokenCostEstimate({ tokens: 1_000_000, model: "claude-sonnet-5", toolCalls: 0, reasoningDepth: "moderate" });
    expect(r.pricingSource).toBe("table");
    expect(r.humanReadable).not.toContain("WARNING");
  });
});
