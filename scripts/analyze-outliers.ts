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

// Simulate what matchEstimatesToActuals does now
const matched: { est: any; act: any; estHours: number; ratio: number; isSeed: boolean }[] = [];

function extractHours(outputs: Record<string, unknown>): number | null {
  if (typeof outputs["totalHours"] === "number") return outputs["totalHours"];
  if (typeof outputs["estimatedHours"] === "number") return outputs["estimatedHours"];
  if (typeof outputs["estimatedMinutes"] === "number") return outputs["estimatedMinutes"] / 60;
  if (typeof outputs["estimatedSeconds"] === "number") return outputs["estimatedSeconds"] / 3600;
  if (typeof outputs["expected"] === "number") {
    const unit = outputs["unit"] as string;
    if (unit === "hours") return outputs["expected"];
    if (unit === "days") return outputs["expected"] * 8;
    if (unit === "weeks") return outputs["expected"] * 40;
    return outputs["expected"];
  }
  if (typeof outputs["personMonthsLlmAdjusted"] === "number") return outputs["personMonthsLlmAdjusted"] * 160;
  if (typeof outputs["correctedEstimate"] === "number") return outputs["correctedEstimate"];
  if (typeof outputs["total_duration"] === "number") return outputs["total_duration"] * 8;
  return null;
}

function isSeed(act: any): boolean {
  if (act.estimateId?.startsWith("seed-")) return true;
  const notes = (act.notes ?? "").toLowerCase();
  return notes.includes("seed") || notes.includes("synthetic") || notes.includes("dogfood-seed");
}

for (const act of feedback) {
  if (act.actualHours < 0.01) continue;
  if (isSeed(act)) continue;
  
  const est = estMap.get(act.estimateId);
  if (!est) continue;
  
  const estHours = extractHours(est.outputs);
  if (estHours === null) continue;
  
  const ratio = act.actualHours / estHours;
  if (ratio < 0.03) continue;
  
  const taskType = est.inputs?.task_type ?? "none";
  matched.push({ est, act, estHours, ratio, isSeed: false });
}

// Show records sorted by ratio (worst outliers first)
console.log(`\nRemaining records: ${matched.length}`);
console.log(`\nWorst 20 outliers (lowest ratio = most overestimated):`);
const sorted = matched.sort((a, b) => a.ratio - b.ratio);
for (const m of sorted.slice(0, 20)) {
  const taskType = m.est.inputs?.task_type ?? "none";
  const notes = m.act.notes ?? "";
  console.log(`  est=${m.estHours.toFixed(1)}h actual=${m.act.actualHours.toFixed(2)}h ratio=${m.ratio.toFixed(3)} tool=${m.est.tool} type=${taskType} notes="${notes.slice(0, 40)}"`);
}

console.log(`\nBest 10 (closest to 1.0):`);
const byCloseness = [...matched].sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1));
for (const m of byCloseness.slice(0, 10)) {
  const taskType = m.est.inputs?.task_type ?? "none";
  console.log(`  est=${m.estHours.toFixed(1)}h actual=${m.act.actualHours.toFixed(2)}h ratio=${m.ratio.toFixed(3)} tool=${m.est.tool} type=${taskType}`);
}

// Count by notes pattern
const withNotes = matched.filter(m => m.act.notes);
const notePatterns = new Map<string, number>();
for (const m of withNotes) {
  const n = m.act.notes.toLowerCase();
  let pattern = "other";
  if (n.includes("dogfood")) pattern = "dogfood";
  else if (n.includes("calibration")) pattern = "calibration";
  else if (n.includes("actual")) pattern = "actual";
  else if (n.includes("batch")) pattern = "batch";
  notePatterns.set(pattern, (notePatterns.get(pattern) ?? 0) + 1);
}
console.log(`\nNotes patterns:`);
for (const [p, c] of notePatterns) console.log(`  ${p}: ${c}`);
