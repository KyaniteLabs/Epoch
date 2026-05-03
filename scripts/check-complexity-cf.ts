import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const dbPath = join(homedir(), ".epoch", "reference-database.json");
const db = JSON.parse(readFileSync(dbPath, "utf-8"));

console.log("Complexity correction factors:");
if (db.complexityCorrectionFactors) {
  for (const [taskType, complexities] of Object.entries(db.complexityCorrectionFactors)) {
    console.log(`  ${taskType}:`);
    for (const [c, f] of Object.entries(complexities as Record<string, number>).sort(([a], [b]) => Number(a) - Number(b))) {
      console.log(`    complexity ${c}: ${f}`);
    }
  }
} else {
  console.log("  (none computed)");
}
