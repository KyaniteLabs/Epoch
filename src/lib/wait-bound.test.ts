import { describe, it, expect } from "vitest";
import { waitBound } from "./wait-bound.js";

// wait-bound is pure (no telemetry, no data dir), but we keep the temp-dir
// isolation convention used by the other tool tests for determinism.

describe("waitBound — fleet clock (mechanism cycle math)", () => {
  it("derives the rollcall bound: 2 x 40s sweep + PERT(15/45/120) + 1 sd", () => {
    const r = waitBound({
      clockClass: "fleet",
      cycleSeconds: 40,
      cyclesK: 2,
      fromTimestamp: "2026-09-17T14:50:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // PERT minutes: expected (15 + 4*45 + 120)/6 = 52.5, sd (120-15)/6 = 17.5
    expect(r.data.turnPert?.expectedMinutes).toBeCloseTo(52.5, 5);
    expect(r.data.turnPert?.stdDeviationMinutes).toBeCloseTo(17.5, 5);
    // bound = 2*40 + (52.5 + 17.5)*60 = 80 + 4200 = 4280 s
    expect(r.data.boundSeconds).toBe(4280);
    expect(r.data.ttlHours).toBe(2); // ceil(4280/3600)
    expect(r.data.derivedDeadlineUtc).toBe("2026-09-17T16:01:20.000Z"); // 4280s = 71m20s
    expect(r.data.derivedDeadlineLocal).toContain("9:01"); // 16:01:20Z = 9:01 AM PDT
  });

  it("local rendering honors the PT default timezone", () => {
    const r = waitBound({
      clockClass: "fleet",
      fromTimestamp: "2026-09-17T14:50:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.timeZone).toBe("America/Los_Angeles");
    // 14:50Z + 4280s (71m20s) = 16:01:20Z = 9:01 AM PDT; expected string derived
    // via Intl from the same instant — never hardcoded (suite order can touch TZ state)
    const expectedLocal = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date("2026-09-17T16:01:20.000Z"));
    expect(r.data.derivedDeadlineLocal).toBe(expectedLocal);
  });

  it("rejects cycles_k > 5 (more cycles = broken mechanism, not generous deadline)", () => {
    const r = waitBound({ clockClass: "fleet", cyclesK: 7 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("1..5");
  });

  it("rejects non-positive cycle seconds", () => {
    const r = waitBound({ clockClass: "fleet", cycleSeconds: 0 });
    expect(r.ok).toBe(false);
  });
});

describe("waitBound — world clock (external 1:1)", () => {
  it("requires a named external anchor", () => {
    const r = waitBound({ clockClass: "world" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("external_anchor");
  });

  it("bounds on turn PERT only (no cycle math) with the anchor recorded", () => {
    const r = waitBound({
      clockClass: "world",
      externalAnchor: "Colosseum submission window closes Oct 12",
      fromTimestamp: "2026-09-17T14:50:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // bound = (52.5 + 17.5) * 60 = 4200 s
    expect(r.data.boundSeconds).toBe(4200);
    expect(r.data.externalAnchor).toContain("Colosseum");
    expect(r.data.ttlHours).toBe(2);
  });
});

describe("waitBound — ceo clock (the named ladder)", () => {
  it("burst rung: the rung IS the bound", () => {
    const r = waitBound({
      clockClass: "ceo",
      ceoRung: "burst",
      fromTimestamp: "2026-09-17T14:50:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rungHours).toBe(1);
    expect(r.data.boundSeconds).toBe(3600);
    expect(r.data.ttlHours).toBe(1);
    expect(r.data.derivedDeadlineUtc).toBe("2026-09-17T15:50:00.000Z");
    expect(r.data.lawNote).toContain("never consumes");
  });

  it("sleep rung = 24h", () => {
    const r = waitBound({ clockClass: "ceo", ceoRung: "sleep" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.boundSeconds).toBe(86400);
    expect(r.data.ttlHours).toBe(24);
  });

  it("requires a rung", () => {
    const r = waitBound({ clockClass: "ceo" });
    expect(r.ok).toBe(false);
  });
});

describe("waitBound — input hygiene", () => {
  it("rejects unparseable from_timestamp", () => {
    const r = waitBound({ clockClass: "fleet", fromTimestamp: "not-a-date" });
    expect(r.ok).toBe(false);
  });

  it("surfaces PERT ordering violations from the shared estimator", () => {
    const r = waitBound({
      clockClass: "fleet",
      turn: { optimistic: 60, mostLikely: 30, pessimistic: 10 },
    });
    expect(r.ok).toBe(false);
  });
});
