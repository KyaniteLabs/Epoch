// ---------------------------------------------------------------------------
// Tests for scripts/refresh-model-calibrations.mjs (S4.1 fail-closed refresh).
//
// Spawns the script as a real child process against fixture tables in a temp
// dir and proves the fail-closed contract: any provenance/freshness violation
// exits non-zero and leaves the table byte-identical; a valid run writes an
// atomically refreshed stamped table plus a diff + source receipt.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseModelCalibrationTable } from "./model-calibration-table.js";
import { defined } from "../test-support.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SRC_DIR, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "refresh-model-calibrations.mjs");
const SHIPPED_TABLE = readFileSync(join(REPO_ROOT, "data", "model-calibrations.json"), "utf-8");

const WORK_DIR = join(tmpdir(), `epoch-refresh-test-${Date.now()}`);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], { encoding: "utf-8", timeout: 60_000 });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function fixtureTablePath(name: string): string {
  return join(WORK_DIR, name);
}

beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

// A valid public-source snapshot in the community schema: refreshes an
// existing model's tokensPerSecond with stamps.
const GOOD_SNAPSHOT = [
  {
    model: "claude-haiku-4-5",
    tokens_per_second: 87,
    time_to_first_token_ms: 310,
    avg_api_latency_ms: 1200,
    cost_input_per_million: 1.0,
    cost_output_per_million: 5.0,
    measured_at: "2026-09-20",
    benchmark_source: "artificialanalysis.ai (public page snapshot, zero-cost)",
  },
];

describe("refresh-model-calibrations.mjs — happy path", () => {
  it("dry-run emits diff + receipt, exits 0, and does NOT write", () => {
    const table = fixtureTablePath("dry-table.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const snapshot = fixtureTablePath("good.json");
    writeFileSync(snapshot, JSON.stringify(GOOD_SNAPSHOT), "utf-8");

    const receipt = fixtureTablePath("dry-receipt.json");
    const res = runScript(["--table", table, "--input", snapshot, "--dry-run", "--receipt", receipt]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("dry run");
    expect(res.stdout).toContain("claude-haiku-4-5: tokensPerSecond 100 -> 87");
    expect(existsSync(receipt)).toBe(true);
    // table untouched
    expect(readFileSync(table, "utf-8")).toBe(SHIPPED_TABLE);
  });

  it("a valid run writes a fully-stamped table atomically and the receipt cites sources", () => {
    const table = fixtureTablePath("write-table.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const snapshot = fixtureTablePath("good2.json");
    writeFileSync(snapshot, JSON.stringify(GOOD_SNAPSHOT), "utf-8");
    const receipt = fixtureTablePath("write-receipt.json");

    const res = runScript(["--table", table, "--input", snapshot, "--receipt", receipt]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("wrote:");

    const next = defined(parseModelCalibrationTable(readFileSync(table, "utf-8")));
    const haiku = defined(next.models["claude-haiku-4-5"]);
    expect(haiku.tokensPerSecond).toBe(87);
    expect(haiku.measured_at).toBe("2026-09-20");
    expect(haiku.provenance.kind).toBe("public_source");
    expect(haiku.provenance.source).toContain("artificialanalysis.ai");
    // refreshed_at advanced to the max entry measured_at
    expect(next.refreshed_at).toBe("2026-09-20");
    // no entries lost
    expect(Object.keys(next.models)).toHaveLength(16);

    const receiptJson = JSON.parse(readFileSync(receipt, "utf-8")) as {
      dry_run: boolean;
      sources: Array<{ file: string; skipped?: string }>;
      per_entry: Record<string, { source: string; measured_at: string; fields_refreshed: string[]; fields_carried_over: string[] }>;
    };
    expect(receiptJson.dry_run).toBe(false);
    const inputSources = receiptJson.sources.filter((s) => !s.skipped);
    expect(inputSources).toHaveLength(1);
    expect(defined(inputSources[0]).file).toContain("good2.json");
    const per = defined(receiptJson.per_entry["claude-haiku-4-5"]);
    expect(per.fields_refreshed).toEqual(["tokensPerSecond"]);
    expect(per.fields_carried_over).toEqual(["reasoningOverheadMs", "toolCallLatencyMs"]);
    expect(per.source).toContain("good2.json");
  });

  it("ingests community-schema records from the community dir", () => {
    const table = fixtureTablePath("comm-table.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const community = fixtureTablePath("community");
    mkdirSync(community, { recursive: true });
    writeFileSync(
      join(community, "contributor-a-models.json"),
      JSON.stringify([{ ...GOOD_SNAPSHOT[0], model: "gpt-4o", tokens_per_second: 91, measured_at: "2026-09-22", benchmark_source: "BenchLM.ai public page" }]),
      "utf-8",
    );
    // a non-model-calibration community file is skipped, not fatal
    writeFileSync(join(community, "contributor-b-estimations.json"), JSON.stringify({ records: [{ taskType: "bugfix" }] }), "utf-8");

    const res = runScript(["--table", table, "--community", community, "--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("gpt-4o: tokensPerSecond 85 -> 91");
    // receipt (printed to stdout in dry-run) cites the benchmark source per entry
    expect(res.stdout).toContain("BenchLM.ai public page");
  });
});

describe("refresh-model-calibrations.mjs — fail closed", () => {
  it("record missing measured_at: non-zero exit, table byte-identical, no receipt write claim", () => {
    const table = fixtureTablePath("fc1.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const bad = fixtureTablePath("bad-no-date.json");
    writeFileSync(
      bad,
      JSON.stringify([{ model: "gpt-4o", tokens_per_second: 90, time_to_first_token_ms: 300, avg_api_latency_ms: 3000, cost_input_per_million: 2.5, cost_output_per_million: 10 }]),
      "utf-8",
    );

    const res = runScript(["--table", table, "--input", bad]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("FAIL CLOSED");
    expect(readFileSync(table, "utf-8")).toBe(SHIPPED_TABLE);
  });

  it("record missing community-schema required fields: non-zero exit, table unchanged", () => {
    const table = fixtureTablePath("fc2.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const bad = fixtureTablePath("bad-partial.json");
    // missing time_to_first_token_ms / costs — incomplete community record
    writeFileSync(bad, JSON.stringify([{ model: "gpt-4o", tokens_per_second: 90, measured_at: "2026-09-01" }]), "utf-8");

    const res = runScript(["--table", table, "--input", bad]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("community record missing required field");
    expect(readFileSync(table, "utf-8")).toBe(SHIPPED_TABLE);
  });

  it("BASE table entry missing provenance: non-zero exit, no partial write", () => {
    const table = fixtureTablePath("fc3.json");
    const broken = JSON.parse(SHIPPED_TABLE);
    delete broken.models["gpt-4o"].provenance;
    const brokenRaw = JSON.stringify(broken, null, 2) + "\n";
    writeFileSync(table, brokenRaw, "utf-8");
    const snapshot = fixtureTablePath("good3.json");
    writeFileSync(snapshot, JSON.stringify(GOOD_SNAPSHOT), "utf-8");

    const res = runScript(["--table", table, "--input", snapshot]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("gpt-4o: missing provenance stamp");
    // byte-identical — the haiku refresh that WOULD have applied is not partially written
    expect(readFileSync(table, "utf-8")).toBe(brokenRaw);
  });

  it("future measured_at is rejected", () => {
    const table = fixtureTablePath("fc4.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const bad = fixtureTablePath("bad-future.json");
    writeFileSync(
      bad,
      JSON.stringify([{ ...GOOD_SNAPSHOT[0], model: "gpt-4o", tokens_per_second: 90, measured_at: "2100-01-01" }]),
      "utf-8",
    );

    const res = runScript(["--table", table, "--input", bad]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("in the future");
    expect(readFileSync(table, "utf-8")).toBe(SHIPPED_TABLE);
  });

  it("adding a NEW model from a community-schema record is rejected (latency fields unmeasurable)", () => {
    const table = fixtureTablePath("fc5.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const bad = fixtureTablePath("bad-new.json");
    writeFileSync(bad, JSON.stringify([{ ...GOOD_SNAPSHOT[0], model: "totally-new-model" }]), "utf-8");

    const res = runScript(["--table", table, "--input", bad]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("cannot ADD a new model from a community-schema record");
    expect(readFileSync(table, "utf-8")).toBe(SHIPPED_TABLE);
  });

  it("a full stamped-table record CAN add a new model", () => {
    const table = fixtureTablePath("ok-new.json");
    writeFileSync(table, SHIPPED_TABLE, "utf-8");
    const snap = fixtureTablePath("ok-new.json.input");
    writeFileSync(
      snap,
      JSON.stringify([{ model: "totally-new-model", tokensPerSecond: 120, reasoningOverheadMs: 200, toolCallLatencyMs: 180, measured_at: "2026-09-18", provenance: { kind: "public_source", source: "artificialanalysis.ai snapshot" } }]),
      "utf-8",
    );

    const res = runScript(["--table", table, "--input", snap]);
    expect(res.code).toBe(0);
    const next = defined(parseModelCalibrationTable(readFileSync(table, "utf-8")));
    expect(defined(next.models["totally-new-model"]).tokensPerSecond).toBe(120);
    expect(Object.keys(next.models)).toHaveLength(17);
  });
});
