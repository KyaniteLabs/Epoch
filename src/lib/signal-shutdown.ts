// ---------------------------------------------------------------------------
// Signal-driven flush shutdown — shared by the MCP and CLI entries
// ---------------------------------------------------------------------------
// Node's default disposition for SIGTERM/SIGINT/SIGHUP terminates the process
// WITHOUT running 'exit' handlers, so TelemetryStore's module-level
// process.on("exit") flush never fires and every record still inside the
// 10 s buffer is lost. MCP hosts stop stdio servers with SIGTERM, which is
// how months of tool-call telemetry silently vanished in production
// (telemetry.jsonl stopped growing while estimates.jsonl kept receiving
// writes — the submitter reported "no new records" forever after).
//
// Installing this handler turns a termination signal into:
//   1. remove our own listeners (a second signal must meet the DEFAULT
//      disposition and kill the process — never be swallowed),
//   2. synchronously flush every buffered store (telemetry is the only
//      buffered store; the ledgers already write synchronously),
//   3. exit with the conventional 128+signal code.
//
// The HTTP entry is intentionally NOT routed through this module: it keeps
// its own graceful shutdown (server.close + flush + exit 0) and the CLI
// uninstalls this handler before handing `epoch serve` over to it.
// ----------------------------------------------------------------------------

import { constants as osConstants } from "node:os";

import { resetTelemetry } from "./telemetry.js";

/** Signals that trigger a flush-then-exit. */
export const FLUSH_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
export type FlushSignal = (typeof FLUSH_SIGNALS)[number];

/** Conventional shell exit codes: 128 + signal number. */
export const SIGNAL_EXIT_CODES: Record<FlushSignal, number> = {
  SIGTERM: 128 + osConstants.signals.SIGTERM,
  SIGINT: 128 + osConstants.signals.SIGINT,
  SIGHUP: 128 + osConstants.signals.SIGHUP,
};

/** Injectable seams so tests can drive the handler without real signals. */
export interface SignalFlushOptions {
  /** Synchronous flush of every buffered store. Default: resetTelemetry(). */
  flush?: () => void;
  /** Exit seam. Default: process.exit. */
  exit?: (code: number) => void;
}

let activeHandler: NodeJS.SignalsListener | null = null;

/**
 * Install the flush-then-exit handler for SIGTERM/SIGINT/SIGHUP.
 *
 * Idempotent: a second install in the same process is a no-op (returns the
 * already-installed handler), so entries that share a process cannot stack
 * duplicate listeners. Returns the installed listener so tests can assert
 * registration and removal.
 */
export function installSignalFlushShutdown(options: SignalFlushOptions = {}): NodeJS.SignalsListener {
  if (activeHandler) return activeHandler;

  const flush = options.flush ?? resetTelemetry;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const handler: NodeJS.SignalsListener = (signal) => {
    // 1. Drop our registrations FIRST: if a second signal lands while we are
    //    still flushing, it meets the default disposition (terminate) here
    //    instead of queuing another pass through this handler.
    uninstallSignalFlushShutdown();
    // 2. Best-effort synchronous flush. resetTelemetry() clears the flush
    //    interval and appends the buffer; a failed append keeps the batch
    //    buffered (Ticket 19 semantics) but the exit code below still holds.
    try {
      flush();
    } catch {
      // Flushing is best-effort on the shutdown path; the exit code still
      // reflects the signal that caused the shutdown.
    }
    // 3. Conventional exit code: 128 + signal number.
    exit(SIGNAL_EXIT_CODES[signal as FlushSignal] ?? 128);
  };

  activeHandler = handler;
  for (const signal of FLUSH_SIGNALS) process.on(signal, handler);
  return handler;
}

/**
 * Remove the handler installed by {@link installSignalFlushShutdown}.
 * No-op when nothing is installed. The `serve` CLI command calls this before
 * starting the HTTP entry, whose own SIGINT/SIGTERM shutdown (graceful close,
 * flush, exit 0) must not race an immediate 128+n exit.
 */
export function uninstallSignalFlushShutdown(): void {
  if (!activeHandler) return;
  for (const signal of FLUSH_SIGNALS) process.removeListener(signal, activeHandler);
  activeHandler = null;
}
