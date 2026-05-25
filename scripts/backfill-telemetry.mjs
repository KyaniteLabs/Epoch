#!/usr/bin/env node
import { buildPayload, extractAnonymizedRecords, signPayload } from "../src/lib/telemetry-submit.ts";
import { loadConfig, saveConfig, isUsableTelemetryEndpoint } from "../src/lib/config.ts";

const endpointArgIndex = process.argv.indexOf("--endpoint");
const endpoint = endpointArgIndex >= 0 ? process.argv[endpointArgIndex + 1] : loadConfig().telemetry.endpoint;
const chunkSize = 100;

if (!endpoint || !isUsableTelemetryEndpoint(endpoint)) {
  console.error("No usable endpoint configured. Pass --endpoint <url> or run telemetry set-endpoint first.");
  process.exit(1);
}

function isSafeRecord(record) {
  return (
    typeof record.task_type === "string" &&
    (typeof record.complexity === "number" || record.complexity === null) &&
    typeof record.tool === "string" &&
    Number.isFinite(record.estimated_hours) &&
    Number.isFinite(record.actual_hours) &&
    Number.isFinite(record.ratio) &&
    typeof record.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.date)
  );
}

const extractedRecords = extractAnonymizedRecords();
const records = extractedRecords.filter(isSafeRecord);
const skippedInvalid = extractedRecords.length - records.length;
let submitted = 0;
let accepted = 0;
let deduplicated = 0;

for (let index = 0; index < records.length; index += chunkSize) {
  const chunk = records.slice(index, index + chunkSize);
  const payload = buildPayload(chunk);
  const raw = JSON.stringify(payload);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Epoch-Signature": signPayload(payload, payload.installation_id),
      "X-Epoch-Version": payload.epoch_version,
    },
    body: raw,
  });

  if (!response.ok) {
    console.error(`Backfill failed: server returned ${response.status}`);
    process.exit(1);
  }

  const body = await response.json();
  submitted += chunk.length;
  accepted += typeof body.accepted === "number" ? body.accepted : 0;
  deduplicated += typeof body.deduplicated === "number" ? body.deduplicated : 0;
}

const config = loadConfig();
config.telemetry.enabled = true;
config.telemetry.endpoint = endpoint;
config.telemetry.lastSubmissionAt = new Date().toISOString();
config.telemetry.lastSubmissionRecordCount = Math.max(config.telemetry.lastSubmissionRecordCount, submitted);
config.telemetry.lastSubmissionAcceptedCount = accepted;
config.telemetry.lastSubmissionDeduplicatedCount = deduplicated;
config.telemetry.totalRecordsAccepted = (config.telemetry.totalRecordsAccepted ?? 0) + accepted;
config.telemetry.totalRecordsDeduplicated = (config.telemetry.totalRecordsDeduplicated ?? 0) + deduplicated;
saveConfig(config);

console.log(JSON.stringify({ ok: true, extracted: extractedRecords.length, submitted, accepted, deduplicated, skippedInvalid }, null, 2));
