import { criticalPath, monteCarloSim, sprintForecast } from "../src/lib/estimation.js";
import { tokenTimeBridge } from "../src/lib/analytics.js";
import { recordEstimate } from "../src/lib/feedback.js";
import { randomUUID } from "crypto";

const results: Record<string, string> = {};

// 1. Critical path — cycle detection improvement (already succeeded)
// Already recorded: c03ba4ec-8b30-42c1-b7cd-a3feb0d9cc6d

// 2. Monte Carlo — convergence detection
const mcResult = monteCarloSim([
  { name: "implement convergence check", optimistic: 0.1, mostLikely: 0.25, pessimistic: 0.5 },
  { name: "test convergence", optimistic: 0.05, mostLikely: 0.1, pessimistic: 0.2 },
], 5000, 42);
const mcId = randomUUID();
recordEstimate(mcId, "monte_carlo_schedule", { task_type: "feature", iterations: 5000, seed: 42 }, mcResult as unknown as Record<string, unknown>);
results["monte_carlo_schedule"] = mcId;
console.log(`MC: p50=${mcResult.p50}, p95=${mcResult.p95}, estHours=${mcResult.estimatedHours} -> ${mcId}`);

// 3. Token time bridge — model throughput update
const ttbResult = tokenTimeBridge({ tokens: 50000, model: "claude-sonnet-4-20250514", toolCalls: 3, reasoningDepth: "moderate" });
const ttbId = randomUUID();
recordEstimate(ttbId, "token_time_bridge", { task_type: "infrastructure", tokens: 50000, model: "claude-sonnet-4-20250514" }, ttbResult as unknown as Record<string, unknown>);
results["token_time_bridge"] = ttbId;
console.log(`TTB: ${ttbResult.estimatedMinutes}min, estHours=${(ttbResult.estimatedSeconds / 3600).toFixed(4)} -> ${ttbId}`);

// Already have critical_path and sprint_forecast from previous run
results["critical_path"] = "c03ba4ec-8b30-42c1-b7cd-a3feb0d9cc6d";
results["sprint_forecast"] = "ec0874f4-2b88-4513-8686-31e47ceb8e3a";

console.log("\n--- ALL TOKENS ---");
console.log(JSON.stringify(results, null, 2));
