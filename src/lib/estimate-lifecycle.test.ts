// ---------------------------------------------------------------------------
// Estimate lifecycle state machine — table, transitions, legacy reads, the
// bugs the consolidation fixed, and a seeded random-walk model test.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ESTIMATE_STAGES,
  checkRecordActual,
  estimateStage,
  isPastExpiry,
  type EstimateStage,
} from "./estimate-lifecycle.js";
import { isExcluded } from "./exclusion.js";
import { getPendingEstimates, recordActualDetailed, batchRecordActuals } from "./feedback.js";
import { computeDashboardData } from "./dashboard-data.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const PAST = "2026-11-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";

// Exhaustive by construction: adding a stage to ESTIMATE_STAGES without a row
// here is a type error, and the iteration tests below then cover it.
const RECORD_ACTUAL_TABLE: Record<EstimateStage, "ok" | "duplicate"> = {
  pending: "ok",
  expired: "ok",
  recorded: "duplicate",
};

describe("estimate lifecycle — derived state table", () => {
  const rows: Array<[string | undefined, boolean, EstimateStage]> = [
    [undefined, false, "pending"],
    [FUTURE, false, "pending"],
    [PAST, false, "expired"],
    [undefined, true, "recorded"],
    [FUTURE, true, "recorded"],
    [PAST, true, "recorded"],
  ];
  it.each(rows)("expiresAt=%s hasActual=%s → %s", (expiresAt, hasActual, stage) => {
    expect(estimateStage(expiresAt === undefined ? {} : { expiresAt }, hasActual, NOW)).toBe(stage);
  });

  it("every stage is reachable from the table", () => {
    const reached = new Set(rows.map((r) => r[2]));
    for (const stage of ESTIMATE_STAGES) expect(reached.has(stage)).toBe(true);
  });

  it("legacy rows: missing or unparseable expiresAt never expire", () => {
    expect(estimateStage({}, false, Number.MAX_SAFE_INTEGER)).toBe("pending");
    expect(estimateStage({ expiresAt: "not-a-date" }, false, NOW)).toBe("pending");
    expect(estimateStage({ expiresAt: "" }, false, NOW)).toBe("pending");
  });

  it("expiry boundary: expired from the instant now >= expiresAt", () => {
    const at = new Date(NOW).toISOString();
    expect(isPastExpiry(at, NOW - 1)).toBe(false);
    expect(isPastExpiry(at, NOW)).toBe(true);
    expect(isPastExpiry(at, new Date(NOW))).toBe(true);
  });
});

describe("estimate lifecycle — record_actual transition", () => {
  it.each(ESTIMATE_STAGES.map((s) => [s] as const))("from %s", (stage) => {
    const expected = RECORD_ACTUAL_TABLE[stage];
    const verdict = checkRecordActual(stage);
    if (expected === "ok") expect(verdict).toEqual({ ok: true });
    else expect(verdict).toEqual({ ok: false, reason: "duplicate" });
  });
});

describe("estimate lifecycle — every reader agrees on expiry", () => {
  it("isExcluded() ttl_expired matches estimateStage at the exact boundary instant", () => {
    // Bug: exclusion.ts used `expiresAt < now` while the dedup reuse check used
    // `expiresAt <= now`, so at the boundary instant one reader called the
    // estimate pending and the other expired.
    const at = new Date(NOW).toISOString();
    const verdict = isExcluded({ id: "e1", tool: "pert_estimate", estimatedAt: PAST, expiresAt: at }, new Date(NOW));
    expect(estimateStage({ expiresAt: at }, false, NOW)).toBe("expired");
    expect(verdict).toEqual({ excluded: true, reason: "ttl_expired" });
  });
});

// ---- ledger-backed tests ----------------------------------------------------

let previousDataDir: string | undefined;
let previousDryRun: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  previousDryRun = process.env["EPOCH_DRY_RUN"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-estimate-lifecycle-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
  delete process.env["EPOCH_DRY_RUN"];
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env["EPOCH_DATA_DIR"];
  else process.env["EPOCH_DATA_DIR"] = previousDataDir;
  if (previousDryRun === undefined) delete process.env["EPOCH_DRY_RUN"];
  else process.env["EPOCH_DRY_RUN"] = previousDryRun;
  rmSync(tempDataDir, { recursive: true, force: true });
});

function writeJsonl(name: string, rows: unknown[]): void {
  writeFileSync(join(tempDataDir, name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

function estimateRow(id: string, expiresAt?: string): Record<string, unknown> {
  return {
    id,
    tool: "pert_estimate",
    inputs: { task_type: "feature" },
    outputs: { expected: 4 },
    estimatedAt: "2026-10-01T00:00:00.000Z",
    ...(expiresAt && { expiresAt }),
  };
}

describe("getPendingEstimates — derived stage, not isExcluded()'s first reason", () => {
  it("drops an expired synthetic-id estimate (old code listed it as pending)", () => {
    // isExcluded() reports synthetic_id BEFORE ttl_expired, so the old filter
    // (`reason === "ttl_expired"`) never saw the expiry and kept the row.
    writeJsonl("estimates.jsonl", [estimateRow("seed-expired", PAST), estimateRow("live", FUTURE)]);
    const ids = getPendingEstimates(50).map((e) => e.id);
    expect(ids).toEqual(["live"]);
  });

  it("lists pending, hides expired and recorded", () => {
    writeJsonl("estimates.jsonl", [
      estimateRow("p", FUTURE),
      estimateRow("legacy-no-ttl"),
      estimateRow("x", PAST),
      estimateRow("r", FUTURE),
    ]);
    writeJsonl("feedback.jsonl", [{ estimateId: "r", actualHours: 3, reportedAt: "2026-10-02T00:00:00.000Z" }]);
    expect(getPendingEstimates(50).map((e) => e.id)).toEqual(["p", "legacy-no-ttl"]);
  });
});

describe("dashboard expiredPending — counts every expired estimate", () => {
  it("counts a quarantined estimate whose TTL elapsed (old code missed it)", () => {
    writeJsonl("estimates.jsonl", [estimateRow("plain", PAST), estimateRow("flagged", PAST), estimateRow("fresh", FUTURE)]);
    writeJsonl("estimates.flags.jsonl", [
      { id: "flagged", seq: 1, recordedAt: "2026-10-05T00:00:00.000Z", quarantined: true, reason: "manual" },
    ]);
    expect(computeDashboardData().integrity.expiredPending.count).toBe(2);
  });
});

describe("record_actual through the real write paths", () => {
  it("single and batch paths both accept EXPIRED and refuse RECORDED as duplicate", () => {
    writeJsonl("estimates.jsonl", [estimateRow("e-exp", PAST), estimateRow("e-pend", FUTURE)]);
    expect(recordActualDetailed("e-exp", 2)).toMatchObject({ ok: true });
    expect(recordActualDetailed("e-exp", 2)).toEqual({ ok: false, reason: "duplicate" });
    const batch = batchRecordActuals([
      { estimateId: "e-pend", actualHours: 2 },
      { estimateId: "e-pend", actualHours: 3 },
      { estimateId: "e-exp", actualHours: 2 },
    ]);
    expect(batch.succeeded).toBe(1);
    expect(batch.errors.filter((e) => e.includes("reason: duplicate"))).toHaveLength(2);
  });
});

// ---- stateful model test ------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG so failures replay from the seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("estimate lifecycle — random transition sequences (model test)", () => {
  it.each([1, 2, 3, 42, 1337, 9001])("seed %i: invariants hold after every step", (seed) => {
    const rand = rng(seed);
    interface ModelEstimate { expiresAt?: string; hasActual: boolean; lastStage: EstimateStage }
    const model: ModelEstimate[] = [];
    let clock = NOW;
    const legal = new Set<string>();

    for (let step = 0; step < 400; step++) {
      const action = rand();
      if (action < 0.3 || model.length === 0) {
        // mint — TTL somewhere in [-5d, +5d], sometimes legacy (no TTL) or garbage
        const r = rand();
        const expiresAt = r < 0.1 ? undefined : r < 0.15 ? "garbage" : new Date(clock + (rand() - 0.5) * 10 * 86_400_000).toISOString();
        const e: ModelEstimate = { ...(expiresAt !== undefined && { expiresAt }), hasActual: false, lastStage: "pending" };
        e.lastStage = estimateStage(e, false, clock);
        model.push(e);
      } else if (action < 0.6) {
        clock += Math.floor(rand() * 2 * 86_400_000); // time only moves forward
      } else {
        const e = model[Math.floor(rand() * model.length)];
        if (!e) continue;
        const before = estimateStage(e, e.hasActual, clock);
        const verdict = checkRecordActual(before);
        expect(verdict.ok).toBe(RECORD_ACTUAL_TABLE[before] === "ok");
        if (verdict.ok) e.hasActual = true;
      }

      for (const e of model) {
        const stage = estimateStage(e, e.hasActual, clock);
        // recorded ⇔ an actual exists
        expect(stage === "recorded").toBe(e.hasActual);
        // only diagrammed edges are ever taken
        const edge = `${e.lastStage}->${stage}`;
        expect(["pending->pending", "pending->expired", "pending->recorded", "expired->expired", "expired->recorded", "recorded->recorded"]).toContain(edge);
        legal.add(edge);
        // the exclusion predicate agrees with the lifecycle about expiry
        if (!e.hasActual) {
          const v = isExcluded({ id: "m", tool: "pert_estimate", estimatedAt: PAST, ...(e.expiresAt !== undefined && { expiresAt: e.expiresAt }) }, new Date(clock));
          expect(v.excluded && v.reason === "ttl_expired").toBe(stage === "expired");
        }
        e.lastStage = stage;
      }
    }
    // the walk actually exercised the interesting edges
    expect(legal.has("pending->expired")).toBe(true);
    expect(legal.has("pending->recorded") || legal.has("expired->recorded")).toBe(true);
  });
});
