import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const dataDir = process.env.EPOCH_DATA_DIR ?? join(homedir(), ".epoch");

interface EstimateRecord { id: string; tool: string; inputs: Record<string, unknown>; outputs: Record<string, unknown>; recordedAt: string; }
interface ActualRecord { estimateId: string; actualHours: number; notes?: string; reportedAt: string; }

function readLines<T>(filename: string): T[] {
  try { return readFileSync(filename, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

const estimates = readLines<EstimateRecord>(join(dataDir, "estimates.jsonl"));
const actuals = readLines<ActualRecord>(join(dataDir, "feedback.jsonl"));
const actualsMap = new Map(actuals.map(a => [a.estimateId, a]));

const tools = ["cocomo_estimate", "sprint_forecast", "critical_path", "monte_carlo_schedule", "token_time_bridge"];

for (const tool of tools) {
  const toolEsts = estimates.filter(e => e.tool === tool);
  const toolActs = toolEsts.map(e => ({ est: e, act: actualsMap.get(e.id) })).filter(x => x.act);

  const seedCount = toolActs.filter(({ act: a }) => {
    if (!a) return false;
    if (a.estimateId.startsWith("seed-")) return true;
    const notes = (a.notes ?? "").toLowerCase();
    return notes.includes("seed") || notes.includes("synthetic") || notes.includes("dogfood-seed");
  }).length;

  const tinyCount = toolActs.filter(({ act: a }) => a && a.actualHours < 0.25).length;

  console.log(`\n${tool}: ${toolEsts.length} ests, ${toolActs.length} acts (${seedCount} seed, ${tinyCount} tiny)`);

  const nonSeed = toolActs.filter(({ est, act: a }) => {
    if (!a) return false;
    if (a.estimateId.startsWith("seed-")) return false;
    const notes = (a.notes ?? "").toLowerCase();
    if (notes.includes("seed") || notes.includes("synthetic") || notes.includes("dogfood-seed")) return false;
    return a.actualHours >= 0.25;
  });

  if (nonSeed.length > 0) {
    console.log(`  Non-seed actuals: ${nonSeed.length}`);
    for (const { est, act: a } of nonSeed.slice(0, 3)) {
      const hrs = extractHours(est.outputs);
      console.log(`    ${a!.estimateId}: actual=${a!.actualHours}h, extracted=${hrs}, notes="${a!.notes ?? ""}"`);
    }
  } else {
    console.log(`  All actuals are seed/filtered`);
  }
}

function extractHours(outputs: Record<string, unknown>): number | null {
  if (typeof outputs["totalHours"] === "number") return outputs["totalHours"];
  if (typeof outputs["estimatedHours"] === "number") return outputs["estimatedHours"];
  if (typeof outputs["estimatedMinutes"] === "number") return (outputs["estimatedMinutes"] as number) / 60;
  if (typeof outputs["expected"] === "number") {
    const unit = outputs["unit"] as string;
    if (unit === "hours") return outputs["expected"] as number;
    if (unit === "days") return (outputs["expected"] as number) * 8;
    if (!unit) return outputs["expected"] as number;
    return null;
  }
  if (typeof outputs["personMonthsLlmAdjusted"] === "number") return (outputs["personMonthsLlmAdjusted"] as number) * 160;
  if (typeof outputs["correctedEstimate"] === "number") return outputs["correctedEstimate"] as number;
  if (typeof outputs["total_duration"] === "number") return (outputs["total_duration"] as number) * 8;
  return null;
}
