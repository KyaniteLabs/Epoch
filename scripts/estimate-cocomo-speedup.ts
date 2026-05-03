import { recordEstimate } from "../src/lib/feedback.js";

const cocomoId = recordEstimate("cocomo_estimate", {
  kloc: 5,
  reasoning_complexity: 1.0,
  context_completeness: 1.2,
  transformation_impact: 0.8,
  iterative_cycles: 1.0,
  human_oversight: 1.0,
  task_type: "feature"
}, {
  personMonthsNominal: 16.3,
  personMonthsLlmAdjusted: 1.9,
  humanReadable: "COCOMO AI speedup summary feature"
});

const cpId = recordEstimate("critical_path", {
  tasks: [
    { name: "type_update", duration: 0.5, predecessors: [] },
    { name: "impl", duration: 1.0, predecessors: ["type_update"] },
    { name: "tests", duration: 0.5, predecessors: ["impl"] },
    { name: "registry", duration: 0.25, predecessors: ["tests"] },
  ],
  task_type: "feature"
}, {
  total_duration: 2.25,
  estimatedHours: 18,
  humanReadable: "Critical path for COCOMO speedup feature"
});

const mcId = recordEstimate("monte_carlo_schedule", {
  tasks: [
    { name: "type", optimistic: 0.25, mostLikely: 0.5, pessimistic: 1.0 },
    { name: "impl", optimistic: 0.5, mostLikely: 1.0, pessimistic: 2.0 },
    { name: "tests", optimistic: 0.25, mostLikely: 0.5, pessimistic: 1.5 },
  ],
  iterations: 1000,
  task_type: "feature"
}, {
  p50: "2.08",
  p95: "3.85",
  estimatedHours: 16.6,
  humanReadable: "Monte Carlo for COCOMO speedup feature"
});

console.log(`COCOMO_ID=${cocomoId}`);
console.log(`CP_ID=${cpId}`);
console.log(`MC_ID=${mcId}`);
