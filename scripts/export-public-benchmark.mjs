#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Export Public Benchmark
// Reads community data and local calibration data, produces an aggregated
// anonymized benchmark dataset with NO individual records — only statistics.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
const PROJECT_ROOT = new URL("..", import.meta.url).pathname;
const COMMUNITY_DIR = join(PROJECT_ROOT, "data", "community");
const COCOMO_FILE = join(PROJECT_ROOT, "data", "cocomo-calibration-data.json");
const OUTPUT_FILE = join(PROJECT_ROOT, "data", "public-benchmark.json");

// Collect all estimate/actual pairs
const pairs = [];
const contributors = new Set();

// ---- 1. Read community data -------------------------------------------------

if (existsSync(COMMUNITY_DIR)) {
  const files = readdirSync(COMMUNITY_DIR).filter((f) => f.endsWith(".json") && f !== "example-estimation.json");

  for (const file of files) {
    const filePath = join(COMMUNITY_DIR, file);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (data.records && Array.isArray(data.records)) {
        for (const rec of data.records) {
          if (rec.estimated_hours && rec.actual_hours) {
            pairs.push({
              task_type: rec.task_type ?? "feature",
              complexity: rec.complexity ?? null,
              tool: rec.tool ?? "community",
              estimated_hours: rec.estimated_hours,
              actual_hours: rec.actual_hours,
              ratio: Math.round((rec.actual_hours / rec.estimated_hours) * 10000) / 10000,
            });
            if (rec.contributor_id) contributors.add(rec.contributor_id);
          }
        }
      }
      console.log(`  READ ${file}: ${data.records?.length ?? 0} records`);
    } catch {
      console.log(`  SKIP ${file} (parse error)`);
    }
  }
}

// ---- 2. Read COCOMO calibration data ----------------------------------------

if (existsSync(COCOMO_FILE)) {
  try {
    const data = JSON.parse(readFileSync(COCOMO_FILE, "utf-8"));
    if (data.projects && Array.isArray(data.projects)) {
      for (const proj of data.projects) {
        const est = proj.estimated_effort_months ?? proj.estimated_months;
        const act = proj.actual_effort_months ?? proj.actual_months;
        if (est && act) {
          pairs.push({
            task_type: "feature",
            complexity: null,
            tool: "cocomo_calibration",
            estimated_hours: est * 160,
            actual_hours: act * 160,
            ratio: Math.round((act / est) * 10000) / 10000,
          });
        }
      }
      console.log(`  READ cocomo-calibration-data.json: ${data.projects.length} projects`);
    }
  } catch {
    console.log("  SKIP cocomo-calibration-data.json (parse error)");
  }
}

// ---- 3. Aggregate statistics ------------------------------------------------

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function groupBy(arr, key) {
  const groups = {};
  for (const item of arr) {
    const k = item[key] ?? "unknown";
    (groups[k] ??= []).push(item);
  }
  return groups;
}

const byTaskType = {};
for (const [type, records] of Object.entries(groupBy(pairs, "task_type"))) {
  const ratios = records.map((r) => r.ratio);
  const ests = records.map((r) => r.estimated_hours);
  const acts = records.map((r) => r.actual_hours);

  byTaskType[type] = {
    sample_count: records.length,
    median_estimated_hours: Math.round(median(ests) * 100) / 100,
    median_actual_hours: Math.round(median(acts) * 100) / 100,
    median_ratio: Math.round(median(ratios) * 10000) / 10000,
    mean_ratio: Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 10000) / 10000,
    p25_ratio: Math.round(percentile(ratios, 25) * 10000) / 10000,
    p75_ratio: Math.round(percentile(ratios, 75) * 10000) / 10000,
  };
}

const byTool = {};
for (const [tool, records] of Object.entries(groupBy(pairs, "tool"))) {
  const ratios = records.map((r) => r.ratio);
  byTool[tool] = {
    sample_count: records.length,
    median_ratio: Math.round(median(ratios) * 10000) / 10000,
  };
}

// ---- 4. Write output --------------------------------------------------------

const benchmark = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: "community + cocomo calibration",
  total_records: pairs.length,
  unique_contributors: contributors.size || pairs.length,
  by_task_type: byTaskType,
  by_tool: byTool,
};

writeFileSync(OUTPUT_FILE, JSON.stringify(benchmark, null, 2), "utf-8");

console.log(`\nBenchmark exported: ${pairs.length} records, ${contributors.size} contributors`);
console.log(`  -> ${OUTPUT_FILE}`);

// Summary
for (const [type, data] of Object.entries(byTaskType).sort((a, b) => b[1].sample_count - a[1].sample_count)) {
  console.log(`  ${type}: ${data.sample_count} records, median ratio ${data.median_ratio}`);
}
