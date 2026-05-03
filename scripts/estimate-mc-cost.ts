import { recordEstimate } from "../src/lib/feedback.js";

const mcId = recordEstimate("monte_carlo_schedule", {
  tasks: [
    { name: "impl", optimistic: 0.5, mostLikely: 1.0, pessimistic: 2.0 },
    { name: "tests", optimistic: 0.25, mostLikely: 0.5, pessimistic: 1.5 },
  ],
  iterations: 1000,
  task_type: "refactor"
}, {
  p50: "1.5",
  p95: "3.2",
  estimatedHours: 12,
  humanReadable: "Monte Carlo cost estimate feature"
});

const pertId = recordEstimate("pert_estimate", {
  optimistic: 0.15,
  most_likely: 0.3,
  pessimistic: 0.75,
  unit: "hours",
  task_type: "refactor"
}, {
  expected: 0.342,
  humanReadable: "PERT for MC cost feature"
});

console.log(`MC_ID=${mcId}`);
console.log(`PERT_ID=${pertId}`);
