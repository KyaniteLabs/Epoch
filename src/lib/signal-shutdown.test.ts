// ---------------------------------------------------------------------------
// signal-shutdown.ts — unit tests
// ---------------------------------------------------------------------------
// Drives the installed listener directly (no real signals — emitting those
// in-process would hit vitest's own handlers). Pins:
//   - the 128+signal exit code for every handled signal,
//   - flush-then-exit ordering,
//   - the no-swallow contract: all three registrations are dropped BEFORE
//     the flush runs, so a second signal meets the default disposition,
//   - idempotent install and best-effort exit when the flush throws.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FLUSH_SIGNALS,
  SIGNAL_EXIT_CODES,
  installSignalFlushShutdown,
  uninstallSignalFlushShutdown,
} from "./signal-shutdown.js";

afterEach(() => {
  uninstallSignalFlushShutdown();
});

describe("SIGNAL_EXIT_CODES", () => {
  it("maps every flush signal to the conventional 128+n code", () => {
    expect(SIGNAL_EXIT_CODES.SIGTERM).toBe(143); // 128 + 15
    expect(SIGNAL_EXIT_CODES.SIGINT).toBe(130); // 128 + 2
    expect(SIGNAL_EXIT_CODES.SIGHUP).toBe(129); // 128 + 1
  });
});

describe("installSignalFlushShutdown", () => {
  it("registers exactly one listener on each flush signal", () => {
    const before = FLUSH_SIGNALS.map((s) => process.listeners(s).length);
    const handler = installSignalFlushShutdown({ flush: vi.fn(), exit: vi.fn() });
    const after = FLUSH_SIGNALS.map((s) => process.listeners(s).length);

    expect(after).toEqual(before.map((n) => n + 1));
    for (const signal of FLUSH_SIGNALS) {
      expect(process.listeners(signal)).toContain(handler);
    }
  });

  it("is idempotent — a second install does not stack listeners", () => {
    const first = installSignalFlushShutdown({ flush: vi.fn(), exit: vi.fn() });
    const before = FLUSH_SIGNALS.map((s) => process.listeners(s).length);
    const second = installSignalFlushShutdown({ flush: vi.fn(), exit: vi.fn() });
    const after = FLUSH_SIGNALS.map((s) => process.listeners(s).length);

    expect(second).toBe(first);
    expect(after).toEqual(before);
  });

  it("flushes, then exits with 128+signal (SIGTERM -> 143)", () => {
    const order: string[] = [];
    const flush = vi.fn(() => order.push("flush"));
    const exit = vi.fn((_code: number) => order.push("exit"));

    installSignalFlushShutdown({ flush, exit })("SIGTERM");

    expect(order).toEqual(["flush", "exit"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("exits 130 on SIGINT and 129 on SIGHUP", () => {
    const exits: number[] = [];
    const exit = vi.fn((code: number) => exits.push(code));
    const handler = installSignalFlushShutdown({ flush: vi.fn(), exit });

    handler("SIGINT");
    handler("SIGHUP");

    expect(exits).toEqual([130, 129]);
  });

  it("drops every registration BEFORE flushing — a second signal is never swallowed", () => {
    const handlerRef = { current: null as NodeJS.SignalsListener | null };
    const flush = vi.fn(() => {
      // A second signal could land while this flush runs. By then our
      // listeners must already be gone, so the default disposition
      // (terminate) applies instead of another pass through the handler.
      for (const signal of FLUSH_SIGNALS) {
        expect(process.listeners(signal)).not.toContain(handlerRef.current);
      }
    });
    const exit = vi.fn();

    handlerRef.current = installSignalFlushShutdown({ flush, exit });

    handlerRef.current("SIGINT");

    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
    // And the handler is not re-entrant through process after completion.
    expect(process.listeners("SIGTERM")).not.toContain(handlerRef.current);
    expect(process.listeners("SIGINT")).not.toContain(handlerRef.current);
    expect(process.listeners("SIGHUP")).not.toContain(handlerRef.current);
  });

  it("still exits with the signal code when the flush itself throws", () => {
    const flush = vi.fn(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const exit = vi.fn();

    installSignalFlushShutdown({ flush, exit })("SIGTERM");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("uninstall removes the handler without touching other listeners", () => {
    const otherListener = () => {};
    process.on("SIGHUP", otherListener);
    try {
      const handler = installSignalFlushShutdown({ flush: vi.fn(), exit: vi.fn() });
      uninstallSignalFlushShutdown();

      expect(process.listeners("SIGTERM")).not.toContain(handler);
      expect(process.listeners("SIGINT")).not.toContain(handler);
      expect(process.listeners("SIGHUP")).not.toContain(handler);
      // Bystander listener installed by someone else survives.
      expect(process.listeners("SIGHUP")).toContain(otherListener);
    } finally {
      process.removeListener("SIGHUP", otherListener);
    }
  });
});
