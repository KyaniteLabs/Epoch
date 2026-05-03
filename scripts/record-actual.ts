import { recordActual } from "../src/lib/feedback.js";

const estimateId = process.argv[2];
const actualHours = parseFloat(process.argv[3]);
const notes = process.argv[4] ?? "";

if (!estimateId || isNaN(actualHours) || actualHours <= 0) {
  console.error("Usage: npx tsx scripts/record-actual.ts <estimateId> <actualHours> [notes]");
  process.exit(1);
}

const ok = recordActual(estimateId, actualHours, notes);
console.log(ok ? `Recorded ${actualHours}h for ${estimateId}` : "Failed to record");
