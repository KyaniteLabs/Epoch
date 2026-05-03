import { monteCarloSim } from "../src/lib/estimation.js";

const r = monteCarloSim([
  { name: "Task", optimistic: 2, mostLikely: 5, pessimistic: 10 },
], 50000, 42);

const p50 = parseFloat(r.p50);
const p10 = parseFloat(r.p10);
const p95 = parseFloat(r.p95);
const iqr = parseFloat(r.p80) - parseFloat(r.p10);
console.log(`p10=${r.p10} p50=${r.p50} p80=${r.p80} p95=${r.p95}`);
console.log(`IQR=${iqr.toFixed(3)}, iqr/p50=${(iqr/p50).toFixed(3)}`);
console.log(`converged=${r.converged}`);
