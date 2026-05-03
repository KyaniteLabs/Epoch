import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const dbPath = join(homedir(), ".epoch", "reference-database.json");
const db = JSON.parse(readFileSync(dbPath, "utf-8"));

console.log(`Global CF: ${db.globalCorrectionFactor}`);
console.log(`\nTask type CFs:`);
for (const [type, cf] of Object.entries(db.taskTypeCorrectionFactors ?? {}).sort(([,a],[,b]) => (a as number) - (b as number))) {
  console.log(`  ${type}: ${cf}`);
}
console.log(`\nEstimation accuracy:`);
if (db.estimationAccuracy?.correctionFactors?.byTaskType) {
  for (const [type, cf] of Object.entries(db.estimationAccuracy.correctionFactors.byTaskType)) {
    console.log(`  ${type}: ${cf}`);
  }
}
