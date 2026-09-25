// ---------------------------------------------------------------------------
// Tests for S4.1 model-table freshness: stamped data + staleness surfacing.
//
// Covers: (a) stamping invariants on the shipped data/model-calibrations.json
// (every entry carries measured_at + provenance; the 4 placeholder entries
// are honestly marked with their sibling source); (b) the staleness helpers
// at the 90d boundary; (c) token_time_bridge / data-status staleness
// surfacing via a stale user-dir table override.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseModelCalibrationTable,
  loadModelCalibrationTable,
  resetModelCalibrationTableCache,
  daysSinceIsoDate,
  modelTableAgeDays,
  modelEntryAgeDays,
  isStaleAge,
  getBundledModelCalibrations,
  getPlaceholderModelIds,
  MODEL_CALIBRATION_STALENESS_THRESHOLD_DAYS,
} from "./model-calibration-table.js";
import { tokenTimeBridge } from "./analytics.js";
import { resetTelemetry } from "./telemetry.js";
import { resetSupplementaryCache } from "./supplementary-data.js";
import { getEpochDataStatus } from "./data-status.js";
import { defined } from "../test-support.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SHIPPED_TABLE = readFileSync(join(SRC_DIR, "..", "..", "data", "model-calibrations.json"), "utf-8");

const PLACEHOLDER_MODELS = ["claude-fable-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5"];

// ---- Stamping invariants on the shipped table --------------------------------

describe("shipped model-calibrations table stamps (S4.1)", () => {
  const table = defined(parseModelCalibrationTable(SHIPPED_TABLE));

  it("parses and has 16 entries", () => {
    expect(table).not.toBeNull();
    expect(Object.keys(table?.models ?? {})).toHaveLength(16);
  });

  it("every entry carries measured_at + provenance (kind + non-empty source)", () => {
    expect(table).not.toBeNull();
    for (const [model, entry] of Object.entries(table.models)) {
      expect(entry.measured_at, `${model}.measured_at`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["curated", "placeholder", "public_source", "community"], `${model}.provenance.kind`).toContain(entry.provenance.kind);
      expect(entry.provenance.source.length, `${model}.provenance.source`).toBeGreaterThan(0);
      expect(entry.tokensPerSecond, `${model}.tokensPerSecond`).toBeGreaterThan(0);
      expect(entry.reasoningOverheadMs, `${model}.reasoningOverheadMs`).toBeGreaterThanOrEqual(0);
      expect(entry.toolCallLatencyMs, `${model}.toolCallLatencyMs`).toBeGreaterThanOrEqual(0);
    }
  });

  it("no measured_at is in the future", () => {
    const tomorrow = Date.now() + 86_400_000;
    for (const entry of Object.values(table.models)) {
      const t = Date.parse(`${entry.measured_at}T00:00:00Z`);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeLessThanOrEqual(tomorrow);
    }
  });

  it("the 4 placeholder entries are honestly marked and name their sibling source", () => {
    const placeholders = getPlaceholderModelIds();
    expect(placeholders).toEqual(PLACEHOLDER_MODELS);
    for (const model of PLACEHOLDER_MODELS) {
      const entry = defined(table.models[model]);
      expect(entry.provenance.kind).toBe("placeholder");
      // the sibling-source note must name another table entry (not itself)
      expect(entry.provenance.source).not.toContain("NOT primary-source");
      expect(table.models[entry.provenance.source.split(" ")[0] ?? ""]).toBeDefined();
      expect(entry.provenance.note ?? "").toContain("NOT primary-source verified");
    }
  });

  it("non-placeholder entries are never marked placeholder and vice versa", () => {
    for (const [model, entry] of Object.entries(table.models)) {
      const isPlaceholderListed = PLACEHOLDER_MODELS.includes(model);
      expect(entry.provenance.kind === "placeholder").toBe(isPlaceholderListed);
    }
  });

  it("table refreshed_at equals the max entry measured_at (value-freshness, not re-stamp date)", () => {
    const max = Object.values(table.models)
      .map((e) => Date.parse(`${e.measured_at}T00:00:00Z`))
      .reduce((a, b) => Math.max(a, b));
    expect(table.refreshed_at).toBe(new Date(max).toISOString().slice(0, 10));
  });
});

// ---- Staleness helpers at the 90d boundary ------------------------------------

describe("staleness helpers (90d threshold)", () => {
  it("isStaleAge is exclusive at the boundary: 90d OK, 91d stale, null not stale", () => {
    expect(isStaleAge(90)).toBe(false);
    expect(isStaleAge(91)).toBe(true);
    expect(isStaleAge(null)).toBe(false);
    expect(MODEL_CALIBRATION_STALENESS_THRESHOLD_DAYS).toBe(90);
  });

  it("daysSinceIsoDate computes whole UTC days", () => {
    const now = new Date(Date.UTC(2026, 8, 24)); // 2026-09-24
    expect(daysSinceIsoDate("2026-09-24", now)).toBe(0);
    expect(daysSinceIsoDate("2026-06-26", now)).toBe(90);
    expect(daysSinceIsoDate("2026-06-25", now)).toBe(91);
    expect(daysSinceIsoDate("not-a-date", now)).toBeNull();
  });

  it("modelEntryAgeDays / modelTableAgeDays read the stamps", () => {
    const table = defined(parseModelCalibrationTable(SHIPPED_TABLE));
    const entry = defined(table.models["gpt-4o"]);
    const now = new Date(Date.UTC(2026, 8, 24));
    expect(modelEntryAgeDays(entry, now)).toBe(77); // 2026-07-09 -> 2026-09-24
    expect(modelTableAgeDays(table, now)).toBe(77);
  });
});

// ---- Loader: override resolution + corrupt-override fallthrough ---------------

describe("model calibration table loader", () => {
  let previousDataDir: string | undefined;
  let tempDataDir: string;

  beforeEach(() => {
    previousDataDir = process.env["EPOCH_DATA_DIR"];
    tempDataDir = mkdtempSync(join(tmpdir(), "epoch-model-table-test-"));
    process.env["EPOCH_DATA_DIR"] = tempDataDir;
    resetTelemetry();
    resetSupplementaryCache();
    resetModelCalibrationTableCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env["EPOCH_DATA_DIR"];
    else process.env["EPOCH_DATA_DIR"] = previousDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
    resetModelCalibrationTableCache();
  });

  it("falls back to the bundled table when no override exists", () => {
    const loaded = defined(loadModelCalibrationTable());
    expect(Object.keys(loaded.table.models)).toHaveLength(16);
    expect(defined(loaded.table.models["gpt-4o"]).tokensPerSecond).toBe(85);
  });

  it("a user-dir override shadows the bundled table", () => {
    const override = defined(parseModelCalibrationTable(SHIPPED_TABLE));
    override.models["gpt-4o"] = { ...defined(override.models["gpt-4o"]), tokensPerSecond: 42 };
    writeFileSync(join(tempDataDir, "model-calibrations.json"), JSON.stringify(override), "utf-8");
    resetModelCalibrationTableCache();
    expect(defined(getBundledModelCalibrations()["gpt-4o"]).tokensPerSecond).toBe(42);
  });

  it("a corrupt override is skipped, not trusted (bundled table wins)", () => {
    writeFileSync(join(tempDataDir, "model-calibrations.json"), "{ not json", "utf-8");
    resetModelCalibrationTableCache();
    const loaded = defined(loadModelCalibrationTable());
    expect(defined(loaded.table.models["gpt-4o"]).tokensPerSecond).toBe(85);
  });

  it("a structurally invalid override (unstamped entry) is skipped", () => {
    writeFileSync(
      join(tempDataDir, "model-calibrations.json"),
      JSON.stringify({ version: 1, refreshed_at: "2026-01-01", models: { "gpt-4o": { tokensPerSecond: 50 } } }),
      "utf-8",
    );
    resetModelCalibrationTableCache();
    expect(defined(getBundledModelCalibrations()["gpt-4o"]).tokensPerSecond).toBe(85);
  });
});

// ---- Staleness surfacing in outputs --------------------------------------------

describe("token_time_bridge staleness surface (S4.1)", () => {
  let previousDataDir: string | undefined;
  let tempDataDir: string;

  beforeEach(() => {
    previousDataDir = process.env["EPOCH_DATA_DIR"];
    tempDataDir = mkdtempSync(join(tmpdir(), "epoch-ttb-stale-test-"));
    mkdirSync(tempDataDir, { recursive: true });
    process.env["EPOCH_DATA_DIR"] = tempDataDir;
    resetTelemetry();
    resetSupplementaryCache();
    resetModelCalibrationTableCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env["EPOCH_DATA_DIR"];
    else process.env["EPOCH_DATA_DIR"] = previousDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
    resetModelCalibrationTableCache();
  });

  function installTableWithGpt4oMeasuredAt(iso: string): void {
    const table = defined(parseModelCalibrationTable(SHIPPED_TABLE));
    table.models["gpt-4o"] = { ...defined(table.models["gpt-4o"]), measured_at: iso };
    writeFileSync(join(tempDataDir, "model-calibrations.json"), JSON.stringify(table), "utf-8");
    resetModelCalibrationTableCache();
  }

  it("carries the calibration block with provenance/measuredAt/ageDays for table models", () => {
    installTableWithGpt4oMeasuredAt("2026-09-01");
    const result = tokenTimeBridge({ tokens: 5000, model: "gpt-4o", toolCalls: 2, reasoningDepth: "shallow" });
    expect(result.calibration.provenance).toBe("calibrated_table");
    expect(result.calibration.measuredAt).toBe("2026-09-01");
    expect(typeof result.calibration.ageDays).toBe("number");
    expect(result.calibration.stale).toBe(false);
    expect(result.humanReadable).not.toContain("stale");
  });

  it("flags staleness in output + humanReadable when table age > 90d", () => {
    installTableWithGpt4oMeasuredAt("2026-01-01");
    const result = tokenTimeBridge({ tokens: 5000, model: "gpt-4o", toolCalls: 2, reasoningDepth: "shallow" });
    expect(result.calibration.stale).toBe(true);
    expect(result.calibration.ageDays).toBeGreaterThan(90);
    expect(result.humanReadable).toContain("may be stale");
    expect(result.humanReadable).toContain("refresh-model-calibrations");
  });

  it("placeholder entries surface their sibling-copy note", () => {
    const result = tokenTimeBridge({ tokens: 5000, model: "claude-fable-5", toolCalls: 0, reasoningDepth: "shallow" });
    expect(result.calibration.note).toContain("placeholder");
    expect(result.calibration.note).toContain("not primary-source verified");
  });

  it("generic fallback carries no age and is never flagged stale", () => {
    const result = tokenTimeBridge({ tokens: 5000, model: "unknown-model-zz9", toolCalls: 0, reasoningDepth: "shallow" });
    expect(result.calibration.provenance).toBe("generic_fallback");
    expect(result.calibration.measuredAt).toBeNull();
    expect(result.calibration.ageDays).toBeNull();
    expect(result.calibration.stale).toBe(false);
  });
});

// ---- data status staleness surface ----------------------------------------------

describe("epoch data status model-table age (S4.1)", () => {
  let previousDataDir: string | undefined;
  let tempDataDir: string;

  beforeEach(() => {
    previousDataDir = process.env["EPOCH_DATA_DIR"];
    tempDataDir = mkdtempSync(join(tmpdir(), "epoch-ds-stale-test-"));
    process.env["EPOCH_DATA_DIR"] = tempDataDir;
    resetTelemetry();
    resetSupplementaryCache();
    resetModelCalibrationTableCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env["EPOCH_DATA_DIR"];
    else process.env["EPOCH_DATA_DIR"] = previousDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
    resetModelCalibrationTableCache();
  });

  it("reports the bundled table's age and placeholder list", () => {
    const status = getEpochDataStatus();
    expect(status.modelCalibrations.loaded).toBe(true);
    expect(status.modelCalibrations.entries).toBe(16);
    expect(status.modelCalibrations.refreshedAt).toBe("2026-07-09");
    expect(status.modelCalibrations.ageDays).not.toBeNull();
    expect(status.modelCalibrations.stalenessThresholdDays).toBe(90);
    expect(status.modelCalibrations.placeholderEntries).toEqual(PLACEHOLDER_MODELS);
  });

  it("flags stale=true when the loaded table is older than 90d", () => {
    // deep-copy the shipped table into a mutable shape, then age every stamp
    const table = JSON.parse(SHIPPED_TABLE) as {
      models: Record<string, { measured_at: string }>;
    } & Record<string, unknown>;
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    table.refreshed_at = old;
    for (const k of Object.keys(table.models)) table.models[k] = { ...table.models[k], measured_at: old };
    writeFileSync(join(tempDataDir, "model-calibrations.json"), JSON.stringify(table), "utf-8");
    resetModelCalibrationTableCache();

    const status = getEpochDataStatus();
    expect(status.modelCalibrations.stale).toBe(true);
    expect(status.modelCalibrations.ageDays).toBeGreaterThan(90);
    expect(status.modelCalibrations.staleEntries.length).toBe(16);
  });
});
