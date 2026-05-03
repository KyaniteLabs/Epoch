import { cocomoEstimate } from "../src/lib/estimation.js";
import { recordEstimate } from "../src/lib/feedback.js";
import { randomUUID } from "crypto";

const result = cocomoEstimate({
  kloc: 0.05,
  reasoningComplexity: 1.0,
  contextCompleteness: 1.2,
  transformationImpact: 1.0,
  iterativeCycles: 1.0,
  humanOversight: 1.0,
});
if (!result.ok) { console.error(result.error.message); process.exit(1); }

console.log(`COCOMO: nominal=${result.data.personMonthsNominal}pm, llmAdj=${result.data.personMonthsLlmAdjusted}pm`);

const id = randomUUID();
recordEstimate(id, "cocomo_estimate", {
  kloc: 0.05, task_type: "migration",
  reasoning_complexity: 1.0, context_completeness: 1.2
}, result.data as unknown as Record<string, unknown>);
console.log(`FEEDBACK_TOKEN=${id}`);
