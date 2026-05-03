import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const dbPath = join(homedir(), ".epoch", "reference-database.json");
const db = JSON.parse(readFileSync(dbPath, "utf-8"));

console.log("Task type correction factors (used by RCE):");
for (const [type, cf] of Object.entries(db.taskTypeCorrectionFactors ?? {}).sort(([,a],[,b]) => (a as number) - (b as number))) {
  console.log(`  ${type}: ${cf}`);
}

console.log(`\nGlobal CF: ${db.globalCorrectionFactor}`);

// Now simulate: for a complexity-1 feature task with "small" scope
// scopeBaseline = getScopeBaseline("feature").small * COMPLEXITY_MULTIPLIER[1]
// = 2 * 0.7 = 1.4h (raw estimate)
// correctedEstimate = rawEstimate * CF(0.56) = 1.4 * 0.56 = 0.78h
// Actual median for complexity 1 is 0.29 * estimate → 1.4 * 0.29 = 0.41h

console.log("\nSimulation: complexity 1 feature, small scope");
console.log("  Raw estimate: ~1.4h (2h baseline × 0.7 complexity multiplier)");
console.log(`  Corrected: ~${(1.4 * 0.56).toFixed(2)}h (× 0.56 CF for feature)`);
console.log("  Actual median: ~0.41h (ratio 0.29)");
console.log("  Still 2x overestimate after correction");

console.log("\nSimulation: complexity 3 feature, medium scope");
console.log("  Raw estimate: ~8h (8h baseline × 1.0 complexity multiplier)");
console.log(`  Corrected: ~${(8 * 0.56).toFixed(2)}h (× 0.56 CF for feature)`);
console.log("  Actual median: ~3.0h (ratio 0.38)");
console.log("  Still ~50% overestimate after correction");
