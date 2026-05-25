#!/usr/bin/env tsx

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  recalculateReferenceDatabase,
  type ReceiverTelemetryRecord,
  type RecalculationSource,
  type ReferenceDatabaseLike,
} from "../src/lib/reference-db-recalculation.js";
import type { ActualRecord, EstimateRecord } from "../src/lib/feedback.js";
import type { ToolCallRecord } from "../src/lib/telemetry.js";

interface Args {
  stageDir?: string;
  baseDb: string;
  out?: string;
  summaryOut?: string;
  write: boolean;
  help: boolean;
}

function usage(): string {
  return `Usage: pnpm run recalculate:reference-db -- --stage-dir <dir> [--write] [--out <path>] [--summary-out <path>]

Recalculates src/data/reference-database.json from staged Epoch telemetry exports.

Expected stage layout:
  <stage>/<source>/estimates.jsonl
  <stage>/<source>/feedback.jsonl
  <stage>/<source>/telemetry.jsonl
  <stage>/<receiver>/telemetry-records.jsonl

Safety:
  - Default is dry-run; pass --write to write the output DB.
  - Legacy receiver records without calibration provenance are baseline-only.
  - Only prospective/correction records update correction factors.
`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseDb: "src/data/reference-database.json",
    write: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--stage-dir") args.stageDir = argv[++i];
    else if (arg === "--base-db") args.baseDb = argv[++i] ?? args.baseDb;
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--summary-out") args.summaryOut = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function parseJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((record): record is T => record !== null);
}

function sourceFromDirectory(dir: string): RecalculationSource | null {
  const name = basename(dir);
  const estimates = parseJsonlFile<EstimateRecord>(join(dir, "estimates.jsonl"));
  const actuals = parseJsonlFile<ActualRecord>(join(dir, "feedback.jsonl"));
  const telemetryEvents = parseJsonlFile<ToolCallRecord>(join(dir, "telemetry.jsonl"));
  const receiverRecords = parseJsonlFile<ReceiverTelemetryRecord>(join(dir, "telemetry-records.jsonl"));

  if (estimates.length === 0 && actuals.length === 0 && telemetryEvents.length === 0 && receiverRecords.length === 0) {
    return null;
  }

  return {
    name,
    ...(estimates.length > 0 && { estimates }),
    ...(actuals.length > 0 && { actuals }),
    ...(telemetryEvents.length > 0 && { telemetryEvents }),
    ...(receiverRecords.length > 0 && { receiverRecords }),
  };
}

function loadSources(stageDir: string): RecalculationSource[] {
  const stage = resolve(stageDir);
  const sources: RecalculationSource[] = [];
  const rootSource = sourceFromDirectory(stage);
  if (rootSource) sources.push(rootSource);

  for (const entry of readdirSync(stage, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const source = sourceFromDirectory(join(stage, entry.name));
    if (source) sources.push(source);
  }

  return sources;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.stageDir) {
    throw new Error("Missing --stage-dir");
  }
  if (!existsSync(args.stageDir)) {
    throw new Error(`Stage directory not found: ${args.stageDir}`);
  }

  const baseDbPath = resolve(args.baseDb);
  const outPath = resolve(args.out ?? (args.write ? args.baseDb : "reference-database.recalculated.json"));
  const baseDb = JSON.parse(readFileSync(baseDbPath, "utf8")) as ReferenceDatabaseLike;
  const sources = loadSources(args.stageDir);
  if (sources.length === 0) {
    throw new Error(`No Epoch telemetry sources found under ${args.stageDir}`);
  }

  const { db, summary } = recalculateReferenceDatabase(baseDb, {
    generatedAt: new Date().toISOString(),
    sourceLabel: "telemetry-prospective-aggregate",
    sources,
  });

  if (args.write || args.out) {
    writeFileSync(outPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  }
  if (args.summaryOut) {
    writeFileSync(resolve(args.summaryOut), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: !args.write && !args.out,
    baseDb: baseDbPath,
    out: args.write || args.out ? outPath : null,
    summary,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
