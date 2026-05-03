import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const path = join(homedir(), ".epoch", "feedback", "estimates.jsonl");
const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
const est = lines.map(l => JSON.parse(l)).find(e => e.id === "705a5c43-9a40-4a9e-93c0-7a32c38c1cb4");
if (est) {
  console.log("Estimated hours:", est.outputs?.estimatedMinutes ? est.outputs.estimatedMinutes / 60 : "no minutes field");
  console.log("Outputs:", JSON.stringify(est.outputs, null, 2));
} else {
  console.log("Not found");
}
