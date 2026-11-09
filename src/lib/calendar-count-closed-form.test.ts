// Differential + performance pins for the closed-form countBusinessDays.
// The reference below is the previous day-by-day walk, kept verbatim in
// spirit: every visited date is checked against its own year's holiday set.
import { describe, expect, it } from "vitest";
import { format, isWeekend, parseISO } from "date-fns";

import { countBusinessDays, holidayRegistry } from "./calendar.js";

function referenceWalk(start: string, end: string, country: string): number {
  const s = parseISO(start);
  const e = parseISO(end);
  const known = holidayRegistry.hasCountry(country);
  let n = 0;
  const cur = new Date(s);
  cur.setDate(cur.getDate() + 1);
  while (cur.getTime() <= e.getTime()) {
    const keys = known ? holidayRegistry.holidayDateKeys(country, cur.getFullYear()) : new Set<string>();
    if (!isWeekend(cur) && !keys.has(format(cur, "yyyy-MM-dd"))) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

/** Deterministic LCG so the sampled ranges are reproducible. */
function lcg(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

function isoFromDay(base: Date, offset: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return format(d, "yyyy-MM-dd");
}

describe("countBusinessDays closed form", () => {
  const countries = ["US", "UK", "GB", "FR", "DE", "JP", "BR"];

  it("matches the day-by-day walk on 400 random ranges across countries, DST and year boundaries", () => {
    const rand = lcg(20261109);
    const base = parseISO("2019-01-01");
    for (let i = 0; i < 400; i++) {
      const a = Math.floor(rand() * 4000);
      const len = Math.floor(rand() * 900) - 50; // includes empty/reversed ranges
      const start = isoFromDay(base, a);
      const end = isoFromDay(base, a + len);
      const country = countries[i % countries.length] ?? "US";
      const got = countBusinessDays(start, end, country);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.data.businessDays, `${country} ${start}..${end}`).toBe(referenceWalk(start, end, country));
    }
  });

  it("matches the walk across the observed-on-Dec-31 edge (2021-12-31, 2032-12-31)", () => {
    for (const [s, e] of [["2021-12-20", "2022-01-10"], ["2032-12-20", "2033-01-10"]] as const) {
      for (const c of ["US", "UK"]) {
        const got = countBusinessDays(s, e, c);
        expect(got.ok && got.data.businessDays).toBe(referenceWalk(s, e, c));
      }
    }
  });

  it("counts a 0001..9999 range without blocking the event loop for seconds", () => {
    const t0 = performance.now();
    const got = countBusinessDays("0001-01-01", "9999-12-31", "US");
    const ms = performance.now() - t0;
    expect(got.ok).toBe(true);
    // Was ~10 s with the per-day walk; closed form + per-year holiday sets.
    expect(ms).toBeLessThan(1500);
  });

  it("treats GB (ISO 3166) as the UK holiday calendar instead of weekends-only", () => {
    // 2026-12-25 (Fri) and 2026-12-28 (Mon, Boxing Day substitute) are UK bank holidays.
    const gb = countBusinessDays("2026-12-24", "2026-12-31", "GB");
    const uk = countBusinessDays("2026-12-24", "2026-12-31", "UK");
    expect(gb.ok && uk.ok).toBe(true);
    if (!gb.ok || !uk.ok) return;
    expect(gb.data.businessDays).toBe(uk.data.businessDays);
    expect(holidayRegistry.hasCountry("gb")).toBe(true);
  });
});
