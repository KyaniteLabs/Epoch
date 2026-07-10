import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";
import {
  readLines,
  loadLedgerWithOverlays,
  appendOverlayRecord,
  ESTIMATES_FILE,
  ACTUALS_FILE,
  FLAGS_FILE,
  LABELS_FILE,
  QUARANTINE_ARCHIVE_FILE,
  type EstimateRecord,
} from "./ledger.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
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
