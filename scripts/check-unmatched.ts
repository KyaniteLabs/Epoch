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
const feedbackIds = new Set(feedback.map(a => a.estimateId));

// Find estimates that have feedback but no hours extraction
let total = 0, extracted = 0, failed = 0;
const failedTools = new Map<string, number>();

for (const est of estimates) {
  if (!feedbackIds.has(est.id)) continue;
  total++;
  
  const outputs = est.outputs;
  let estHours: number | null = null;
  
  if (typeof outputs["totalHours"] === "number") estHours = outputs["totalHours"];
  else if (typeof outputs["estimatedHours"] === "number") estHours = outputs["estimatedHours"];
  else if (typeof outputs["estimatedMinutes"] === "number") estHours = outputs["estimatedMinutes"] / 60;
  else if (typeof outputs["estimatedSeconds"] === "number") estHours = outputs["estimatedSeconds"] / 3600;
  else if (typeof outputs["expected"] === "number") {
    const unit = outputs["unit"] as string;
    if (unit === "hours") estHours = outputs["expected"];
    else if (unit === "days") estHours = outputs["expected"] * 8;
    else if (unit === "weeks") estHours = outputs["expected"] * 40;
    else if (unit === "months") estHours = outputs["expected"] * 160;
    else if (!unit) estHours = outputs["expected"];
  }
  else if (typeof outputs["personMonthsLlmAdjusted"] === "number") estHours = outputs["personMonthsLlmAdjusted"] * 160;
  else if (typeof outputs["correctedEstimate"] === "number") estHours = outputs["correctedEstimate"];
  else if (typeof outputs["total_duration"] === "number") estHours = outputs["total_duration"] * 8;
  
  if (estHours !== null) {
    extracted++;
  } else {
    failed++;
    failedTools.set(est.tool, (failedTools.get(est.tool) ?? 0) + 1);
  }
}

console.log(`Estimates with feedback: ${total}`);
console.log(`Hours extracted: ${extracted}`);
console.log(`Extraction failed: ${failed}`);
console.log(`\nTools where extraction failed:`);
for (const [tool, count] of [...failedTools].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tool}: ${count}`);
  // Show output keys for one example
  const example = estimates.find(e => e.tool === tool && feedbackIds.has(e.id));
  if (example) {
    console.log(`    Output keys: ${Object.keys(example.outputs).join(", ")}`);
  }
}
