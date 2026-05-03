import { recordEstimate } from "../src/lib/feedback.js";

// PERT estimate for this task
const pertId = recordEstimate("pert_estimate", {
  optimistic: 0.25,
  most_likely: 0.5,
  pessimistic: 1.0,
  unit: "hours",
  task_type: "refactor"
}, {
  expected: 0.542,
  stdDeviation: 0.125,
  humanReadable: "Schedule risk task-type breakdown"
});

// Schedule risk estimate
const srId = recordEstimate("schedule_risk", {
  estimated_hours: 0.5,
  task_type: "refactor"
}, {
  estimatedHours: 0.5,
  riskLevel: "low",
  humanReadable: "Schedule risk for refactor task-type breakdown feature"
});

// Also record migration task type estimate
const migId = recordEstimate("pert_estimate", {
  optimistic: 0.1,
  most_likely: 0.25,
  pessimistic: 0.5,
  unit: "hours",
  task_type: "migration"
}, {
  expected: 0.267,
  stdDeviation: 0.067,
  humanReadable: "PERT for schedule risk migration data"
});

// Also record design task type estimate
const desId = recordEstimate("pert_estimate", {
  optimistic: 0.1,
  most_likely: 0.2,
  pessimistic: 0.5,
  unit: "hours",
  task_type: "design"
}, {
  expected: 0.233,
  stdDeviation: 0.067,
  humanReadable: "PERT for schedule risk design data"
});

console.log(`PERT_ID=${pertId}`);
console.log(`SR_ID=${srId}`);
console.log(`MIG_ID=${migId}`);
console.log(`DES_ID=${desId}`);
