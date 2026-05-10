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
const matched = feedback
  .map(f => ({ actual: f, est: estMap.get(f.estimateId) }))
  .filter(m => m.est);

// Group by task type and compute stats
const byType = new Map<string, { estimated: number; actual: number; ratio: number }[]>();
for (const m of matched) {
  const estHours = extractHours(m.est.outputs);
  if (!estHours || m.actual.actualHours <= 0) continue;
  const taskType = m.est.inputs?.task_type ?? "none";
  const arr = byType.get(taskType) ?? [];
  arr.push({ estimated: estHours, actual: m.actual.actualHours, ratio: m.actual.actualHours / estHours });
  byType.set(taskType, arr);
}

function extractHours(outputs: Record<string, unknown>): number | null {
  if (typeof outputs["totalHours"] === "number") return outputs["totalHours"];
  if (typeof outputs["estimatedHours"] === "number") return outputs["estimatedHours"];
  if (typeof outputs["estimatedMinutes"] === "number") return outputs["estimatedMinutes"] / 60;
  if (typeof outputs["estimatedSeconds"] === "number") return outputs["estimatedSeconds"] / 3600;
  if (typeof outputs["correctedEstimate"] === "number") return outputs["correctedEstimate"];
  if (typeof outputs["total_duration"] === "number") return outputs["total_duration"] * 8;
  return null;
}

console.log("=== Task Type Analysis ===");
for (const [type, records] of byType) {
  const ratios = records.map(r => r.ratio).sort((a, b) => a - b);
  const extremeLow = records.filter(r => r.actual < 0.5);
  const extremeHigh = ratios.filter(r => r > 5);
  console.log(`\n${type}: ${records.length} records`);
  console.log(`  Actuals < 0.5h: ${extremeLow.length}`);
  console.log(`  Ratios > 5x: ${extremeHigh.length}`);
  if (records.length >= 3) {
    const mid = Math.floor(ratios.length / 2);
    const median = ratios.length % 2 === 0
      ? (ratios[mid - 1] + ratios[mid]) / 2
      : ratios[mid];
    console.log(`  Median ratio: ${median.toFixed(2)}`);
    console.log(`  Min/Max ratio: ${ratios[0].toFixed(2)} / ${ratios[ratios.length - 1].toFixed(2)}`);
  }
  // Show worst outliers
  const worst = records.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1)).slice(0, 3);
  console.log(`  Worst outliers:`);
  for (const w of worst) {
    console.log(`    est=${w.estimated.toFixed(1)}h actual=${w.actual.toFixed(2)}h ratio=${w.ratio.toFixed(2)}`);
  }
}

// Seed record detection
const seedRecords = feedback.filter(f => f.notes?.includes("seed") || f.estimateId?.startsWith("seed-"));
console.log(`\n=== Seed Records ===`);
console.log(`Explicitly marked seed records: ${seedRecords.length}`);

// Check for records with very low actuals (likely seed artifacts)
const lowActuals = feedback.filter(f => f.actualHours < 0.01);
console.log(`Actuals < 0.01h (microtask calibration floor): ${lowActuals.length}`);

// Check for records with actuals between 0.01 and 1.0
const suspiciousActuals = feedback.filter(f => f.actualHours >= 0.01 && f.actualHours < 1.0);
console.log(`Actuals 0.01-1.0h (fast real tasks; inspect provenance before filtering): ${suspiciousActuals.length}`);
