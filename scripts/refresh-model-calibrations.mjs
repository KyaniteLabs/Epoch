#!/usr/bin/env node
// ---------------------------------------------------------------------------
// refresh-model-calibrations.mjs — S4.1 model-table freshness refresh command
//
// Refreshes data/model-calibrations.json (the stamped MODEL_CALIBRATIONS
// table) from approved ZERO-COST sources:
//
//   1. Public benchmark/spec pages of the supplementary-DB pricing source
//      class (Artificial Analysis, BenchLM.ai, LLMversus, SaltTechno,
//      provider pages — see data/supplementary-database.json sources.
//      llmBenchmarks). Save a snapshot as JSON and pass it via --input; the
//      script itself performs NO network access (deterministic, CI-safe,
//      zero-spend by construction). Fetch procedure + source citations:
//      docs/MODEL-CALIBRATION-REFRESH.md.
//   2. Community records conforming to data/schemas/model-calibration.
//      schema.json, read from data/community/ (files that are not
//      model-calibration records are skipped and noted, not fatal).
//
// Every refreshed entry is written with `measured_at` + `provenance` stamps.
// FAILOPEN IS FORBIDDEN: the script validates the COMPLETE output table
// before writing anything — a single entry missing provenance or freshness
// stamps (or any numeric/date sanity violation) exits non-zero and leaves
// the table file byte-identical. Writes are atomic (temp file + rename).
//
// Field honesty: the community schema measures tokens_per_second (plus
// TTFT/latency fields with different semantics than the table's
// reasoningOverheadMs/toolCallLatencyMs). A community-schema record refreshes
// ONLY tokensPerSecond; the latency fields are carried over from the prior
// entry and the receipt records them as unrefreshed. A NEW model from a
// community-schema record is rejected (it cannot honestly populate the
// latency fields); new models require a stamped-table-format record via
// --input.
//
// Usage:
//   node scripts/refresh-model-calibrations.mjs [--table <path>]
//        [--community <dir>] [--input <snapshot.json>] [--input <more.json>]
//        [--dry-run] [--receipt <path>]
//
// Exit codes: 0 = ok (or dry-run ok) · 1 = fail-closed validation error ·
//             2 = usage error.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const VALID_KINDS = new Set(["curated", "placeholder", "public_source", "community"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- CLI ---------------------------------------------------------------------

function usage(code = 2) {
  console.error(`Usage: node scripts/refresh-model-calibrations.mjs \\
         [--table <model-calibrations.json>] [--community <dir>] \\
         [--input <snapshot.json>]... [--dry-run] [--receipt <path>]`);
  process.exit(code);
}

const args = process.argv.slice(2);
const opts = { table: null, community: null, inputs: [], dryRun: false, receipt: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case "--table": opts.table = args[++i]; break;
    case "--community": opts.community = args[++i]; break;
    case "--input": opts.inputs.push(args[++i]); break;
    case "--dry-run": opts.dryRun = true; break;
    case "--receipt": opts.receipt = args[++i]; break;
    case "--help": case "-h": usage(0); break;
    default: console.error(`Unknown argument: ${a}`); usage(2);
  }
  if (i < args.length && args[i] === undefined) usage(2);
}

const tablePath = resolve(opts.table ?? join(REPO_ROOT, "data", "model-calibrations.json"));
const communityDir = resolve(opts.community ?? join(REPO_ROOT, "data", "community"));

// ---- Fail-closed helpers -------------------------------------------------------

const errors = [];
function fail(msg) { errors.push(msg); }

function isoDateToEpochMs(iso) {
  if (!ISO_DATE_RE.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Validate one output-table entry; pushes fail-closed errors. */
function validateEntry(model, entry, nowMs) {
  if (entry === null || typeof entry !== "object") { fail(`${model}: entry is not an object`); return; }
  if (typeof entry.tokensPerSecond !== "number" || !(entry.tokensPerSecond > 0)) {
    fail(`${model}: tokensPerSecond must be a number > 0 (got ${JSON.stringify(entry.tokensPerSecond)})`);
  }
  if (typeof entry.reasoningOverheadMs !== "number" || entry.reasoningOverheadMs < 0) {
    fail(`${model}: reasoningOverheadMs must be a number >= 0`);
  }
  if (typeof entry.toolCallLatencyMs !== "number" || entry.toolCallLatencyMs < 0) {
    fail(`${model}: toolCallLatencyMs must be a number >= 0`);
  }
  // FRESHNESS stamp: required, ISO date, not in the future (+1d tolerance).
  if (typeof entry.measured_at !== "string" || !ISO_DATE_RE.test(entry.measured_at)) {
    fail(`${model}: missing/invalid freshness stamp measured_at (expected YYYY-MM-DD, got ${JSON.stringify(entry.measured_at)})`);
  } else {
    const then = isoDateToEpochMs(entry.measured_at);
    if (then === null) fail(`${model}: measured_at not parseable (${entry.measured_at})`);
    else if (then > nowMs + 86_400_000) fail(`${model}: measured_at is in the future (${entry.measured_at})`);
  }
  // PROVENANCE stamp: required, valid kind, non-empty source.
  const p = entry.provenance;
  if (p === null || typeof p !== "object") {
    fail(`${model}: missing provenance stamp`);
  } else {
    if (!VALID_KINDS.has(p.kind)) fail(`${model}: provenance.kind must be one of ${[...VALID_KINDS].join("|")} (got ${JSON.stringify(p.kind)})`);
    if (typeof p.source !== "string" || p.source.trim().length === 0) fail(`${model}: provenance.source must be a non-empty string`);
    if (p.note !== undefined && typeof p.note !== "string") fail(`${model}: provenance.note must be a string`);
  }
}

// ---- Load current table ---------------------------------------------------------

if (!existsSync(tablePath)) {
  console.error(`refresh-model-calibrations: table not found: ${tablePath}`);
  process.exit(1);
}
let originalRaw;
let table;
try {
  originalRaw = readFileSync(tablePath, "utf-8");
  table = JSON.parse(originalRaw);
} catch (err) {
  console.error(`refresh-model-calibrations: cannot parse table ${tablePath}: ${err.message}`);
  process.exit(1);
}
if (table === null || typeof table !== "object" || typeof table.models !== "object" || table.models === null) {
  console.error(`refresh-model-calibrations: table ${tablePath} has no models object — refusing`);
  process.exit(1);
}

// ---- Collect refresh records -----------------------------------------------------

const nowMs = Date.now();
const receiptSources = [];

/**
 * Accepts either:
 *  - a community-schema record ({model, tokens_per_second, measured_at, ...}),
 *    which refreshes tokensPerSecond only; or
 *  - a stamped-table record ({model, tokensPerSecond, reasoningOverheadMs,
 *    toolCallLatencyMs, measured_at, provenance}) for full control.
 * Returns null with a fail-closed error when the record is invalid.
 */
function toRefreshRecord(rec, origin, kind) {
  if (rec === null || typeof rec !== "object" || typeof rec.model !== "string" || rec.model.length === 0) {
    fail(`${origin}: record has no model field`);
    return null;
  }
  if (typeof rec.tokensPerSecond === "number" && typeof rec.reasoningOverheadMs === "number" && typeof rec.toolCallLatencyMs === "number") {
    // stamped-table format
    return {
      model: rec.model,
      tableFormat: true,
      tokensPerSecond: rec.tokensPerSecond,
      reasoningOverheadMs: rec.reasoningOverheadMs,
      toolCallLatencyMs: rec.toolCallLatencyMs,
      measured_at: rec.measured_at,
      provenance: rec.provenance ?? { kind, source: origin },
    };
  }
  if (typeof rec.tokens_per_second === "number" && typeof rec.measured_at === "string") {
    const missing = COMMUNITY_REQUIRED.filter((f) => rec[f] === undefined);
    if (missing.length > 0) {
      fail(`${origin}: ${rec.model}: community record missing required field(s): ${missing.join(", ")}`);
      return null;
    }
    return {
      model: rec.model,
      tableFormat: false,
      tokensPerSecond: rec.tokens_per_second,
      measured_at: rec.measured_at,
      provenance: { kind, source: rec.benchmark_source ? `${rec.benchmark_source} (via ${origin})` : origin },
    };
  }
  fail(`${origin}: ${rec.model ?? "(no model)"}: record matches neither the community schema (tokens_per_second + measured_at + required fields) nor the stamped-table format`);
  return null;
}

const COMMUNITY_REQUIRED = ["model", "tokens_per_second", "time_to_first_token_ms", "avg_api_latency_ms", "cost_input_per_million", "cost_output_per_million", "measured_at"];

const refreshRecords = new Map(); // model -> {record, origin}
function addRecord(rec, origin, kind) {
  const parsed = toRefreshRecord(rec, origin, kind);
  if (parsed === null) return;
  const prev = refreshRecords.get(parsed.model);
  if (prev) {
    // last record wins, noted in the receipt
    receiptSources.push({ file: origin, model: parsed.model, note: "duplicate record — last one wins" });
  }
  refreshRecords.set(parsed.model, { record: parsed, origin });
}

// --input snapshots (public-source class)
for (const inputPath of opts.inputs) {
  const abs = resolve(inputPath);
  if (!existsSync(abs)) { console.error(`refresh-model-calibrations: --input not found: ${abs}`); process.exit(1); }
  let parsed;
  try { parsed = JSON.parse(readFileSync(abs, "utf-8")); } catch (err) {
    console.error(`refresh-model-calibrations: cannot parse --input ${abs}: ${err.message}`); process.exit(1);
  }
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [parsed];
  let count = 0;
  for (const rec of records) { addRecord(rec, abs, "public_source"); count++; }
  receiptSources.push({ file: abs, records: count });
}

// data/community records (community schema)
if (existsSync(communityDir)) {
  for (const name of readdirSync(communityDir).filter((n) => n.endsWith(".json")).sort()) {
    const abs = join(communityDir, name);
    let parsed;
    try { parsed = JSON.parse(readFileSync(abs, "utf-8")); } catch {
      receiptSources.push({ file: abs, skipped: "unparseable JSON" });
      continue;
    }
    // Community dir holds estimation records too; only files that look like
    // model calibrations (model + tokens_per_second) are ingested.
    const candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? [] : [parsed];
    if (candidates.length === 1 && !(typeof candidates[0]?.tokens_per_second === "number" && typeof candidates[0]?.model === "string")) {
      receiptSources.push({ file: abs, skipped: "not a model-calibration record (no model + tokens_per_second)" });
      continue;
    }
    let count = 0;
    for (const rec of candidates) { addRecord(rec, abs, "community"); count++; }
    receiptSources.push({ file: abs, records: count });
  }
}

// ---- Merge (in memory — nothing is written until the whole table validates) ------

const nextModels = {};
const diffLines = [];
const perEntryReceipt = {};

for (const [model, prev] of Object.entries(table.models)) {
  const hit = refreshRecords.get(model);
  if (!hit) {
    nextModels[model] = prev;
    continue;
  }
  const { record, origin } = hit;
  if (record.tableFormat) {
    nextModels[model] = {
      tokensPerSecond: record.tokensPerSecond,
      reasoningOverheadMs: record.reasoningOverheadMs,
      toolCallLatencyMs: record.toolCallLatencyMs,
      measured_at: record.measured_at,
      provenance: record.provenance,
    };
    diffLines.push(`${model}: full refresh from ${origin} (tps ${prev.tokensPerSecond} -> ${record.tokensPerSecond}, measured_at ${prev.measured_at} -> ${record.measured_at})`);
    perEntryReceipt[model] = { source: origin, measured_at: record.measured_at, fields_refreshed: ["tokensPerSecond", "reasoningOverheadMs", "toolCallLatencyMs"], fields_carried_over: [] };
  } else {
    // Community-schema record: refresh tokensPerSecond only; latency fields
    // carry over (their semantics are not measured by this source).
    nextModels[model] = {
      tokensPerSecond: record.tokensPerSecond,
      reasoningOverheadMs: prev.reasoningOverheadMs,
      toolCallLatencyMs: prev.toolCallLatencyMs,
      measured_at: record.measured_at,
      provenance: {
        kind: record.provenance.kind,
        source: record.provenance.source,
        note: `tokensPerSecond refreshed from ${record.provenance.source} (measured ${record.measured_at}); reasoningOverheadMs/toolCallLatencyMs carried over from previous entry — not measured by this source.`,
      },
    };
    diffLines.push(`${model}: tokensPerSecond ${prev.tokensPerSecond} -> ${record.tokensPerSecond} from ${origin} (measured_at ${prev.measured_at} -> ${record.measured_at}); latency fields carried over`);
    perEntryReceipt[model] = { source: origin, provenance_source: record.provenance.source, measured_at: record.measured_at, fields_refreshed: ["tokensPerSecond"], fields_carried_over: ["reasoningOverheadMs", "toolCallLatencyMs"] };
  }
}

for (const [model, { record, origin }] of refreshRecords) {
  if (nextModels[model] !== undefined) continue;
  if (!record.tableFormat) {
    fail(`${origin}: ${model}: cannot ADD a new model from a community-schema record — it does not measure reasoningOverheadMs/toolCallLatencyMs; supply a stamped-table-format record via --input instead`);
    continue;
  }
  nextModels[model] = {
    tokensPerSecond: record.tokensPerSecond,
    reasoningOverheadMs: record.reasoningOverheadMs,
    toolCallLatencyMs: record.toolCallLatencyMs,
    measured_at: record.measured_at,
    provenance: record.provenance,
  };
  diffLines.push(`${model}: NEW entry from ${origin} (tps ${record.tokensPerSecond}, measured_at ${record.measured_at})`);
  perEntryReceipt[model] = { source: origin, measured_at: record.measured_at, fields_refreshed: ["tokensPerSecond", "reasoningOverheadMs", "toolCallLatencyMs"], fields_carried_over: [] };
}

// ---- Validate the COMPLETE output table (fail closed) ----------------------------

for (const [model, entry] of Object.entries(nextModels)) {
  validateEntry(model, entry, nowMs);
}

// No entry may be lost vs the original table.
for (const model of Object.keys(table.models)) {
  if (nextModels[model] === undefined) fail(`${model}: entry LOST in refresh — merges may only update or add, never drop`);
}

// Table-level freshness stamp: refreshed_at = max entry measured_at.
let maxMeasured = null;
for (const entry of Object.values(nextModels)) {
  const t = isoDateToEpochMs(entry.measured_at);
  if (t === null) continue;
  if (maxMeasured === null || t > maxMeasured) maxMeasured = t;
}
const nextRefreshedAt = maxMeasured !== null ? new Date(maxMeasured).toISOString().slice(0, 10) : table.refreshed_at;
if (!ISO_DATE_RE.test(nextRefreshedAt)) fail(`table refreshed_at invalid (${nextRefreshedAt})`);

// ---- Diff report ------------------------------------------------------------------

const changed = diffLines.length;
const untouched = Object.keys(nextModels).length - changed;
console.log(`=== model-calibration refresh ${opts.dryRun ? "(dry run — no write) " : ""}===`);
console.log(`table:   ${tablePath}`);
console.log(`records: ${refreshRecords.size} refresh record(s) from ${receiptSources.filter((s) => !s.skipped).length} source file(s)`);
console.log(`changes: ${changed} entr${changed === 1 ? "y" : "ies"} refreshed/added, ${Math.max(untouched, 0)} untouched`);
if (changed > 0) console.log(diffLines.map((l) => `  ${l}`).join("\n"));
else console.log("  (no entries matched a refresh record)");

// ---- Fail-closed gate: ANY error means exit 1 and NO write ------------------------

if (errors.length > 0) {
  console.error(`\nrefresh-model-calibrations: FAIL CLOSED — ${errors.length} validation error(s); the table was NOT modified:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// ---- Receipt ----------------------------------------------------------------------

const receipt = {
  ran_at: new Date().toISOString(),
  dry_run: opts.dryRun,
  table_path: tablePath,
  refreshed_at_written: nextRefreshedAt,
  sources: receiptSources,
  counts: { refreshed_or_added: changed, untouched: Math.max(untouched, 0) },
  per_entry: perEntryReceipt,
};
const receiptJson = JSON.stringify(receipt, null, 2);
if (opts.receipt) {
  writeFileSync(resolve(opts.receipt), receiptJson + "\n", "utf-8");
  console.log(`receipt: ${resolve(opts.receipt)}`);
} else {
  console.log("receipt:");
  console.log(receiptJson);
}

// ---- Atomic write (skipped in dry-run) ----------------------------------------------

if (!opts.dryRun) {
  const output = {
    version: table.version ?? 1,
    description: table.description,
    refreshed_at: nextRefreshedAt,
    staleness_threshold_days: table.staleness_threshold_days ?? 90,
    sources: table.sources,
    models: Object.fromEntries(Object.keys(nextModels).sort().map((k) => [k, nextModels[k]])),
  };
  const tmp = `${tablePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(output, null, 2) + "\n", "utf-8");
  renameSync(tmp, tablePath);
  console.log(`wrote:   ${tablePath} (refreshed_at ${nextRefreshedAt})`);
} else {
  console.log(`dry-run: would write ${tablePath} (refreshed_at ${nextRefreshedAt})`);
}

process.exit(0);
