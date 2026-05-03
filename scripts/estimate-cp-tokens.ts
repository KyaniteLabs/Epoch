import { recordEstimate } from "../src/lib/feedback.js";

// Critical path estimate
const cpId = recordEstimate("critical_path", {
  tasks: [
    { name: "type_update", duration: 0.5, predecessors: [] },
    { name: "impl", duration: 0.75, predecessors: ["type_update"] },
    { name: "tests", duration: 0.5, predecessors: ["impl"] },
  ],
  task_type: "feature"
}, {
  total_duration: 1.75,
  estimatedHours: 14,
  humanReadable: "Critical path for CP token cost feature"
});

// Token time bridge estimate
const ttbId = recordEstimate("token_time_bridge", {
  tokens: 80000,
  model: "claude-sonnet-4",
  task_type: "feature"
}, {
  estimatedSeconds: 300,
  estimatedMinutes: 5,
  humanReadable: "Token time for CP token cost feature"
});

// Monte carlo estimate
const mcId = recordEstimate("monte_carlo_schedule", {
  tasks: [
    { name: "type", optimistic: 0.2, mostLikely: 0.4, pessimistic: 0.8 },
    { name: "impl", optimistic: 0.3, mostLikely: 0.75, pessimistic: 1.5 },
    { name: "tests", optimistic: 0.2, mostLikely: 0.5, pessimistic: 1.2 },
  ],
  iterations: 1000,
  task_type: "feature"
}, {
  p50: "1.7",
  p95: "3.1",
  estimatedHours: 13.6,
  humanReadable: "Monte Carlo for CP token cost feature"
});

console.log(`CP_ID=${cpId}`);
console.log(`TTB_ID=${ttbId}`);
console.log(`MC_ID=${mcId}`);
