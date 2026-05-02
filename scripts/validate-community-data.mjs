#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Community Data Validator
//
// Validates JSON files in data/community/ against their declared schema.
// Each file must have a top-level "_schema" field and a "records" array.
//
// Usage: node scripts/validate-community-data.mjs
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const COMMUNITY_DIR = join(ROOT, "data", "community");
const SCHEMAS_DIR = join(ROOT, "data", "schemas");

const VALID_SCHEMAS = [
  "estimation-record",
  "model-calibration",
  "cocomo-project",
  "sprint-velocity",
];

// ---- Minimal JSON Schema draft-07 validator --------------------------------

function validateType(value, schema) {
  if (schema.type === undefined) return [];
  const actual = Array.isArray(value) ? "array" : typeof value;
  if (actual === "object" && value === null) return [];

  if (actual === schema.type) return [];
  // JSON has no integer type; JS parses all JSON numbers as "number"
  if (schema.type === "integer" && actual === "number") return [];
  if (schema.type === "number" && actual === "number") return [];

  return [`expected type ${schema.type}, got ${actual}`];
}

function validateEnum(value, schema) {
  if (schema.enum === undefined) return [];
  if (schema.enum.includes(value)) return [];
  return [`value must be one of: ${schema.enum.join(", ")}`];
}

function validateNumber(value, schema) {
  const errors = [];
  if (typeof value !== "number") return errors;
  if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push("must be an integer");
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`must be >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`must be <= ${schema.maximum}`);
  }
  return errors;
}

function validateString(value, schema) {
  if (typeof value !== "string") return [];
  if (schema.format === "date-time") {
    if (isNaN(Date.parse(value))) {
      return ["must be a valid date-time (ISO 8601)"];
    }
  }
  if (schema.format === "date") {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(value) || isNaN(Date.parse(value))) {
      return ["must be a valid date (YYYY-MM-DD)"];
    }
  }
  return [];
}

function validateRecord(record, schema) {
  const errors = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (record[field] === undefined || record[field] === null) {
        errors.push(`missing required field: ${field}`);
      }
    }
  }

  // Check each present property against its schema
  const properties = schema.properties || {};
  for (const [key, value] of Object.entries(record)) {
    const propSchema = properties[key];
    if (!propSchema) {
      errors.push(`unknown field: ${key}`);
      continue;
    }

    const typeErrors = validateType(value, propSchema);
    if (typeErrors.length > 0) {
      errors.push(`${key}: ${typeErrors[0]}`);
      continue;
    }

    const enumErrors = validateEnum(value, propSchema);
    for (const e of enumErrors) errors.push(`${key}: ${e}`);

    const numErrors = validateNumber(value, propSchema);
    for (const e of numErrors) errors.push(`${key}: ${e}`);

    const strErrors = validateString(value, propSchema);
    for (const e of strErrors) errors.push(`${key}: ${e}`);
  }

  // Check additionalProperties
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        if (!errors.some((e) => e.includes(`unknown field: ${key}`))) {
          errors.push(`unknown field: ${key}`);
        }
      }
    }
  }

  return errors;
}

// ---- Main ------------------------------------------------------------------

let hasErrors = false;
let totalFiles = 0;
let totalRecords = 0;
let totalPassed = 0;
let totalFailed = 0;

const files = readdirSync(COMMUNITY_DIR).filter((f) => f.endsWith(".json"));

if (files.length === 0) {
  console.log("No JSON files found in data/community/");
  console.log("");
  console.log("To contribute data, create a JSON file with this structure:");
  console.log('{');
  console.log('  "_schema": "estimation-record",');
  console.log('  "description": "Description of your dataset",');
  console.log('  "records": [ ... ]');
  console.log('}');
  process.exit(0);
}

console.log("Epoch Community Data Validator");
console.log("=".repeat(50));
console.log("");

for (const file of files) {
  totalFiles++;
  const filePath = join(COMMUNITY_DIR, file);

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.log(`FAIL  ${file}`);
    console.log(`      Error: failed to parse JSON: ${err.message}`);
    console.log("");
    hasErrors = true;
    totalFailed++;
    continue;
  }

  // Validate top-level structure
  if (!data._schema) {
    console.log(`FAIL  ${file}`);
    console.log(`      Error: missing top-level "_schema" field`);
    console.log("");
    hasErrors = true;
    totalFailed++;
    continue;
  }

  if (!VALID_SCHEMAS.includes(data._schema)) {
    console.log(`FAIL  ${file}`);
    console.log(
      `      Error: unknown schema "${data._schema}", must be one of: ${VALID_SCHEMAS.join(", ")}`
    );
    console.log("");
    hasErrors = true;
    totalFailed++;
    continue;
  }

  if (!Array.isArray(data.records)) {
    console.log(`FAIL  ${file}`);
    console.log(`      Error: top-level "records" field must be an array`);
    console.log("");
    hasErrors = true;
    totalFailed++;
    continue;
  }

  // Load schema
  const schemaPath = join(SCHEMAS_DIR, `${data._schema}.schema.json`);
  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  } catch (err) {
    console.log(`FAIL  ${file}`);
    console.log(`      Error: could not load schema file ${schemaPath}: ${err.message}`);
    console.log("");
    hasErrors = true;
    totalFailed++;
    continue;
  }

  const recordCount = data.records.length;
  totalRecords += recordCount;
  let fileErrors = 0;

  const errorLines = [];

  for (let i = 0; i < recordCount; i++) {
    const errors = validateRecord(data.records[i], schema);
    if (errors.length > 0) {
      fileErrors++;
      errorLines.push(`      Record ${i}:`);
      for (const e of errors) {
        errorLines.push(`        - ${e}`);
      }
    }
  }

  if (fileErrors === 0) {
    console.log(`PASS  ${file} (${recordCount} records, schema: ${data._schema})`);
    totalPassed++;
  } else {
    console.log(
      `FAIL  ${file} (${recordCount} records, ${fileErrors} failed, schema: ${data._schema})`
    );
    for (const line of errorLines) {
      console.log(line);
    }
    hasErrors = true;
    totalFailed += fileErrors;
  }

  console.log("");
}

console.log("-".repeat(50));
console.log(
  `Files: ${totalFiles} | Records: ${totalRecords} | Passed: ${totalRecords - totalFailed} | Failed: ${totalFailed}`
);

if (hasErrors) {
  console.log("");
  console.log("Validation FAILED. Fix the errors above before submitting.");
  process.exit(1);
} else {
  console.log("");
  console.log("All community data files are valid.");
  process.exit(0);
}
