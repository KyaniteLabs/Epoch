import { describe, it, expect, vi } from "vitest";
import { tokenTimeBridge } from "./analytics.js";

vi.mock("./telemetry.js", () => ({
  getTelemetry: vi.fn(() => ({
    getModelStats: vi.fn(() => undefined),
  })),
}));

vi.mock("./self-improve.js", () => ({
  loadReferenceDb: vi.fn(() => null),
  getTaskTypeCorrectionFactor: vi.fn(() => 1.8),
  getToolTaskCorrectionFactor: vi.fn(() => 1.8),
  getGlobalCorrectionFactor: vi.fn(() => 1.8),
}));

const ALL_MODELS = [
  "claude-3.5-haiku-20241022",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "deepseek-v3",
  "gemini-2.0-flash",
  "gemini-2.5-pro",
  "gpt-4-turbo",
  "gpt-4o",
  "gpt-4o-mini",
  "llama-3.1-405b",
  "llama-3.1-70b",
  "mistral-large",
] as const;

describe("tokenTimeBridge", () => {
  it("all 12 calibrated models produce sensible estimates", () => {
    const tokens = 100_000;
    for (const model of ALL_MODELS) {
      const result = tokenTimeBridge({
        tokens,
        model,
        toolCalls: 0,
        reasoningDepth: "moderate",
      });
      expect(result.estimatedSeconds).toBeGreaterThan(0);
      expect(result.estimatedMinutes).toBeGreaterThan(0);
      expect(result.confidence).toBe("likely");
      expect(result.model).toBe(model);
      expect(result.tokens).toBe(tokens);
      // Sanity: no model should estimate > 10 hours for 100k tokens
      expect(result.estimatedMinutes).toBeLessThan(600);
    }
  });

  it("reasoning depth scales time correctly (shallow < moderate < deep)", () => {
    // Use a slow model with small tokens so reasoning overhead is visible
    const model = "gpt-4-turbo"; // 27.5 tps, 1405ms reasoning overhead
    const shallow = tokenTimeBridge({ tokens: 1000, model, toolCalls: 0, reasoningDepth: "shallow" });
    const moderate = tokenTimeBridge({ tokens: 1000, model, toolCalls: 0, reasoningDepth: "moderate" });
    const deep = tokenTimeBridge({ tokens: 1000, model, toolCalls: 0, reasoningDepth: "deep" });

    // Deep reasoning overhead: 1405ms * 5 = 7.025s vs shallow: 1.405s
    expect(deep.estimatedSeconds).toBeGreaterThan(shallow.estimatedSeconds);
    expect(deep.estimatedSeconds).toBeGreaterThan(moderate.estimatedSeconds);
  });

  it("tool calls add proportional overhead", () => {
    const model = "gpt-4o";
    const base = tokenTimeBridge({ tokens: 50000, model, toolCalls: 0, reasoningDepth: "shallow" });
    const withTools = tokenTimeBridge({ tokens: 50000, model, toolCalls: 10, reasoningDepth: "shallow" });

    expect(withTools.estimatedSeconds).toBeGreaterThan(base.estimatedSeconds);
    // 10 tool calls * 200ms = 2s overhead
    expect(withTools.estimatedSeconds - base.estimatedSeconds).toBeGreaterThanOrEqual(2);
  });

  it("breakdown math is internally consistent", () => {
    const result = tokenTimeBridge({
      tokens: 100000,
      model: "gemini-2.0-flash",
      toolCalls: 5,
      reasoningDepth: "moderate",
    });

    // promptTokens + completionTokens should approximately equal total tokens
    const total = result.breakdown.promptTokens + result.breakdown.completionTokens;
    expect(Math.abs(total - result.tokens)).toBeLessThanOrEqual(2); // rounding

    // tool overhead should be positive when toolCalls > 0
    expect(result.breakdown.toolOverheadSeconds).toBeGreaterThan(0);
  });

  it("urgency classification: short for <2h, medium for 2-48h, long for >48h", () => {
    // Small token count → short
    const short_ = tokenTimeBridge({ tokens: 1000, model: "gpt-4o-mini", toolCalls: 0, reasoningDepth: "shallow" });
    expect(short_.urgency).toBe("short");

    // Very large token count with slow model → check it's medium or long
    const large = tokenTimeBridge({ tokens: 10_000_000, model: "gpt-4-turbo", toolCalls: 50, reasoningDepth: "deep" });
    expect(["medium", "long"]).toContain(large.urgency);
  });

  it("unknown model uses fallback calibration", () => {
    const result = tokenTimeBridge({
      tokens: 5000,
      model: "some-future-model-v99",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(result.estimatedSeconds).toBeGreaterThan(0);
    // Fallback uses optimistic confidence
    expect(result.confidence).toBe("optimistic");
  });

  it("human-readable string includes key information", () => {
    const result = tokenTimeBridge({
      tokens: 50000,
      model: "claude-opus-4-20250514",
      toolCalls: 3,
      reasoningDepth: "deep",
    });
    expect(result.humanReadable).toContain("50,000");
    expect(result.humanReadable).toContain("claude-opus-4-20250514");
    expect(result.humanReadable).toContain("deep");
    expect(result.humanReadable).toContain("3");
  });

  it("zero tool calls produces zero tool overhead", () => {
    const result = tokenTimeBridge({
      tokens: 10000,
      model: "claude-sonnet-4-20250514",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(result.breakdown.toolOverheadSeconds).toBe(0);
  });

  it("estimatedMinutes is derived from estimatedSeconds", () => {
    const result = tokenTimeBridge({
      tokens: 25000,
      model: "gemini-2.0-flash",
      toolCalls: 2,
      reasoningDepth: "moderate",
    });
    const expectedMinutes = Math.round(result.estimatedSeconds / 60 * 10) / 10;
    expect(result.estimatedMinutes).toBe(expectedMinutes);
  });

  it("fast model (gemini-2.0-flash) is faster than slow model (gpt-4-turbo)", () => {
    const fast = tokenTimeBridge({ tokens: 50000, model: "gemini-2.0-flash", toolCalls: 0, reasoningDepth: "moderate" });
    const slow = tokenTimeBridge({ tokens: 50000, model: "gpt-4-turbo", toolCalls: 0, reasoningDepth: "moderate" });
    expect(fast.estimatedSeconds).toBeLessThan(slow.estimatedSeconds);
  });
});
