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

// Check what happened to the tools that used to have data
const tools = ["cocomo_estimate", "sprint_forecast", "critical_path", "monte_carlo_schedule", "token_time_bridge"];
for (const tool of tools) {
  const toolEstimates = estimates.filter(e => e.tool === tool);
  const matched = feedback.filter(a => {
    const est = estMap.get(a.estimateId);
    return est?.tool === tool;
  });
  
  console.log(`\n${tool}: ${toolEstimates.length} estimates, ${matched.length} feedback records`);
  
  let filteredSeed = 0, filteredMinAct = 0, filteredRatio = 0, kept = 0;
  for (const a of matched) {
    if (a.actualHours < 0.01) { filteredMinAct++; continue; }
    if (isSeed(a)) { filteredSeed++; continue; }
    const est = estMap.get(a.estimateId);
    if (!est) continue;
    const estHours = extractHours(est.outputs);
    if (estHours === null) { console.log(`  No hours extraction for ${a.estimateId}`); continue; }
    const ratio = a.actualHours / estHours;
    if (ratio < 0.03) { filteredRatio++; console.log(`    Ratio filter: est=${estHours.toFixed(1)}h act=${a.actualHours.toFixed(2)}h ratio=${ratio.toFixed(4)} notes="${(a.notes ?? "").slice(0, 50)}"`); continue; }
    kept++;
  }
  console.log(`  Kept: ${kept}, Filtered seed: ${filteredSeed}, Filtered minAct: ${filteredMinAct}, Filtered ratio: ${filteredRatio}`);
}
