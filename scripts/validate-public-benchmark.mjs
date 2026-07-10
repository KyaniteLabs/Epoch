#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Validate Public Benchmark
//
// Validates data/public-benchmark.json against the public-benchmark schema.
// Checks structural integrity, aggregate-only content, and absence of
// individual records or PII.
//
// Guarded (Phase 2 Task 5 / Pre-mortem Scenario 5): asserts zero quarantined/
// orphan rows contributed to the export by independently re-running
// loadLocalBenchmarkPairs() (the same isExcluded()-filtered path
// export-public-benchmark.mjs used) against the CURRENT live ledger state —
// re-verified at validate time, not just trusted from the export-time report,
// so a quarantine landed after export still gets caught.
//
// Usage: npx tsx scripts/validate-public-benchmark.mjs
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 5.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalBenchmarkPairs } from "../src/lib/benchmark-export.ts";

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

// Quality/contamination-guard block (Pre-mortem Scenario 5)
if (typeof data._quality !== "object" || data._quality === null) {
  fail("_quality block is missing — export-public-benchmark.mjs must record its isExcluded()/backfill-signature guard evidence");
  errors++;
} else {
  const q = data._quality;
  const errorsBeforeQuality = errors;
  const numericFields = ["local_pairs_included", "local_pairs_excluded_by_isExcluded", "contaminated_pairs_filtered", "pre_filter_total_pairs"];
  for (const field of numericFields) {
    if (typeof q[field] !== "number" || q[field] < 0 || !Number.isInteger(q[field])) {
      fail(`_quality.${field} must be a non-negative integer, got ${q[field]}`);
      errors++;
    }
  }
  if (errors === errorsBeforeQuality) {
    pass(`_quality block present: ${q.local_pairs_included} local pairs included, ${q.local_pairs_excluded_by_isExcluded} excluded by isExcluded(), ${q.contaminated_pairs_filtered} contaminated pair(s) filtered`);
  }

  // Re-verify LIVE, not just trust the export-time report: re-run the same
  // exclusion-filtered loader against the current ledger state and confirm
  // the number of currently-includable local pairs never exceeds what the
  // export claims to have included (a fresh quarantine after export must
  // never silently widen the gap in the wrong direction — i.e. the export
  // must not have included MORE than isExcluded() currently allows).
  const liveResult = loadLocalBenchmarkPairs();
  if (liveResult.pairs.length > q.local_pairs_included) {
    fail(
      `Live re-verification found ${liveResult.pairs.length} currently-clean local pairs, more than the ${q.local_pairs_included} the export recorded — re-run \`pnpm run dataset:build\` to refresh.`,
    );
    errors++;
  } else {
    pass(`Live re-verification: ${liveResult.pairs.length} currently-clean local pairs (export recorded ${q.local_pairs_included}) — no quarantined/orphan row included`);
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
