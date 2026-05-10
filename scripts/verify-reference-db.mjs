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
if (db.source === "telemetry-prospective-aggregate") {
  const summary = db.provenanceSummary;
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
    errors.push("telemetry-prospective-aggregate DB must include provenanceSummary");
  } else {
    for (const key of ["telemetryEvents", "correctionRecords", "baselineRecords", "excludedRecords", "legacyReceiverBaselineRecords"]) {
      if (typeof summary[key] !== "number" || !Number.isFinite(summary[key]) || summary[key] < 0) {
        errors.push(`provenanceSummary.${key} must be a non-negative finite number`);
      }
    }
    if (
      typeof summary.telemetryEvents === "number"
      && typeof summary.correctionRecords === "number"
      && db.sampleSize !== summary.telemetryEvents + summary.correctionRecords
    ) {
      errors.push("sampleSize must equal telemetryEvents + correctionRecords for telemetry-prospective-aggregate DBs");
    }
  }
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
  provenanceSummary: db.provenanceSummary ?? null,
}, null, 2));
