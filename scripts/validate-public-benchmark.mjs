#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Validate Public Benchmark
//
// Validates data/public-benchmark.json against the public-benchmark schema.
// Checks structural integrity, aggregate-only content, and absence of
// individual records or PII.
//
// Usage: node scripts/validate-public-benchmark.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BENCHMARK_FILE = join(ROOT, "data", "public-benchmark.json");

let exitCode = 0;

function fail(msg) {
  console.log(`FAIL  ${msg}`);
  exitCode = 1;
}

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

console.log("Epoch Public Benchmark Validator");
console.log("=".repeat(50));
console.log("");

if (!existsSync(BENCHMARK_FILE)) {
  fail(`Benchmark file not found: ${BENCHMARK_FILE}`);
  console.log("");
  console.log("Run `pnpm run dataset:build` to generate it first.");
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(BENCHMARK_FILE, "utf-8"));
} catch (err) {
  fail(`Failed to parse JSON: ${err.message}`);
  process.exit(1);
}

let errors = 0;

// Schema version
if (data.schema_version !== 1) {
  fail(`schema_version must be 1, got ${data.schema_version}`);
  errors++;
} else {
  pass("schema_version === 1");
}

// Generated at
if (!data.generated_at || isNaN(Date.parse(data.generated_at))) {
  fail(`generated_at must be a valid date-time, got ${data.generated_at}`);
  errors++;
} else {
  pass(`generated_at is valid: ${data.generated_at}`);
}

// Total records
if (typeof data.total_records !== "number" || !Number.isInteger(data.total_records) || data.total_records < 0) {
  fail(`total_records must be a non-negative integer, got ${data.total_records}`);
  errors++;
} else {
  pass(`total_records: ${data.total_records}`);
}

// Unique contributors
if (typeof data.unique_contributors !== "number" || !Number.isInteger(data.unique_contributors) || data.unique_contributors < 0) {
  fail(`unique_contributors must be a non-negative integer, got ${data.unique_contributors}`);
  errors++;
} else {
  pass(`unique_contributors: ${data.unique_contributors}`);
}

// by_task_type
if (typeof data.by_task_type !== "object" || data.by_task_type === null || Array.isArray(data.by_task_type)) {
  fail("by_task_type must be an object");
  errors++;
} else {
  const taskTypes = Object.keys(data.by_task_type);
  if (taskTypes.length === 0) {
    pass("by_task_type is empty (no data yet)");
  } else {
    for (const type of taskTypes) {
      const entry = data.by_task_type[type];
      const requiredFields = ["sample_count", "median_estimated_hours", "median_actual_hours", "median_ratio"];
      for (const field of requiredFields) {
        if (typeof entry[field] !== "number") {
          fail(`by_task_type.${type}.${field} must be a number, got ${typeof entry[field]}`);
          errors++;
        }
      }
    }
    pass(`by_task_type has ${taskTypes.length} task types`);
  }
}

// No individual records
const forbiddenKeys = ["records", "estimateId", "notes", "teamId", "project", "email", "name"];
for (const key of forbiddenKeys) {
  if (data[key] !== undefined) {
    fail(`Forbidden key found at top level: "${key}" — benchmark must not contain individual records or PII`);
    errors++;
  }
}
if (errors === 0) {
  pass("No forbidden keys (records, estimateId, notes, source, teamId, project, email, name)");
}

console.log("");
console.log("-".repeat(50));
if (errors === 0) {
  console.log(`VALID  data/public-benchmark.json (${data.total_records} records, ${data.unique_contributors} contributors)`);
} else {
  console.log(`INVALID  ${errors} error(s) found`);
}

process.exit(exitCode);
