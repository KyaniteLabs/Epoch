// ---------------------------------------------------------------------------
// Ticket 17 (ledger read cache) — real-filesystem behavior tests
// ---------------------------------------------------------------------------
//
// ledger.test.ts mocks node:fs wholesale, so the cache's interactions with the
// REAL filesystem — external appends, append-path write-then-read consistency,
// atomic rename rewrites, and the 5k-row smoke — live here against a temp
// EPOCH_DATA_DIR instead.
//
// Ticket: .scratch/epoch-remediation/issues/17-ledger-read-cache.md
// PRD: .omx/plans/prd-epoch-remediation.md (W3 performance)

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readLines,
  loadLedgerWithOverlays,
  resetLedgerReadCache,
  getLedgerCacheStatus,
  ESTIMATES_FILE,
  ACTUALS_FILE,
  type EstimateRecord,
  type ActualRecord,
} from "./ledger.js";
import { recordEstimate, recordActualDetailed } from "./feedback.js";

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-ledger-cache-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
  resetLedgerReadCache();
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env["EPOCH_DATA_DIR"];
  } else {
    process.env["EPOCH_DATA_DIR"] = previousDataDir;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});

function estimatesPath(): string {
  return join(tempDataDir, ESTIMATES_FILE);
}

function actualsPath(): string {
  return join(tempDataDir, ACTUALS_FILE);
}

function parsesOf(path: string): number {
  return getLedgerCacheStatus().get(path)?.parses ?? 0;
}

function writeEstimates(rows: unknown[]): void {
  writeFileSync(estimatesPath(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

// ---- external appends --------------------------------------------------------

describe("ledger read cache — external modification pickup (ticket 17)", () => {
  it("an append written directly to the file by another writer is visible on the next read", () => {
    writeEstimates([{ id: "e1" }, { id: "e2" }]);
    expect(readLines<EstimateRecord>(ESTIMATES_FILE)).toHaveLength(2);
    expect(parsesOf(estimatesPath())).toBe(1);

    // External append (not via feedback.ts) — the stat key's size changes.
    appendFileSync(estimatesPath(), JSON.stringify({ id: "e3" }) + "\n", "utf-8");

    const after = readLines<EstimateRecord>(ESTIMATES_FILE);
    expect(after.map((r) => r.id)).toEqual(["e1", "e2", "e3"]);
    expect(parsesOf(estimatesPath())).toBe(2);
  });

  it("a same-size atomic rename rewrite is picked up via inode/mtime, not just content size", () => {
    const row = JSON.stringify({ id: "e1", tag: "before" }) + "\n";
    writeFileSync(estimatesPath(), row, "utf-8");
    expect(readLines<EstimateRecord>(ESTIMATES_FILE)[0]?.["id"]).toBe("e1");

    // Atomic rewrite pattern (migrations' atomicWriteJsonl): write a temp
    // file with the SAME byte size, then rename it over the target. Size
    // alone cannot distinguish these — inode/mtime must.
    const tmp = estimatesPath() + ".tmp";
    writeFileSync(tmp, JSON.stringify({ id: "e9", tag: "after!" }) + "\n", "utf-8");
    renameSync(tmp, estimatesPath());

    const after = readLines<EstimateRecord>(ESTIMATES_FILE);
    expect(after[0]?.["id"]).toBe("e9");
    expect(parsesOf(estimatesPath())).toBe(2);
  });

  it("deleting the ledger between reads yields [] (no stale cache serving)", () => {
    writeEstimates([{ id: "e1" }]);
    expect(readLines<EstimateRecord>(ESTIMATES_FILE)).toHaveLength(1);
    rmSync(estimatesPath());
    expect(readLines<EstimateRecord>(ESTIMATES_FILE)).toEqual([]);
  });
});

// ---- own-write consistency ---------------------------------------------------

describe("ledger read cache — write-then-read via the normal append path (ticket 17)", () => {
  it("recordEstimate's append is visible to the next readLines/loadLedgerWithOverlays", () => {
    writeEstimates([]);
    expect(readLines<EstimateRecord>(ESTIMATES_FILE)).toEqual([]);

    const id = recordEstimate("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 3 }, { expected: 2, unit: "hours" });

    const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
    expect(estimates.map((e) => e.id)).toEqual([id]);

    const merged = loadLedgerWithOverlays();
    expect(merged.find((r) => r.id === id)).toBeDefined();
    expect(merged.find((r) => r.id === id)?.archived).toBe(false);
  });

  it("recordActualDetailed's append joins the estimate on the next ledger load", () => {
    const id = recordEstimate("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 3 }, { expected: 10, unit: "hours" });

    const result = recordActualDetailed(id, 8);
    expect(result.ok).toBe(true);

    // Duplicate rejection must also see the fresh append...
    expect(recordActualDetailed(id, 9)).toMatchObject({ ok: false, reason: "duplicate" });

    // ...and the joined pair must be visible through the merged view.
    const merged = loadLedgerWithOverlays();
    expect(merged.find((r) => r.id === id)?.actual?.actualHours).toBe(8);

    const actuals = readLines<ActualRecord>(ACTUALS_FILE);
    expect(actuals.filter((a) => a.estimateId === id)).toHaveLength(1);
  });
});

// ---- cache mutation safety ---------------------------------------------------

describe("ledger read cache — mutation safety (ticket 17)", () => {
  it("a caller sorting/mutating a returned array cannot corrupt subsequent reads (real fs)", () => {
    writeEstimates([{ id: "e1" }, { id: "e2" }, { id: "e3" }]);

    const rows = readLines<EstimateRecord>(ESTIMATES_FILE);
    rows.reverse();
    rows.push({ id: "injected" } as unknown as EstimateRecord);

    expect(readLines<EstimateRecord>(ESTIMATES_FILE).map((r) => r.id)).toEqual(["e1", "e2", "e3"]);
    expect(parsesOf(estimatesPath())).toBe(1);
  });
});

// ---- 5k-row smoke (parse-count bound, no wall-clock assert) -------------------

describe("ledger read cache — 5k-row smoke (ticket 17)", () => {
  it("repeated full ledger loads over 5k rows parse each file exactly once", () => {
    const ratios = [0.5, 0.6, 0.7, 1.0, 1.3, 1.5, 2.0];
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: `cache-5k-${i}`,
      tool: "pert_estimate",
      inputs: { task_type: "bugfix" },
      outputs: { expected: 10, unit: "hours" },
      estimatedAt: "2026-06-01T00:00:00.000Z",
    }));
    writeFileSync(estimatesPath(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    writeFileSync(
      actualsPath(),
      rows.map((r, i) => JSON.stringify({ estimateId: r.id, actualHours: 10 * (ratios[i % ratios.length] ?? 1), reportedAt: "2026-06-02T00:00:00.000Z" })).join("\n") + "\n",
      "utf-8",
    );

    const ledgerFiles = [estimatesPath(), actualsPath()];

    const started = Date.now();
    const cold = loadLedgerWithOverlays();
    const coldMs = Date.now() - started;
    const warmStarted = Date.now();
    loadLedgerWithOverlays();
    loadLedgerWithOverlays();
    loadLedgerWithOverlays();
    const warmMs = Date.now() - warmStarted;

    expect(cold).toHaveLength(5000);
    for (const path of ledgerFiles) {
      expect(parsesOf(path), `${path} parsed exactly once across 4 loads`).toBe(1);
    }

    // Smoke only (not a hard assert): warm loads must not re-parse.
    console.log(`[ledger-cache smoke] 5k rows: cold load ${coldMs}ms (1 parse/file), 3 warm loads ${warmMs}ms (0 parses)`);
  });
});
