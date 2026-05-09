#!/usr/bin/env node

const args = new Set(process.argv.slice(2));
const endpointArgIndex = process.argv.indexOf("--endpoint");
const endpointArg = endpointArgIndex >= 0 ? process.argv[endpointArgIndex + 1] : undefined;
const dryRun = args.has("--dry-run");
const chunkSize = 100;

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/backfill-telemetry.mjs --endpoint <url> [--dry-run]

Backfills all locally available anonymized telemetry records in chunks of ${chunkSize}.
Run "pnpm run build" first; this script imports the built public API from dist/index.js.

Options:
  --endpoint <url>  Telemetry receiver endpoint.
  --dry-run         Validate and count records without making network calls or updating config.
`);
  process.exit(0);
}

let epoch;
try {
  epoch = await import(new URL("../dist/index.js", import.meta.url).href);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not import dist/index.js (${message}). Run "pnpm run build" first.`);
  process.exit(1);
}

const {
  buildPayload,
  extractAnonymizedRecords,
  isUsableTelemetryEndpoint,
  loadConfig,
  saveConfig,
  signPayload,
} = epoch;

const endpoint = endpointArg ?? loadConfig().telemetry.endpoint;

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

  if (dryRun) {
    submitted += chunk.length;
    continue;
  }

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

  const body = await response.json().catch(() => ({}));
  submitted += chunk.length;
  accepted += typeof body.accepted === "number" ? body.accepted : 0;
  deduplicated += typeof body.deduplicated === "number" ? body.deduplicated : 0;
}

if (!dryRun) {
  const config = loadConfig();
  config.telemetry.enabled = true;
  config.telemetry.endpoint = endpoint;
  config.telemetry.lastSubmissionAt = new Date().toISOString();
  config.telemetry.lastSubmissionRecordCount = Math.max(config.telemetry.lastSubmissionRecordCount, submitted);
  config.telemetry.lastSubmissionAcceptedCount = accepted;
  config.telemetry.lastSubmissionDeduplicatedCount = deduplicated;
  config.telemetry.totalRecordsAccepted += accepted;
  config.telemetry.totalRecordsDeduplicated += deduplicated;
  saveConfig(config);
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  endpoint,
  extracted: extractedRecords.length,
  submitted,
  accepted,
  deduplicated,
  skippedInvalid,
}, null, 2));
