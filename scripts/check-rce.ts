import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const feedbackPath = join(homedir(), ".epoch", "feedback.jsonl");
const estimatesPath = join(homedir(), ".epoch", "estimates.jsonl");

const feedback = readFileSync(feedbackPath, "utf-8")
  .split("\n").filter(Boolean).map(l => JSON.parse(l));
const estimates = readFileSync(estimatesPath, "utf-8")
  .split("\n").filter(Boolean).map(l => JSON.parse(l));

const estMap = new Map(estimates.map(e => [e.id, e]));

// Check reference_class_estimate matches — this is our biggest data source (104 pairs)
const rceMatches = feedback.filter(a => {
  const est = estMap.get(a.estimateId);
  return est?.tool === "reference_class_estimate";
});

// Group by complexity
const byComplexity = new Map<number, { est: number; act: number }[]>();
for (const a of rceMatches) {
  const est = estMap.get(a.estimateId);
  if (!est) continue;
  const complexity = est.inputs?.complexity ?? 0;
  const correctedEst = est.outputs?.correctedEstimate ?? 0;
  if (complexity && correctedEst) {
    const arr = byComplexity.get(complexity) ?? [];
    arr.push({ est: correctedEst, act: a.actualHours });
    byComplexity.set(complexity, arr);
  }
}

console.log("RCE by complexity level:");
for (const [c, records] of [...byComplexity].sort((a, b) => a[0] - b[0])) {
  const ratios = records.map(r => r.act / r.est).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 0
    ? ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2
    : ratios[mid];
  console.log(`  complexity ${c}: ${records.length} records, median ratio=${median?.toFixed(2)}, range=${ratios[0]?.toFixed(2)}-${ratios[ratios.length - 1]?.toFixed(2)}`);
}

// Check by scope
const byScope = new Map<string, { est: number; act: number }[]>();
for (const a of rceMatches) {
  const est = estMap.get(a.estimateId);
  if (!est) continue;
  const scope = est.outputs?.scopeUsed ?? "unknown";
  const correctedEst = est.outputs?.correctedEstimate ?? 0;
  if (correctedEst) {
    const arr = byScope.get(scope) ?? [];
    arr.push({ est: correctedEst, act: a.actualHours });
    byScope.set(scope, arr);
  }
}

console.log("\nRCE by scope:");
for (const [s, records] of [...byScope].sort()) {
  const ratios = records.map(r => r.act / r.est).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 0
    ? ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2
    : ratios[mid];
  console.log(`  ${s}: ${records.length} records, median ratio=${median?.toFixed(2)}`);
}
