import { criticalPath, monteCarloSim, sprintForecast } from "../src/lib/estimation.js";
import { tokenTimeBridge } from "../src/lib/analytics.js";
import { recordEstimate, recordActual } from "../src/lib/feedback.js";

// Record properly: recordEstimate(toolName, inputs, outputs) returns estimateId

// Monte Carlo
const mcResult = monteCarloSim([
  { name: "convergence feature", optimistic: 0.1, mostLikely: 0.25, pessimistic: 0.5 },
  { name: "tests", optimistic: 0.05, mostLikely: 0.1, pessimistic: 0.2 },
], 5000, 42);
const mcId = recordEstimate("monte_carlo_schedule", { task_type: "feature" }, mcResult as unknown as Record<string, unknown>);
recordActual(mcId, 0.5, "Monte Carlo convergence detection");
console.log(`MC: id=${mcId}, estHours=${mcResult.estimatedHours}`);

// Token time bridge
const ttbResult = tokenTimeBridge({ tokens: 50000, model: "claude-sonnet-4-20250514", toolCalls: 3, reasoningDepth: "moderate" });
const ttbId = recordEstimate("token_time_bridge", { task_type: "infrastructure" }, ttbResult as unknown as Record<string, unknown>);
recordActual(ttbId, 0.5, "Token time bridge model data update");
console.log(`TTB: id=${ttbId}, min=${ttbResult.estimatedMinutes}`);

// Sprint forecast
const sfResult = sprintForecast({ backlogPoints: 13, velocityHistory: [21, 24, 19, 22], sprintLengthDays: 14, hoursPerSprint: 80 });
const sfId = recordEstimate("sprint_forecast", { task_type: "feature" }, sfResult.data as unknown as Record<string, unknown>);
recordActual(sfId, 0.5, "Sprint forecast optimisticSprints feature");
console.log(`SF: id=${sfId}, totalHours=${sfResult.data?.totalHours}`);

// Critical path
const cpResult = criticalPath([
  { name: "analyze", duration: 0.1, predecessors: [] },
  { name: "implement", duration: 0.3, predecessors: ["analyze"] },
]);
if (cpResult.ok) {
  const cpId = recordEstimate("critical_path", { task_type: "bugfix" }, cpResult.data as unknown as Record<string, unknown>);
  recordActual(cpId, 0.5, "Critical path improvement work");
  console.log(`CP: id=${cpId}, estHours=${cpResult.data.estimatedHours}`);
}

// COCOMO
import { cocomoEstimate } from "../src/lib/estimation.js";
const ccResult = cocomoEstimate({ kloc: 0.05, reasoningComplexity: 1.0, contextCompleteness: 1.2, transformationImpact: 1.0, iterativeCycles: 1.0, humanOversight: 1.0 });
if (ccResult.ok) {
  const ccId = recordEstimate("cocomo_estimate", { task_type: "migration" }, ccResult.data as unknown as Record<string, unknown>);
  recordActual(ccId, 0.3, "COCOMO estimate for schema improvements");
  console.log(`CC: id=${ccId}, adj=${ccResult.data.personMonthsLlmAdjusted}`);
}

console.log("\nDone — 5 estimate/actual pairs recorded with correct IDs");
