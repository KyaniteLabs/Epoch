import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { existsSync, readFileSync, statSync } from "node:fs";
import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";
import {
  readLines,
  loadLedgerWithOverlays,
  appendOverlayRecord,
  resetLedgerReadCache,
  getLedgerCacheStatus,
  ESTIMATES_FILE,
  ACTUALS_FILE,
  FLAGS_FILE,
  LABELS_FILE,
  QUARANTINE_ARCHIVE_FILE,
  type EstimateRecord,
} from "./ledger.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  // Ticket 17 read cache: start every test with a cold cache and statSync
  // unconfigured (a throwing stat degrades readLines to a cache-bypass read,
  // which is the pre-cache behavior the original suites below pin).
  resetLedgerReadCache();
  mockStatSync.mockReset();
  mockStatSync.mockImplementation(() => {
    throw new Error("statSync not configured for this test");
  });
});

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function mockFiles(files: Record<string, unknown[]>) {
  mockReadFileSync.mockImplementation((path: unknown) => {
    const p = path as string;
    for (const [filename, records] of Object.entries(files)) {
      if (p.endsWith(filename)) return jsonl(records);
    }
    return "";
  });
}

// ---- readLines ----

describe("readLines", () => {
  it("returns [] when the file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readLines<EstimateRecord>(ESTIMATES_FILE)).toEqual([]);
  });

  it("parses valid JSONL lines", () => {
    mockReadFileSync.mockReturnValue(jsonl([{ id: "e1" }, { id: "e2" }]));
    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1" }, { id: "e2" }]);
  });

  it("skips malformed lines without throwing", () => {
    mockReadFileSync.mockReturnValue('{"id":"e1"}\nnot-json\n{"id":"e2"}\n');
    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1" }, { id: "e2" }]);
  });

  it("returns [] on a read error", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([]);
  });
});

// ---- appendOverlayRecord ----

describe("appendOverlayRecord", () => {
  it("assigns seq=1 for the first record in an empty file", () => {
    mockExistsSync.mockReturnValue(false);
    const appendLine = vi.fn().mockReturnValue(true);
    const result = appendOverlayRecord(FLAGS_FILE, { id: "e1", quarantined: true, reason: "backfill" }, appendLine);
    expect(result.seq).toBe(1);
    expect(result.id).toBe("e1");
    expect(appendLine).toHaveBeenCalledWith(FLAGS_FILE, expect.objectContaining({ seq: 1, id: "e1" }));
  });

  it("assigns the next monotonic seq after existing records", () => {
    mockFiles({ [FLAGS_FILE]: [{ id: "e1", seq: 1, recordedAt: "2026-01-01T00:00:00Z", quarantined: true }, { id: "e2", seq: 2, recordedAt: "2026-01-02T00:00:00Z", quarantined: true }] });
    const appendLine = vi.fn().mockReturnValue(true);
    const result = appendOverlayRecord(FLAGS_FILE, { id: "e3", quarantined: true }, appendLine);
    expect(result.seq).toBe(3);
  });

  it("defaults recordedAt to now when not supplied", () => {
    mockExistsSync.mockReturnValue(false);
    const appendLine = vi.fn().mockReturnValue(true);
    const before = Date.now();
    const result = appendOverlayRecord(FLAGS_FILE, { id: "e1", quarantined: true }, appendLine);
    expect(Date.parse(result.recordedAt)).toBeGreaterThanOrEqual(before);
  });
});

// ---- loadLedgerWithOverlays ----

describe("loadLedgerWithOverlays", () => {
  it("joins a live estimate with its matched actual", () => {
    mockFiles({
      [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { totalHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }],
      [ACTUALS_FILE]: [{ estimateId: "e1", actualHours: 8, reportedAt: "2026-01-02T00:00:00Z" }],
    });

    const [record] = loadLedgerWithOverlays();
    expect(record).toBeDefined();
    expect(record?.id).toBe("e1");
    expect(record?.actual?.actualHours).toBe(8);
    expect(record?.archived).toBe(false);
    expect(record?.flags).toEqual({ quarantined: false, orphan: false });
  });

  it("returns a pending record (no actual field) when unmatched", () => {
    mockFiles({
      [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }],
    });

    const [record] = loadLedgerWithOverlays();
    expect(record?.actual).toBeUndefined();
  });

  it("merges a single quarantine flag record onto the matching estimate", () => {
    mockFiles({
      [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }],
      [FLAGS_FILE]: [{ id: "e1", seq: 1, recordedAt: "2026-01-05T00:00:00Z", quarantined: true, reason: "backfill" }],
    });

    const [record] = loadLedgerWithOverlays();
    expect(record?.flags.quarantined).toBe(true);
    expect(record?.flags.quarantineReason).toBe("backfill");
  });

  it("merges an orphan flag and a label overlay independently onto the same record", () => {
    mockFiles({
      [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }],
      [FLAGS_FILE]: [{ id: "e1", seq: 1, recordedAt: "2026-01-05T00:00:00Z", orphan: true }],
      [LABELS_FILE]: [{ id: "e1", seq: 1, recordedAt: "2026-01-06T00:00:00Z", taskLabel: "retro-labeled-feature" }],
    });

    const [record] = loadLedgerWithOverlays();
    expect(record?.flags.orphan).toBe(true);
    expect(record?.flags.taskLabel).toBe("retro-labeled-feature");
  });

  it("includes quarantine-archive rows with archived=true", () => {
    mockFiles({
      [ESTIMATES_FILE]: [],
      [QUARANTINE_ARCHIVE_FILE]: [{ id: "e-archived", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-05-05T00:00:00Z" }],
    });

    const [record] = loadLedgerWithOverlays();
    expect(record?.id).toBe("e-archived");
    expect(record?.archived).toBe(true);
  });

  describe("multi-flag conflict resolution (last-write-wins by recordedAt, tiebreak = monotonic seq)", () => {
    it("later recordedAt wins over an earlier one", () => {
      mockFiles({
        [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }],
        [FLAGS_FILE]: [
          { id: "e1", seq: 1, recordedAt: "2026-01-01T00:00:00Z", quarantined: true, reason: "first" },
          { id: "e1", seq: 2, recordedAt: "2026-01-05T00:00:00Z", quarantined: false, reason: "unquarantined-later" },
        ],
      });

      const [record] = loadLedgerWithOverlays();
      expect(record?.flags.quarantined).toBe(false);
      expect(record?.flags.quarantineReason).toBe("unquarantined-later");
    });

    it("on equal recordedAt, the higher monotonic seq wins — NOT file/line order", () => {
      mockFiles({
        [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }],
        [FLAGS_FILE]: [
          // Written out of seq order on purpose — seq (not file order) must decide.
          { id: "e1", seq: 5, recordedAt: "2026-01-05T00:00:00Z", reason: "higher-seq-written-first" },
          { id: "e1", seq: 2, recordedAt: "2026-01-05T00:00:00Z", reason: "lower-seq-written-second" },
        ],
      });

      const [record] = loadLedgerWithOverlays();
      expect(record?.flags.quarantineReason).toBe("higher-seq-written-first");
    });

    it("merges non-conflicting fields across ordered overlay records field-by-field", () => {
      mockFiles({
        [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }],
        [FLAGS_FILE]: [
          { id: "e1", seq: 1, recordedAt: "2026-01-01T00:00:00Z", quarantined: true },
          { id: "e1", seq: 2, recordedAt: "2026-01-02T00:00:00Z", orphan: true },
        ],
      });

      const [record] = loadLedgerWithOverlays();
      // Fields not touched by the later record persist from the earlier one —
      // this is a field-level merge in ascending (recordedAt, seq) order.
      expect(record?.flags.quarantined).toBe(true);
      expect(record?.flags.orphan).toBe(true);
    });
  });

  it("is deterministic: identical file contents produce byte-identical (deep-equal) output across calls", () => {
    mockFiles({
      [ESTIMATES_FILE]: [
        { id: "e1", tool: "pert_estimate", inputs: {}, outputs: { totalHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" },
        { id: "e2", tool: "cocomo_estimate", inputs: {}, outputs: { totalHours: 5 }, estimatedAt: "2026-01-02T00:00:00Z" },
      ],
      [ACTUALS_FILE]: [{ estimateId: "e1", actualHours: 8, reportedAt: "2026-01-03T00:00:00Z" }],
      [FLAGS_FILE]: [{ id: "e2", seq: 1, recordedAt: "2026-01-04T00:00:00Z", quarantined: true, reason: "test" }],
    });

    const first = loadLedgerWithOverlays();
    const second = loadLedgerWithOverlays();
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("returns [] when no ledger files exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadLedgerWithOverlays()).toEqual([]);
  });
});

// ---- readLines stat-keyed cache (ticket 17) ---------------------------------

describe("readLines read cache (ticket 17)", () => {
  /** Build a minimal Stats-shaped object (ino as number is fine — statKey stringifies it). */
  function fakeStat(size: number, mtimeMs: number, ino: number) {
    return { size, mtimeMs, ino } as unknown as NodeFs.Stats;
  }

  /** Configure a stable stat so repeated reads exercise the cache path. */
  function mockStableStat(size = 100, mtimeMs = 1_000, ino = 7) {
    mockStatSync.mockImplementation(() => fakeStat(size, mtimeMs, ino));
  }

  it("an unchanged stat key returns the cached parse without re-reading the file", () => {
    mockReadFileSync.mockReturnValue(jsonl([{ id: "e1" }, { id: "e2" }]));
    mockStableStat();

    readLines<{ id: string }>(ESTIMATES_FILE);
    const second = readLines<{ id: string }>(ESTIMATES_FILE);

    expect(second).toEqual([{ id: "e1" }, { id: "e2" }]);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("counts only real parses in the test-visible parse counter", () => {
    mockReadFileSync.mockReturnValue(jsonl([{ id: "e1" }]));
    mockStableStat();

    readLines(ESTIMATES_FILE);
    readLines(ESTIMATES_FILE);
    readLines(ESTIMATES_FILE);

    const parses = [...getLedgerCacheStatus().values()].reduce((sum, e) => sum + e.parses, 0);
    expect(parses).toBe(1);
  });

  it("a size change (external append) re-reads and re-parses", () => {
    mockReadFileSync.mockReturnValueOnce(jsonl([{ id: "e1" }])).mockReturnValueOnce(jsonl([{ id: "e1" }, { id: "e2" }]));
    let size = 50;
    mockStatSync.mockImplementation(() => fakeStat(size, 1_000, 7));

    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1" }]);

    size = 80; // an external process appended a row
    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1" }, { id: "e2" }]);
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it("an mtime-only change (same-size in-place rewrite) re-parses", () => {
    mockReadFileSync.mockReturnValueOnce(jsonl([{ id: "e1" }])).mockReturnValueOnce(jsonl([{ id: "e1-replaced" }]));
    let mtimeMs = 1_000;
    mockStatSync.mockImplementation(() => fakeStat(50, mtimeMs, 7));

    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1" }]);

    mtimeMs = 1_001; // same size, rewritten
    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1-replaced" }]);
  });

  it("an inode-only change (same-size rename rewrite) re-parses", () => {
    mockReadFileSync.mockReturnValueOnce(jsonl([{ id: "e1" }])).mockReturnValueOnce(jsonl([{ id: "e1-renamed" }]));
    let ino = 7;
    mockStatSync.mockImplementation(() => fakeStat(50, 1_000, ino));

    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1" }]);

    ino = 9; // atomic rename over the same path
    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1-renamed" }]);
  });

  it("a caller sorting or mutating its returned array cannot corrupt subsequent reads", () => {
    mockReadFileSync.mockReturnValue(jsonl([{ id: "e1" }, { id: "e2" }, { id: "e3" }]));
    mockStableStat();

    const rows = readLines<{ id: string }>(ESTIMATES_FILE);
    rows.sort((a, b) => b.id.localeCompare(a.id)); // descending
    rows.push({ id: "injected" });

    expect(readLines<{ id: string }>(ESTIMATES_FILE)).toEqual([{ id: "e1" }, { id: "e2" }, { id: "e3" }]);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns a fresh array per call, but cached rows are frozen (in-place row mutation fails loudly)", () => {
    mockReadFileSync.mockReturnValue(jsonl([{ id: "e1", inputs: { a: 1 } }]));
    mockStableStat();

    const first = readLines<{ id: string; inputs: Record<string, unknown> }>(ESTIMATES_FILE);
    const second = readLines<{ id: string; inputs: Record<string, unknown> }>(ESTIMATES_FILE);
    expect(second).not.toBe(first); // copy-on-read: each caller owns its array
    expect(second).toEqual(first);

    expect(Object.isFrozen(first[0])).toBe(true);
    const row = first[0] as { id: string };
    expect(() => {
      row.id = "mutated";
    }).toThrow();
  });

  it("resetLedgerReadCache drops cached rows and counters", () => {
    mockReadFileSync.mockReturnValue(jsonl([{ id: "e1" }]));
    mockStableStat();

    readLines(ESTIMATES_FILE);
    resetLedgerReadCache();
    expect(getLedgerCacheStatus().size).toBe(0);

    // Post-reset read re-parses even though the stat is unchanged.
    readLines(ESTIMATES_FILE);
    const parses = [...getLedgerCacheStatus().values()].reduce((sum, e) => sum + e.parses, 0);
    expect(parses).toBe(1);
  });

  it("EPOCH_LEDGER_CACHE=0 bypasses the cache (every read parses)", () => {
    mockReadFileSync.mockReturnValue(jsonl([{ id: "e1" }]));
    mockStableStat();
    process.env["EPOCH_LEDGER_CACHE"] = "0";
    try {
      readLines(ESTIMATES_FILE);
      readLines(ESTIMATES_FILE);
      expect(mockReadFileSync).toHaveBeenCalledTimes(2);
      const parses = [...getLedgerCacheStatus().values()].reduce((sum, e) => sum + e.parses, 0);
      expect(parses).toBe(2);
    } finally {
      delete process.env["EPOCH_LEDGER_CACHE"];
    }
  });

  it("caches overlay sidecar reads made through loadLedgerWithOverlays too", () => {
    mockFiles({
      [ESTIMATES_FILE]: [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }],
      [FLAGS_FILE]: [{ id: "e1", seq: 1, recordedAt: "2026-01-05T00:00:00Z", quarantined: true, reason: "backfill" }],
    });
    mockStableStat();

    loadLedgerWithOverlays();
    loadLedgerWithOverlays();
    loadLedgerWithOverlays();

    // 5 ledger files (live + archived estimates, actuals, flags, labels),
    // each parsed exactly once across three full ledger loads.
    expect(mockReadFileSync).toHaveBeenCalledTimes(5);
  });
});

// ---- Scenario 6 guard: no reader may bypass the shared ledger loader ----

describe("skipped-join guard (Pre-mortem Scenario 6)", () => {
  it("no src/lib/*.ts metrics module other than ledger.ts reads the raw estimates.jsonl / feedback.jsonl filenames directly", async () => {
    const { readdirSync, readFileSync: realReadFileSync } = await vi.importActual<typeof NodeFs>("node:fs");
    const { join: realJoin } = await vi.importActual<typeof NodePath>("node:path");
    const libDir = new URL(".", import.meta.url).pathname;

    // Metrics/calibration-math modules that must never read the raw ledger
    // filenames directly — they must go through readLines()/loadLedgerWithOverlays()
    // exported by ledger.ts. data-status.ts is intentionally excluded: it only
    // reports raw file existence/line counts for `epoch data status`, never
    // calibration math, so it is not a "reader" in the exclusion sense.
    const candidates = readdirSync(libDir)
      .filter((f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f: string) => f !== "ledger.ts" && f !== "data-status.ts");

    const offenders: string[] = [];
    for (const file of candidates) {
      const content = realReadFileSync(realJoin(libDir, file), "utf-8");
      if (content.includes('"estimates.jsonl"') || content.includes("'estimates.jsonl'")
        || content.includes('"feedback.jsonl"') || content.includes("'feedback.jsonl'")) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
