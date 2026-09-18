import type { ToolResult, WaitBoundResult } from "../types/index.js";

/**
 * wait-bound — derive a deadline from the mechanism the wait actually rides
 * (three-clock law, Kyanite org v1.1 A2, CEO order 2026-09-17: "why do we need
 * 22 hours for a roll call?"). Round human hours are unexamined slack; a bound
 * is cycle math + one turn, with a PERT spread on the turn.
 *
 * Clock classes:
 *  - fleet: agent-only waits. bound = k x cycle_seconds + PERT(turn) + 1 sd margin.
 *  - world: external 1:1 waits. Requires a named external anchor; bound = PERT(turn).
 *  - ceo:   the named ladder (pass/burst/sleep/cycle/season). Machine time never
 *           consumes a CEO rung — the rung IS the bound.
 */

export const CEO_RUNG_HOURS: Record<string, number> = {
  pass: 0.25,
  burst: 1,
  sleep: 24,
  cycle: 168,
  season: 730,
};

export interface WaitBoundTurnInput {
  optimistic: number;
  mostLikely: number;
  pessimistic: number;
}

export interface WaitBoundInput {
  clockClass: "fleet" | "world" | "ceo";
  cycleSeconds?: number;
  cyclesK?: number;
  turn?: WaitBoundTurnInput;
  externalAnchor?: string;
  ceoRung?: "pass" | "burst" | "sleep" | "cycle" | "season";
  fromTimestamp?: string;
  timeZone?: string;
}

// Default turn PERT (minutes): desk-wake latency + one answering turn,
// including busy/turn-driven seats. 15/45/120 reflects: immediate desk ~15m,
// typical sweep-woken desk ~45m, busy seat whose current turn must finish ~120m.
export const DEFAULT_TURN: WaitBoundTurnInput = {
  optimistic: 15,
  mostLikely: 45,
  pessimistic: 120,
};

function renderInstant(epochMs: number, timeZone: string): string {
  // WT-safe rendering; timeZone defaults to PT per the org display law
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString();
  }
}

export function waitBound(input: WaitBoundInput): ToolResult<WaitBoundResult> {
  const from =
    input.fromTimestamp !== undefined && input.fromTimestamp !== ""
      ? Date.parse(input.fromTimestamp)
      : Date.now();
  if (!Number.isFinite(from)) {
    return {
      ok: false,
      error: {
        isError: true,
        message: `from_timestamp is not a parseable ISO timestamp: ${input.fromTimestamp ?? ""}`,
        retryHint: "Pass an ISO 8601 string, e.g. 2026-09-17T14:50:00Z, or omit it for now.",
      },
    };
  }
  const timeZone = input.timeZone ?? "America/Los_Angeles";
  const turn = input.turn ?? DEFAULT_TURN;

  if (input.clockClass === "ceo") {
    const rung = input.ceoRung;
    if (rung === undefined || !(rung in CEO_RUNG_HOURS)) {
      return {
        ok: false,
        error: {
          isError: true,
          message: "clock_class 'ceo' requires ceo_rung (pass | burst | sleep | cycle | season).",
          retryHint: "CEO-time waits are ladder rungs, not machine math — name the rung.",
        },
      };
    }
    const rungHours = CEO_RUNG_HOURS[rung] ?? 0;
    const deadlineMs = from + rungHours * 3_600_000;
    return {
      ok: true,
      data: {
        clockClass: "ceo",
        ceoRung: rung,
        rungHours,
        boundSeconds: rungHours * 3600,
        derivedDeadlineUtc: new Date(deadlineMs).toISOString(),
        derivedDeadlineLocal: renderInstant(deadlineMs, timeZone),
        timeZone,
        ttlHours: Math.max(1, Math.ceil(rungHours)),
        lawNote:
          "CEO-time: the rung is the bound. Machine time never consumes a CEO rung (hybrid rule: fleet-time to the CEO queue, then the ladder).",
      },
    };
  }

  if (input.clockClass === "world" && (input.externalAnchor === undefined || input.externalAnchor.trim() === "")) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "clock_class 'world' requires external_anchor naming the 1:1 external event.",
        retryHint: "World-time TTLs cite their external anchor in the envelope body (three-clock law).",
      },
    };
  }

  const cycleSeconds = input.clockClass === "fleet" ? (input.cycleSeconds ?? 40) : 0;
  const cyclesK = input.cyclesK ?? 2;
  if (input.clockClass === "fleet" && (!(cycleSeconds > 0) || !Number.isInteger(cyclesK) || cyclesK < 1 || cyclesK > 5)) {
    return {
      ok: false,
      error: {
        isError: true,
        message: `fleet bounds need cycle_seconds > 0 and integer cycles_k in 1..5; got cycle=${String(cycleSeconds)}s k=${String(cyclesK)}.`,
        retryHint: "k <= 5 by law: more cycles means the mechanism is broken, not the deadline generous.",
      },
    };
  }

  // PERT in the minutes domain (same formula as estimation.ts pertEstimate,
  // which is hours-based — converting through hours rounds at the wrong scale)
  if (!(turn.optimistic > 0 && turn.optimistic <= turn.mostLikely && turn.mostLikely <= turn.pessimistic)) {
    return {
      ok: false,
      error: {
        isError: true,
        message: `Turn PERT must satisfy 0 < optimistic <= most_likely <= pessimistic. Got ${String(turn.optimistic)}/${String(turn.mostLikely)}/${String(turn.pessimistic)} minutes.`,
        retryHint: "Three positive minute values, optimistic smallest, pessimistic largest.",
      },
    };
  }
  const expectedTurnMinutes = (turn.optimistic + 4 * turn.mostLikely + turn.pessimistic) / 6;
  const sdTurnMinutes = (turn.pessimistic - turn.optimistic) / 6;
  const expectedTurnSeconds = expectedTurnMinutes * 60;
  const sdTurnSeconds = sdTurnMinutes * 60;
  const boundSeconds = Math.round(cycleSeconds * cyclesK + expectedTurnSeconds + sdTurnSeconds);
  const deadlineMs = from + boundSeconds * 1000;

  return {
    ok: true,
    data: {
      clockClass: input.clockClass,
      cycleSeconds: cycleSeconds > 0 ? cycleSeconds : undefined,
      cyclesK: input.clockClass === "fleet" ? cyclesK : undefined,
      externalAnchor: input.externalAnchor,
      turnPert: {
        optimisticMinutes: turn.optimistic,
        mostLikelyMinutes: turn.mostLikely,
        pessimisticMinutes: turn.pessimistic,
        expectedMinutes: Math.round(expectedTurnMinutes * 100) / 100,
        stdDeviationMinutes: Math.round(sdTurnMinutes * 100) / 100,
      },
      boundSeconds,
      derivedDeadlineUtc: new Date(deadlineMs).toISOString(),
      derivedDeadlineLocal: renderInstant(deadlineMs, timeZone),
      timeZone,
      ttlHours: Math.max(1, Math.ceil(boundSeconds / 3600)),
      lawNote:
        input.clockClass === "fleet"
          ? "Fleet-time bound = k x cycle + PERT(turn) + 1 sd. Round hours are unexamined slack."
          : "World-time: bound rides the external anchor; TTL must cite it in the envelope.",
    },
  };
}
