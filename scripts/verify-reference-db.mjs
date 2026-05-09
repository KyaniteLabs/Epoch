#!/usr/bin/env node

import { readFileSync } from "node:fs";

const db = JSON.parse(readFileSync("src/data/reference-database.json", "utf8"));

const errors = [];
if (typeof db.generatedAt !== "string" || Number.isNaN(Date.parse(db.generatedAt))) {
  errors.push("generatedAt must be a valid ISO timestamp");
}
if (typeof db.sampleSize !== "number" || !Number.isFinite(db.sampleSize) || db.sampleSize < 0) {
  errors.push("sampleSize must be a non-negative finite number");
}
if (typeof db.source !== "string" || db.source.length === 0) {
  errors.push("source must be a non-empty string");
}
if (typeof db.globalCorrectionFactor !== "number" || !Number.isFinite(db.globalCorrectionFactor)) {
  errors.push("globalCorrectionFactor must be a finite number");
}
for (const key of ["taskTypeCorrectionFactors", "toolTaskCorrectionFactors", "complexityCorrectionFactors"]) {
  if (typeof db[key] !== "object" || db[key] === null || Array.isArray(db[key])) {
    errors.push(`${key} must be an object`);
  }
}
if (
  db.complexityCorrectionFactors
  && Object.keys(db.complexityCorrectionFactors).length === 0
  && (typeof db.complexityCorrectionFactorStatus !== "string" || db.complexityCorrectionFactorStatus.length === 0)
) {
  errors.push("complexityCorrectionFactorStatus must explain why bundled complexity factors are empty");
}

if (errors.length > 0) {
  throw new Error(`reference database failed verification: ${errors.join("; ")}`);
}

console.log(JSON.stringify({
  ok: true,
  generatedAt: db.generatedAt,
  sampleSize: db.sampleSize,
  source: db.source,
  globalCorrectionFactor: db.globalCorrectionFactor,
  complexityCorrectionFactorStatus: db.complexityCorrectionFactorStatus ?? null,
}, null, 2));
