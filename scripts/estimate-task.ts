import { pertEstimate } from "../src/lib/estimation.js";
import { recordEstimate } from "../src/lib/feedback.js";
import { randomUUID } from "crypto";

const result = pertEstimate(0.25, 0.5, 1.5, "hours");
if (!result.ok) { console.error(result.error.message); process.exit(1); }

console.log(`Expected: ${result.data.expected}h, 95% CI: [${result.data.confidence95[0]}, ${result.data.confidence95[1]}]h`);

const id = randomUUID();
recordEstimate(id, "pert_estimate", {
  optimistic: 0.25, mostLikely: 0.5, pessimistic: 1.5, unit: "hours"
}, result.data as unknown as Record<string, unknown>);
console.log(`FEEDBACK_TOKEN=${id}`);
