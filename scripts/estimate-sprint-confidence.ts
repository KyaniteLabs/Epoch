import { recordEstimate } from "../src/lib/feedback.js";

const estId = recordEstimate("pert_estimate", {
  optimistic: 0.25,
  most_likely: 0.5,
  pessimistic: 1.5,
  unit: "hours",
  task_type: "feature"
}, {
  expected: 0.625,
  confidence95: [0.0, 1.97],
  humanReadable: "Sprint confidence rating feature"
});

console.log(`ESTIMATE_ID=${estId}`);
