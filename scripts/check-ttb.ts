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

// Find token_time_bridge matches
const ttbEstimates = estimates.filter(e => e.tool === "token_time_bridge");
console.log(`token_time_bridge estimates: ${ttbEstimates.length}`);

// Show a few to understand the output format
for (const e of ttbEstimates.slice(0, 3)) {
  console.log(`\nID: ${e.id}`);
  console.log(`  Inputs: tokens=${e.inputs.tokens}, model=${e.inputs.model}`);
  console.log(`  Outputs: estimatedMinutes=${e.outputs.estimatedMinutes}, estimatedSeconds=${e.outputs.estimatedSeconds}`);
  
  const act = feedback.find(a => a.estimateId === e.id);
  if (act) {
    console.log(`  Actual: ${act.actualHours}h, ratio: ${(act.actualHours / (e.outputs.estimatedMinutes / 60)).toFixed(3)}`);
  } else {
    console.log(`  No actual recorded`);
  }
}

// Check what the estimatedHours extraction produces
const ttbMatched = feedback.filter(a => {
  const est = estMap.get(a.estimateId);
  return est?.tool === "token_time_bridge";
});

console.log(`\nMatched token_time_bridge: ${ttbMatched.length}`);
for (const a of ttbMatched.slice(0, 5)) {
  const est = estMap.get(a.estimateId);
  if (!est) continue;
  const estMin = est.outputs.estimatedMinutes;
  const estHours = estMin / 60;
  console.log(`  estMinutes=${estMin} → estHours=${estHours.toFixed(3)}, actual=${a.actualHours}h, ratio=${(a.actualHours / estHours).toFixed(2)}`);
}
