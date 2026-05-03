import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const feedbackPath = join(homedir(), ".epoch", "feedback.jsonl");
const estimatesPath = join(homedir(), ".epoch", "estimates.jsonl");

const feedback = readFileSync(feedbackPath, "utf-8")
  .split("\n").filter(Boolean).map(l => JSON.parse(l));
const estimates = readFileSync(estimatesPath, "utf-8")
  .split("\n").filter(Boolean).map(l => JSON.parse(l));

// Count pert_estimate calls by complexity level
const pertEstimates = estimates.filter(e => e.tool === "pert_estimate");
const byComplexity = new Map<number, number>();
const byUrgency = new Map<string, number>();
for (const e of pertEstimates) {
  const inputs = e.inputs;
  const opt = inputs.optimistic ?? inputs.o;
  const ml = inputs.most_likely ?? inputs.m;
  const pess = inputs.pessimistic ?? inputs.p;
  const expected = (opt + 4 * ml + pess) / 6;
  const range = pess - opt;
  
  // Infer urgency from expected time
  let urgency = "medium";
  if (expected < 2) urgency = "short";
  else if (expected > 48) urgency = "long";
  
  byUrgency.set(urgency, (byUrgency.get(urgency) ?? 0) + 1);
}

console.log("PERT estimate distribution:");
console.log(`  Total: ${pertEstimates.length}`);
for (const [u, c] of byUrgency) console.log(`  Urgency ${u}: ${c}`);

// Check for code issues in src/lib
import { readdirSync, statSync } from "node:fs";
const srcLib = "/Users/simongonzalezdecruz/Desktop/Epoch/src/lib";
const files = readdirSync(srcLib).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
console.log(`\nSource files in src/lib: ${files.length}`);
for (const f of files) {
  const stat = statSync(join(srcLib, f));
  console.log(`  ${f}: ${(stat.size / 1024).toFixed(1)}KB`);
}
