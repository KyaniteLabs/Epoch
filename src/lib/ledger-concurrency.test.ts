// ---------------------------------------------------------------------------
// Ticket 18 — Ledger write integrity: concurrency sandbox (S6)
// ---------------------------------------------------------------------------
//
// Real-filesystem + real-child-process coverage of the D3 concurrency model:
//   (a) N processes × record_actual for the SAME estimate → the advisory
//       write lock serializes the check-then-append region: exactly one
//       joined pair, everyone else rejected as duplicate, duplicateActuals 0.
//   (b) an append landing during a migration-style rewrite survives (tail
//       re-merge in rewriteJsonlWithTailMerge — the shared helper every
//       rewriting migration uses).
//   (c) a stale lockfile (dead PID + old mtime) is detected, surfaced in
//       data_status, and recovered automatically on the next locked write.
//   (d) write-failure propagation: EACCES fixture → recordEstimate null /
//       recordActualDetailed write_failed / dispatch() tool error with NO
//       feedbackRef.
//   (e) deterministic join: earliest-reportedAt wins (tie = earliest file
//       order) and duplicateActuals counts what the lock prevents.
//
// Children are spawned through the repo's tsx binary (devDependency) running a
// generated runner that imports the real src/lib modules — no mocks.
//
// Ticket: .scratch/epoch-remediation/issues/18-ledger-write-integrity.md
// Test spec: .omx/plans/test-spec-epoch-remediation.md (W3, seam S6)

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defined } from "../test-support.js";
import {
  acquireExclusiveFileLock,
  inspectLedgerWriteLock,
  ledgerWriteLockPath,
  loadLedgerWithOverlays,
  readLines,
  releaseExclusiveFileLock,
  resetLedgerReadCache,
  ACTUALS_FILE,
  ESTIMATES_FILE,
  type ActualRecord,
  type EstimateRecord,
} from "./ledger.js";
import { recordActualDetailed, recordEstimate, getFeedbackHealthReport } from "./feedback.js";
import { acquireQuiesceLock, releaseQuiesceLock, rewriteJsonlWithTailMerge } from "./migrations/shared.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const hasTsx = existsSync(TSX_BIN);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let TEST_DIR = "";
let previousDataDir: string | undefined;

function estimatesPath(): string {
  return join(TEST_DIR, ESTIMATES_FILE);
}
function actualsPath(): string {
  return join(TEST_DIR, ACTUALS_FILE);
}

function writeEstimate(id: string, estimatedAt = new Date().toISOString()): void {
  appendFileSync(
    estimatesPath(),
    JSON.stringify({
      id,
      tool: "pert_estimate",
      inputs: { task_type: "feature" },
      outputs: { expected: 5, unit: "hours" },
      estimatedAt,
    } satisfies EstimateRecord) + "\n",
    "utf-8",
  );
}

function appendActualRaw(estimateId: string, actualHours: number, reportedAt: string): void {
  appendFileSync(
    actualsPath(),
    JSON.stringify({ estimateId, actualHours, reportedAt } satisfies ActualRecord) + "\n",
    "utf-8",
  );
}

function readActualRows(): ActualRecord[] {
  try {
    return readFileSync(actualsPath(), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ActualRecord);
  } catch {
    return [];
  }
}

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  TEST_DIR = mkdtempSync(join(tmpdir(), "epoch-ledger-concurrency-"));
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  resetLedgerReadCache();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env["EPOCH_DATA_DIR"];
  else process.env["EPOCH_DATA_DIR"] = previousDataDir;
  delete process.env["EPOCH_LOCK_TIMEOUT_MS"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---- child-process plumbing ---------------------------------------------------

/** Generated runner executed by tsx children. Imports the REAL src/lib modules. */
function writeRunner(): string {
  const runnerPath = join(TEST_DIR, "child-runner.ts");
  const source = `
import { existsSync } from "node:fs";
import { recordActualDetailed } from ${JSON.stringify(join(REPO_ROOT, "src/lib/feedback.js"))};
import { acquireExclusiveFileLock, releaseExclusiveFileLock, ledgerWriteLockPath } from ${JSON.stringify(join(REPO_ROOT, "src/lib/ledger.js"))};

const mode = process.argv[2] ?? "";
const spin = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (mode === "actual") {
  console.log("RESULT " + JSON.stringify(recordActualDetailed(process.argv[3] ?? "est-race", Number(process.argv[4] ?? 5))));
} else if (mode === "barrier-actual") {
  const goPath = process.argv[3] ?? "";
  const estimateId = process.argv[4] ?? "est-race";
  while (!existsSync(goPath)) spin(5); // rendezvous: all children start the write simultaneously
  console.log("RESULT " + JSON.stringify(recordActualDetailed(estimateId, 5)));
} else if (mode === "hold-lock") {
  const filename = process.argv[3] ?? ${JSON.stringify(ACTUALS_FILE)};
  const holdMs = Number(process.argv[4] ?? 800);
  const acq = acquireExclusiveFileLock(ledgerWriteLockPath(filename), "child-holder", { timeoutMs: 0, retryMs: 5 });
  if (!acq.ok) { console.log("HELD-FAIL"); process.exit(1); }
  console.log("HELD");
  setTimeout(() => {
    releaseExclusiveFileLock(acq.lockPath, acq.token);
    console.log("RELEASED");
  }, holdMs);
}
`;
  writeFileSync(runnerPath, source, "utf-8");
  return runnerPath;
}

interface ChildOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Mutable collector so a caller can watch a child's stdout while it runs. */
interface StdoutTap {
  stdout: string;
}

function spawnChild(runnerPath: string, args: string[], tap?: StdoutTap, timeoutMs = 60_000): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [runnerPath, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, EPOCH_DATA_DIR: TEST_DIR },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (tap) tap.stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ---- (a) parallel record_actual — the lock serializes check-then-append -------

describe.skipIf(!hasTsx)("concurrency sandbox: parallel record_actual (S6)", () => {
  it(
    "6 processes race record_actual on the same estimate → exactly one joined pair, five duplicate rejections, duplicateActuals stays 0",
    async () => {
      const runner = writeRunner();
      writeEstimate("est-race");

      const goPath = join(TEST_DIR, "go");
      const children = Array.from({ length: 6 }, () => spawnChild(runner, ["barrier-actual", goPath, "est-race"]));
      // Give every child time to boot tsx and reach the barrier...
      await new Promise((r) => setTimeout(r, 2_500));
      writeFileSync(goPath, "", "utf-8"); // GO — all six hit the check-then-append region at once

      const outcomes = await Promise.all(children);
      const results = outcomes.map((o) => {
        expect(o.code).toBe(0);
        const line = defined(o.stdout.split("\n").find((l) => l.startsWith("RESULT ")), `child printed no RESULT: ${o.stderr}`);
        return JSON.parse(line.slice("RESULT ".length)) as { ok: boolean; reason?: string };
      });

      const succeeded = results.filter((r) => r.ok);
      const duplicates = results.filter((r) => !r.ok && r.reason === "duplicate");
      expect(succeeded).toHaveLength(1);
      expect(duplicates).toHaveLength(5);

      // Exactly one actual row on disk, exactly one joined pair, no duplicates counted.
      expect(readActualRows()).toHaveLength(1);
      const merged = loadLedgerWithOverlays();
      const joined = defined(merged.find((r) => r.id === "est-race"));
      expect(joined.actual?.actualHours).toBe(5);
      const health = getFeedbackHealthReport();
      expect(health.duplicateActuals).toBe(0);
      expect(health.matchedPairs).toBe(1);
      // The lock is released — no lockfile residue.
      expect(existsSync(ledgerWriteLockPath(ACTUALS_FILE))).toBe(false);
    },
    60_000,
  );

  it(
    "a locked write BLOCKS while another process holds the ledger lock, then proceeds (cross-process mutual exclusion)",
    async () => {
      const runner = writeRunner();
      writeEstimate("est-blocked");

      const tap: StdoutTap = { stdout: "" };
      const child = spawnChild(runner, ["hold-lock", ACTUALS_FILE, "800"], tap);
      // Wait until the child actually holds the lock (it prints HELD once acquired).
      const deadline = Date.now() + 20_000;
      while (!tap.stdout.includes("HELD")) {
        if (Date.now() > deadline) throw new Error(`child never held the lock (stdout: ${tap.stdout})`);
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(inspectLedgerWriteLock(ACTUALS_FILE).present).toBe(true);

      const started = Date.now();
      const result = recordActualDetailed("est-blocked", 5);
      const elapsed = Date.now() - started;

      // The parent had to wait for the child's 800ms hold (sanity margin 350ms)
      // and then succeeded — never wrote around the lock.
      expect(result).toEqual({ ok: true });
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(readActualRows()).toHaveLength(1);
      const outcome = await child; // child exits cleanly after releasing
      expect(outcome.stdout).toContain("RELEASED");
      expect(existsSync(ledgerWriteLockPath(ACTUALS_FILE))).toBe(false);
    },
    60_000,
  );

  it("negative control — the same interleave with the lock BYPASSED produces the duplicate rows duplicateActuals exists to count", () => {
    writeEstimate("est-race");
    // Both "processes" snapshot the actuals file before either appends (the
    // pre-ticket-18 write path shape): each check passes, both append.
    const snapshot = readLines<ActualRecord>(ACTUALS_FILE);
    const checkA = !snapshot.some((a) => a.estimateId === "est-race");
    const checkB = !snapshot.some((a) => a.estimateId === "est-race");
    expect(checkA).toBe(true);
    expect(checkB).toBe(true);
    appendActualRaw("est-race", 9, "2026-08-01T10:00:00.000Z"); // later-reported, written FIRST
    appendActualRaw("est-race", 5, "2026-08-01T09:00:00.000Z"); // earlier-reported, written SECOND

    const rows = readActualRows();
    expect(rows).toHaveLength(2);
    const health = getFeedbackHealthReport();
    expect(health.duplicateActuals).toBe(1);

    // Deterministic join despite the duplicates: earliest-reportedAt wins —
    // NOT last-write-wins (which would pick the 9h row).
    const merged = loadLedgerWithOverlays();
    expect(defined(merged.find((r) => r.id === "est-race")).actual?.actualHours).toBe(5);
  });
});

// ---- (b) migration-style rewrite: appended row survives (tail re-merge) -------

describe("concurrency sandbox: migration tail re-merge (S6)", () => {
  it("a row appended between the rewrite's initial read and its rename survives verbatim", () => {
    writeEstimate("est-orphan");
    writeEstimate("est-concurrent");
    appendActualRaw("orphan-ghost", 4, "2026-08-01T10:00:00.000Z");
    const concurrentAppend = JSON.stringify({ estimateId: "est-concurrent", actualHours: 3, reportedAt: "2026-08-01T10:05:00.000Z" }) + "\n";

    const result = rewriteJsonlWithTailMerge(ACTUALS_FILE, (rawLines) => {
      // Simulate the live MCP server appending DURING the migration's
      // rewrite window (after its initial read, before its rename).
      appendFileSync(actualsPath(), concurrentAppend, "utf-8");
      // The migration's own transform: relink the orphan row.
      return rawLines.map((line) => line.replace('"orphan-ghost"', '"est-orphan"'));
    });

    expect(result.tailMerged).toBe(1);

    const rows = readActualRows();
    expect(rows.map((r) => r.estimateId).sort()).toEqual(["est-concurrent", "est-orphan"]);
    // The relink landed and the concurrently-appended row survived with its
    // bytes intact.
    expect(defined(rows.find((r) => r.estimateId === "est-concurrent")).actualHours).toBe(3);
    // No temp-file residue from the atomic rename path.
    expect(readdirSync(TEST_DIR).filter((f) => f.includes(".tmp-"))).toEqual([]);
    // The join sees both pairs.
    const merged = loadLedgerWithOverlays();
    expect(defined(merged.find((r) => r.id === "est-orphan")).actual?.actualHours).toBe(4);
    expect(defined(merged.find((r) => r.id === "est-concurrent")).actual?.actualHours).toBe(3);
  });

  it("shrinking mid-rewrite fails loudly instead of losing data", () => {
    writeEstimate("est-shrink");
    appendActualRaw("a-1", 1, "2026-08-01T10:00:00.000Z");
    expect(() =>
      rewriteJsonlWithTailMerge(ACTUALS_FILE, (rawLines) => {
        rmSync(actualsPath()); // an unexpected concurrent rewrite shrank the file
        return rawLines;
      }),
    ).toThrow(/shrank/);
  });
});

// ---- (c) stale lock: detected, surfaced, recovered ------------------------------

describe("concurrency sandbox: stale lock detection + recovery (S6)", () => {
  /** A PID that cannot be alive on any supported platform (pid_t max). */
  const DEAD_PID = 2_147_483_000;

  function plantStaleLock(filename: string): void {
    const lockPath = ledgerWriteLockPath(filename);
    const old = new Date(Date.now() - 120_000);
    writeFileSync(lockPath, JSON.stringify({ owner: "crashed-process", pid: DEAD_PID, acquiredAt: old.toISOString(), token: "dead-token" }) + "\n", "utf-8");
    utimesSync(lockPath, old, old);
  }

  it("a stale lockfile (dead PID, old mtime) is surfaced as stale in data_status with the removal path documented", async () => {
    plantStaleLock(ACTUALS_FILE);
    const { getEpochDataStatus } = await import("./data-status.js");
    const status = getEpochDataStatus();
    expect(status.writeLocks.actuals.present).toBe(true);
    expect(status.writeLocks.actuals.stale).toBe(true);
    expect(status.writeLocks.actuals.pid).toBe(DEAD_PID);
    expect(status.writeLocks.actuals.recovery).toContain("Stale write lock");
    expect(status.writeLocks.actuals.recovery).toContain(ledgerWriteLockPath(ACTUALS_FILE));
  });

  it("the next locked write auto-recovers the stale lock, and the recovery is counted and surfaced", async () => {
    writeEstimate("est-stale");
    plantStaleLock(ACTUALS_FILE);

    const result = recordActualDetailed("est-stale", 5);
    expect(result).toEqual({ ok: true });
    // The stale lock was replaced by ours and released afterwards.
    expect(existsSync(ledgerWriteLockPath(ACTUALS_FILE))).toBe(false);
    expect(readActualRows()).toHaveLength(1);

    const { getEpochDataStatus } = await import("./data-status.js");
    const status = getEpochDataStatus();
    expect(status.writeLocks.staleRecoveries).toBeGreaterThanOrEqual(1);
  });

  it("a LIVE holder is never stolen — the write fails as write_failed once the contention timeout lapses", () => {
    writeEstimate("est-live");
    const lockPath = ledgerWriteLockPath(ACTUALS_FILE);
    writeFileSync(lockPath, JSON.stringify({ owner: "live-holder", pid: process.pid, acquiredAt: new Date().toISOString(), token: "live-token" }) + "\n", "utf-8");

    process.env["EPOCH_LOCK_TIMEOUT_MS"] = "150";
    const result = recordActualDetailed("est-live", 5);
    expect(result).toMatchObject({ ok: false, reason: "write_failed" });
    expect((result as { hint?: string }).hint ?? "").toContain("write lock");
    // Nothing was written around the live lock, and the lock survives untouched.
    expect(readActualRows()).toHaveLength(0);
    expect(readFileSync(lockPath, "utf-8")).toContain('"live-token"');

    // data_status surfaces a fresh live lock as present-but-not-stale.
    const info = inspectLedgerWriteLock(ACTUALS_FILE);
    expect(info.present).toBe(true);
    expect(info.stale).toBe(false);
  });

  it("a LIVE holder is never stolen on AGE alone — an old lockfile with a live PID fails held, not stolen (review H3)", () => {
    const lockPath = ledgerWriteLockPath(ACTUALS_FILE);
    const old = new Date(Date.now() - 300_000);
    writeFileSync(lockPath, JSON.stringify({ owner: "slow-live-holder", pid: process.pid, acquiredAt: old.toISOString(), token: "slow-live-token" }) + "\n", "utf-8");
    utimesSync(lockPath, old, old);

    // Surfaced present and NOT stale despite the age — a slow batch keeps
    // mutual exclusion while it runs.
    const info = inspectLedgerWriteLock(ACTUALS_FILE);
    expect(info.present).toBe(true);
    expect(info.stale).toBe(false);

    // Single-attempt acquisition refuses to steal: held, lock untouched.
    const acq = acquireExclusiveFileLock(lockPath, "would-be-stealer", { timeoutMs: 0, retryMs: 1 });
    expect(acq.ok).toBe(false);
    expect(acq.reason).toBe("held");
    expect(readFileSync(lockPath, "utf-8")).toContain("slow-live-token");
    rmSync(lockPath);
  });

  it("a pid-less legacy lock older than the stale window is still stolen by age (recovery path preserved)", () => {
    const lockPath = ledgerWriteLockPath(ACTUALS_FILE);
    const old = new Date(Date.now() - 300_000);
    writeFileSync(lockPath, JSON.stringify({ owner: "legacy", acquiredAt: old.toISOString() }) + "\n", "utf-8");
    utimesSync(lockPath, old, old);
    const acq = acquireExclusiveFileLock(lockPath, "recoverer", { timeoutMs: 0, retryMs: 1 });
    expect(acq.ok).toBe(true);
    expect(acq.recoveredStale).toBe(true);
    releaseExclusiveFileLock(lockPath, acq.token);
  });

  it("release is token-matched: a slow releaser cannot delete a newer owner's lock", () => {
    const lockPath = ledgerWriteLockPath(ACTUALS_FILE);
    // Acquire and keep the token.
    const first = acquireExclusiveFileLock(lockPath, "slow-holder", { timeoutMs: 0, retryMs: 1 });
    expect(first.ok).toBe(true);
    // Simulate a staleness steal by a second acquisition after removing the file
    // directly (crash + recovery): the new owner writes its own token.
    rmSync(lockPath);
    const second = acquireExclusiveFileLock(lockPath, "new-owner", { timeoutMs: 0, retryMs: 1 });
    expect(second.ok).toBe(true);
    // The slow first holder releases — must NOT remove the new owner's lock.
    releaseExclusiveFileLock(lockPath, first.token);
    expect(existsSync(lockPath)).toBe(true);
    releaseExclusiveFileLock(lockPath, second.token);
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---- migration quiesce lock (wx + staleness) ------------------------------------

describe("concurrency sandbox: migration quiesce lock", () => {
  it("a live quiesce lock still refuses a second migration (no interleaved rewrites)", () => {
    expect(acquireQuiesceLock("test-migration")).toBeTruthy();
    expect(() => acquireQuiesceLock("second-migration")).toThrow(/Quiesce lock already held/);
    releaseQuiesceLock();
    // After release the lock is acquirable again.
    expect(acquireQuiesceLock("third-migration")).toBeTruthy();
    releaseQuiesceLock();
  });

  it("a stale quiesce lock (crashed migration) is stolen automatically", () => {
    const lockPath = join(TEST_DIR, ".epoch-migration.lock");
    const old = new Date(Date.now() - 300_000);
    writeFileSync(lockPath, JSON.stringify({ owner: "crashed-migration", pid: 2_147_483_000, acquiredAt: old.toISOString(), token: "x" }) + "\n", "utf-8");
    utimesSync(lockPath, old, old);
    expect(acquireQuiesceLock("recovery-migration")).toBeTruthy();
    releaseQuiesceLock();
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---- (d) write-failure propagation (EACCES fixture) -------------------------------

describe.skipIf(isRoot)("concurrency sandbox: write-failure propagation (S6)", () => {
  it("EACCES on the data dir → recordEstimate null, recordActualDetailed write_failed, no file created", () => {
    chmodSync(TEST_DIR, 0o555); // read-only data dir
    try {
      expect(recordEstimate("pert_estimate", { optimistic: 1 }, { expected: 5 })).toBeNull();
      expect(recordActualDetailed("est-missing", 5)).toMatchObject({ ok: false, reason: "write_failed" });
      expect(existsSync(estimatesPath())).toBe(false);
      expect(existsSync(actualsPath())).toBe(false);
    } finally {
      chmodSync(TEST_DIR, 0o755);
    }
  });

  it("dispatch(): EACCES → tool error mentioning the write failure, NO feedbackRef in any response shape", async () => {
    const { dispatch } = await import("../dispatcher/index.js");
    chmodSync(TEST_DIR, 0o555); // read-only data dir
    try {
      const result = await dispatch("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 3 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to write");
        expect(result.error.message).toContain("NOT recorded");
      }
      // The failure envelope carries no data payload at all — no feedbackRef
      // field is ever issued for a record that never persisted.
      expect((result as { data?: unknown }).data).toBeUndefined();
      expect(existsSync(estimatesPath())).toBe(false);
    } finally {
      chmodSync(TEST_DIR, 0o755);
    }
  });
});

// ---- (e) deterministic join unit coverage (in-process) ------------------------------

describe("deterministic join: earliest-reportedAt wins, tie = earliest file order", () => {
  it("picks the earliest reportedAt regardless of file order", () => {
    writeEstimate("est-join");
    appendActualRaw("est-join", 9, "2026-08-02T10:00:00.000Z"); // LATER reported, FIRST in file
    appendActualRaw("est-join", 5, "2026-08-01T09:00:00.000Z"); // EARLIER reported, SECOND in file
    const merged = loadLedgerWithOverlays();
    expect(defined(merged.find((r) => r.id === "est-join")).actual?.actualHours).toBe(5);
    expect(getFeedbackHealthReport().duplicateActuals).toBe(1);
  });

  it("on equal reportedAt, the first row in file order wins (deterministic)", () => {
    writeEstimate("est-tie");
    appendActualRaw("est-tie", 7, "2026-08-01T09:00:00.000Z");
    appendActualRaw("est-tie", 8, "2026-08-01T09:00:00.000Z");
    const merged = loadLedgerWithOverlays();
    expect(defined(merged.find((r) => r.id === "est-tie")).actual?.actualHours).toBe(7);
  });

  it("identical inputs produce identical outputs across repeated loads (join is deterministic)", () => {
    writeEstimate("est-det");
    appendActualRaw("est-det", 9, "2026-08-02T10:00:00.000Z");
    appendActualRaw("est-det", 5, "2026-08-01T09:00:00.000Z");
    const first = loadLedgerWithOverlays();
    const second = loadLedgerWithOverlays();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("a torn last line is skipped (unchanged semantics) but counted in the health report", () => {
    writeEstimate("est-torn");
    appendActualRaw("est-torn", 5, "2026-08-01T09:00:00.000Z");
    appendFileSync(actualsPath(), '{"estimateId":"est-torn","actualHo', "utf-8"); // torn write

    const health = getFeedbackHealthReport();
    expect(health.corruptLines).toBe(1);
    expect(health.totalActuals).toBe(1); // torn row skipped, not joined
    expect(health.matchedPairs).toBe(1);
  });
});
