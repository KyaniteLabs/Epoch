import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const dataDir = process.env.EPOCH_DATA_DIR ?? join(homedir(), ".epoch");

interface EstimateRecord { id: string; tool: string; inputs: Record<string, unknown>; outputs: Record<string, unknown>; }
interface ActualRecord { estimateId: string; actualHours: number; notes?: string; }

function readLines<T>(filename: string): T[] {
  try { return readFileSync(filename, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

const estimates = readLines<EstimateRecord>(join(dataDir, "estimates.jsonl"));
const actuals = readLines<ActualRecord>(join(dataDir, "feedback.jsonl"));
const actualsMap = new Map(actuals.map(a => [a.estimateId, a]));

const sprintEsts = estimates.filter(e => e.tool === "sprint_forecast");
console.log(`Sprint estimates: ${sprintEsts.length}`);
for (const e of sprintEsts.slice(0, 3)) {
  const act = actualsMap.get(e.id);
  console.log(`  ${e.id}: outputs keys=${Object.keys(e.outputs).join(",")}`);
  console.log(`    totalHours=${e.outputs["totalHours"]}, actual=${act?.actualHours ?? "none"}`);
}
