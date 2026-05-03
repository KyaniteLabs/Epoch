import { recordEstimate } from "../src/lib/feedback.js";

// Record PERT estimate for this feature
const pertId = recordEstimate("pert_estimate", {
  optimistic: 0.25,
  most_likely: 0.5,
  pessimistic: 1.0,
  unit: "hours",
  task_type: "feature"
}, {
  expected: 0.542,
  stdDeviation: 0.125,
  humanReadable: "PERT risk level feature"
});

// Also record a sprint_forecast estimate (data collection)
const sprintId = recordEstimate("sprint_forecast", {
  backlog_points: 34,
  velocity_history: [20, 22, 21, 23, 20, 22],
  sprint_length_days: 14,
  hours_per_sprint: 280,
  task_type: "feature"
}, {
  requiredSprints: 1.5,
  totalHours: 42,
  confidence: "high",
  velocityCv: 0.06,
  humanReadable: "Sprint forecast for PERT risk feature"
});

// Record a token_time_bridge estimate
const ttbId = recordEstimate("token_time_bridge", {
  tokens: 50000,
  model: "claude-sonnet-4",
  task_type: "feature"
}, {
  estimatedSeconds: 180,
  estimatedMinutes: 3,
  humanReadable: "Token time for PERT risk feature"
});

console.log(`PERT_ID=${pertId}`);
console.log(`SPRINT_ID=${sprintId}`);
console.log(`TTB_ID=${ttbId}`);
