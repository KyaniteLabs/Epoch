#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Verify Reference Database
//
// Validates src/data/reference-database.json for structural integrity.
// Ensures the bundled reference database is loadable and has sensible values.
//
// Usage: node scripts/verify-reference-db.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DB_FILE = join(ROOT, "src", "data", "reference-database.json");

let exitCode = 0;

function fail(msg) {
  console.log(`FAIL  ${msg}`);
  exitCode = 1;
}

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

console.log("Epoch Reference Database Verifier");
console.log("=".repeat(50));
console.log("");

if (!existsSync(DB_FILE)) {
  fail(`Reference database not found: ${DB_FILE}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(DB_FILE, "utf-8"));
} catch (err) {
  fail(`Failed to parse JSON: ${err.message}`);
  process.exit(1);
}

// Required fields
const requiredFields = [
  "sampleSize",
  "globalCorrectionFactor",
  "taskTypeCorrectionFactors",
  "toolTaskCorrectionFactors",
  "complexityCorrectionFactors",
  "generatedAt",
  "source",
];

for (const field of requiredFields) {
  if (data[field] === undefined) {
    fail(`Missing required field: ${field}`);
  } else {
    pass(`Has ${field}`);
  }
}

// Validate sample size
if (typeof data.sampleSize === "number") {
  if (data.sampleSize < 0) {
    fail(`sampleSize must be non-negative, got ${data.sampleSize}`);
  } else {
    pass(`sampleSize: ${data.sampleSize.toLocaleString()}`);
  }
}

// Validate global correction factor
if (typeof data.globalCorrectionFactor === "number") {
  if (data.globalCorrectionFactor <= 0 || data.globalCorrectionFactor > 5) {
    fail(`globalCorrectionFactor should be between 0 and 5, got ${data.globalCorrectionFactor}`);
  } else {
    pass(`globalCorrectionFactor: ${data.globalCorrectionFactor.toFixed(3)}`);
  }
}

// Validate task type correction factors
if (typeof data.taskTypeCorrectionFactors === "object") {
  const taskTypes = Object.keys(data.taskTypeCorrectionFactors);
  pass(`taskTypeCorrectionFactors has ${taskTypes.length} task types`);
  for (const [type, factor] of Object.entries(data.taskTypeCorrectionFactors)) {
    if (typeof factor !== "number" || factor <= 0) {
      fail(`Invalid correction factor for ${type}: ${factor}`);
    }
  }
}

// Validate generatedAt
if (typeof data.generatedAt === "string") {
  if (isNaN(Date.parse(data.generatedAt))) {
    fail(`generatedAt is not a valid date: ${data.generatedAt}`);
  } else {
    pass(`generatedAt: ${data.generatedAt}`);
  }
}

// Validate source
if (typeof data.source === "string" && data.source.length > 0) {
  pass(`source: ${data.source}`);
} else {
  fail("source must be a non-empty string");
}

console.log("");
console.log("-".repeat(50));
if (exitCode === 0) {
  console.log(`VALID  src/data/reference-database.json (${data.sampleSize.toLocaleString()} samples, factor ${data.globalCorrectionFactor.toFixed(3)})`);
} else {
  console.log(`INVALID  verification failed`);
}

process.exit(exitCode);
