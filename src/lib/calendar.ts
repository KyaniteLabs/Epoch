// ---------------------------------------------------------------------------
// Epoch MCP Server — Layer 2: Calendar Math Utilities
// Business-day calculations with holiday awareness.
// Pure functions with no MCP dependencies. All errors returned, never thrown.
//
// Holiday-rule revision stamp: CALENDAR_VERSION (surfaced on every result).
// Rules: US observed days (Sat -> preceding Fri, Sun -> following Monday for
// fixed-date federal holidays; Good Friday excluded), UK substitute days
// (weekend bank holidays -> next available weekday), JP per-year official
// equinox table 2024-2030 (NAOJ) + Sunday substitute days, memoized per
// (country, year).
// ---------------------------------------------------------------------------

import {
  parseISO,
  format,
  isWeekend,
  getDay,
  getHours,
} from "date-fns";
import { toZonedTime } from "date-fns-tz";
import type {
  BusinessDayResult,
  SupportedCountry,
  ToolResult,
  ToolError,
} from "../types/index.js";
import { makeError } from "./internal/error-helpers.js";

// ---- Error helper ---------------------------------------------------------

function parseDate(dateStr: string): Date | ToolError {
  const parsed = parseISO(dateStr);
  if (isNaN(parsed.getTime())) {
    return makeError(
      `Invalid date: "${dateStr}". Use ISO-8601 format like "2026-05-01".`,
      "Provide a valid ISO-8601 date string.",
    );
  }
  return parsed;
}

// ---- Holiday Registry -----------------------------------------------------

type HolidayFn = (year: number) => readonly Date[];

/**
 * Computes the date of Easter Sunday for a given year using the
 * anonymous Gregorian algorithm (Meeus/Jones/Butcher).
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): Date {
  const first = new Date(year, month, 1);
  const firstDay = getDay(first);
  const offset = (weekday - firstDay + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

function lastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  const last = new Date(year, month, lastDay);
  const lastDayOfWeek = getDay(last);
  const diff = (lastDayOfWeek - weekday + 7) % 7;
  return new Date(year, month, lastDay - diff);
}

// -- JP equinox dates --------------------------------------------------------
//
// Shunbun no Hi (Vernal Equinox) and Shubun no Hi (Autumnal Equinox) are set
// to the astronomical equinox INSTANTS expressed in JST, which the National
// Astronomical Observatory of Japan publishes each February for the following
// year. They drift between two calendar dates and cannot be captured by a
// fixed ternary. This table carries the official published dates 2024-2030
// (verified against NAOJ, https://www.nao.ac.jp/faq/a0301.html); years
// outside the table fall back to the Meeus astronomical computation below,
// which reproduces every table entry exactly (regression-tested).

/** Official Shunbun (March) / Shubun (September) equinox dates, month/day, JST. */
const JP_EQUINOX_TABLE: Readonly<Record<number, { readonly shunbun: readonly [number, number]; readonly shubun: readonly [number, number] }>> = {
  2024: { shunbun: [2, 20], shubun: [8, 22] },
  2025: { shunbun: [2, 20], shubun: [8, 23] },
  2026: { shunbun: [2, 20], shubun: [8, 23] },
  2027: { shunbun: [2, 21], shubun: [8, 23] },
  2028: { shunbun: [2, 20], shubun: [8, 22] },
  2029: { shunbun: [2, 20], shubun: [8, 23] },
  2030: { shunbun: [2, 20], shubun: [8, 23] },
};

const DEG = Math.PI / 180;

/** ΔT (TT - UT1) in seconds for 2005-2050 (Espenak/Meeus polynomial approximation). */
function deltaTSeconds(year: number): number {
  const t = year - 2000;
  return 62.92 + 0.32217 * t + 0.005589 * t * t;
}

/** Gregorian date from a Julian day (fractional; day starts at midnight). */
function jdToGregorian(jd: number): { year: number; month: number; day: number } {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = Math.floor(b - d - Math.floor(30.6001 * e) + f);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  return { year, month, day };
}

/**
 * Astronomical equinox dates in JST (Meeus, "Astronomical Algorithms" ch. 27,
 * with periodic corrections and the ΔT model above). Reproduces every entry of
 * JP_EQUINOX_TABLE exactly for 2024-2030, so it is used only for years beyond
 * the officially-verified table.
 */
export function astronomicalJpEquinoxDates(year: number): { shunbun: Date; shubun: Date } {
  const equinoxJstJd = (which: "march" | "september"): number => {
    const y = (year - 2000) / 1000;
    const jde0 = which === "march"
      ? 2451623.80984 + 365242.37404 * y + 0.05169 * y * y - 0.00411 * y ** 3 - 0.00057 * y ** 4
      : 2451810.21715 + 365242.01767 * y - 0.11575 * y * y + 0.00337 * y ** 3 + 0.00078 * y ** 4;
    const t = (jde0 - 2451545.0) / 36525;
    const w = 35999.373 * t - 2.47;
    const deltaLambda = 1 + 0.0334 * Math.cos(w * DEG) + 0.0007 * Math.cos(2 * w * DEG);
    // Meeus table 27.C periodic terms.
    const terms: ReadonlyArray<readonly [number, number, number]> = [
      [485, 324.96, 1934.136], [203, 337.23, 32964.467], [199, 342.08, 20.186],
      [182, 27.85, 445267.112], [156, 73.14, 45036.886], [136, 171.52, 22518.443],
      [77, 222.54, 65928.934], [74, 296.72, 3034.906], [70, 243.58, 9037.513],
      [58, 119.81, 33718.147], [52, 297.17, 150.678], [50, 21.02, 2281.226],
      [45, 247.54, 29929.562], [44, 325.15, 31555.956], [29, 60.93, 4443.417],
      [18, 155.12, 67555.328], [17, 288.79, 4562.452], [16, 198.04, 62894.029],
      [14, 199.76, 31436.921], [12, 95.39, 14577.848], [12, 287.11, 31931.756],
      [12, 320.81, 34777.259], [9, 227.73, 1222.114], [8, 15.45, 16859.074],
    ];
    let s = 0;
    for (const [amp, phase, freq] of terms) {
      s += amp * Math.cos((phase + freq * t) * DEG);
    }
    const jde = jde0 + (0.00001 * s) / deltaLambda; // dynamical time (TT)
    const jdUt = jde - deltaTSeconds(year) / 86400;
    return jdUt + 9 / 24; // JST = UT + 9h
  };
  const toDate = (jd: number): Date => {
    const { year: y, month, day } = jdToGregorian(jd);
    return new Date(y, month - 1, day);
  };
  return { shunbun: toDate(equinoxJstJd("march")), shubun: toDate(equinoxJstJd("september")) };
}

/** Official (table) JP equinox dates for 2024-2030; astronomical beyond the table. */
function jpEquinoxDates(year: number): { shunbun: Date; shubun: Date } {
  const table = JP_EQUINOX_TABLE[year];
  if (table) {
    return {
      shunbun: new Date(year, table.shunbun[0], table.shunbun[1]),
      shubun: new Date(year, table.shubun[0], table.shubun[1]),
    };
  }
  return astronomicalJpEquinoxDates(year);
}

// -- US holidays (federal) --------------------------------------------------

// Fixed-date federal holidays (5 U.S.C. 6103): when one falls on Saturday it
// is observed the preceding Friday; on Sunday, the following Monday.
const US_FIXED_DATE_HOLIDAYS: ReadonlyArray<readonly [month: number, day: number]> = [
  [0, 1],   // New Year's Day
  [5, 19],  // Juneteenth
  [6, 4],   // Independence Day
  [10, 11], // Veterans Day
  [11, 25], // Christmas Day
];

function usHolidays(year: number): readonly Date[] {
  // Good Friday deliberately excluded: it is NOT a U.S. federal holiday. It
  // was previously listed here (making random Spring Fridays non-business
  // days); removed in the 2026-08 calendar-truth fix — see CHANGELOG.
  const holidays: Date[] = [
    ...US_FIXED_DATE_HOLIDAYS.map(([m, d]) => new Date(year, m, d)),
    nthWeekdayOfMonth(year, 0, 1, 3),                       // MLK Day (3rd Mon Jan)
    nthWeekdayOfMonth(year, 1, 1, 3),                       // Presidents' Day (3rd Mon Feb)
    lastWeekdayOfMonth(year, 4, 1),                         // Memorial Day (last Mon May)
    nthWeekdayOfMonth(year, 8, 1, 1),                       // Labor Day (1st Mon Sep)
    nthWeekdayOfMonth(year, 9, 1, 2),                       // Columbus Day (2nd Mon Oct)
    nthWeekdayOfMonth(year, 10, 3, 4),                      // Thanksgiving (4th Thu Nov)
  ].map(normaliseHolidayDate);

  for (const [month, day] of US_FIXED_DATE_HOLIDAYS) {
    const date = new Date(year, month, day);
    const dow = getDay(date);
    if (dow === 6) {
      holidays.push(normaliseHolidayDate(new Date(year, month, day - 1))); // Sat -> preceding Fri
    } else if (dow === 0) {
      holidays.push(normaliseHolidayDate(new Date(year, month, day + 1))); // Sun -> following Mon
    }
  }
  // Cross-year observed day: when Jan 1 of the NEXT year falls on a Saturday,
  // its preceding-Friday observation is Dec 31 of THIS year. Holiday sets are
  // resolved by the visited date's own year (holidayDateKeys memoizes per
  // year; walkers and isBusinessDay look up the date's year), so this year's
  // set must carry the key itself — the year+1 set's Dec-31 entry is never
  // consulted for a Dec-31 visit. Real occurrences: 2021-12-31, 2032-12-31.
  if (getDay(new Date(year + 1, 0, 1)) === 6) {
    holidays.push(normaliseHolidayDate(new Date(year, 11, 31)));
  }
  return holidays;
}

// -- UK holidays (England & Wales bank holidays) ----------------------------

function ukHolidays(year: number): readonly Date[] {
  const easter = easterSunday(year);
  const earlyMay = nthWeekdayOfMonth(year, 4, 1, 1);       // Early May Bank Holiday (1st Mon May)

  const base = [
    new Date(year, 0, 1),                                   // New Year's Day
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 2)), // Good Friday
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 1)), // Easter Monday
    earlyMay,                                               // Early May Bank Holiday
    lastWeekdayOfMonth(year, 4, 1),                         // Spring Bank Holiday (last Mon May)
    lastWeekdayOfMonth(year, 7, 1),                         // Summer Bank Holiday (last Mon Aug)
    new Date(year, 11, 25),                                 // Christmas Day
    new Date(year, 11, 26),                                 // Boxing Day
  ].map(normaliseHolidayDate);

  // England & Wales substitution rule: a bank holiday falling on a Saturday
  // or Sunday is moved to the next weekday that is not itself a bank holiday
  // (or an already-substituted day).
  const substituted: Date[] = [];
  const isTaken = (d: Date): boolean =>
    getDay(d) === 0 || getDay(d) === 6
    || base.some((h) => h.getTime() === d.getTime())
    || substituted.some((h) => h.getTime() === d.getTime());

  for (const holiday of base) {
    if (getDay(holiday) !== 0 && getDay(holiday) !== 6) continue;
    const candidate = new Date(holiday);
    do {
      candidate.setDate(candidate.getDate() + 1);
    } while (isTaken(candidate));
    substituted.push(normaliseHolidayDate(candidate));
  }
  return [...base, ...substituted];
}

// -- FR holidays (France jours feries) --------------------------------------

function frHolidays(year: number): readonly Date[] {
  const easter = easterSunday(year);
  return [
    new Date(year, 0, 1),                                   // Jour de l'An
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 1)), // Lundi de Paques
    new Date(year, 4, 1),                                   // Fete du Travail
    new Date(year, 4, 8),                                   // Victoire 1945
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 39)), // Ascension
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 50)), // Lundi de Pentecote
    new Date(year, 6, 14),                                  // Fete nationale
    new Date(year, 7, 15),                                  // Assomption
    new Date(year, 10, 1),                                  // Toussaint
    new Date(year, 10, 11),                                 // Armistice
    new Date(year, 11, 25),                                 // Noel
  ].map(normaliseHolidayDate);
}

// -- DE holidays (Germany nationwide) ---------------------------------------

function deHolidays(year: number): readonly Date[] {
  const easter = easterSunday(year);
  return [
    new Date(year, 0, 1),                                   // Neujahrstag
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 2)), // Karfreitag
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 1)), // Ostermontag
    new Date(year, 4, 1),                                   // Tag der Arbeit
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 39)), // Christi Himmelfahrt
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 50)), // Pfingstmontag
    new Date(year, 9, 3),                                   // Tag der Deutschen Einheit
    new Date(year, 11, 25),                                 // Weihnachtstag
    new Date(year, 11, 26),                                 // 2. Weihnachtstag
  ].map(normaliseHolidayDate);
}

// -- JP holidays (Japan national holidays) -----------------------------------

function jpHolidays(year: number): readonly Date[] {
  // Second Monday of January — Coming of Age Day
  const comingOfAge = nthWeekdayOfMonth(year, 0, 1, 2);
  // Second Monday of October — Sports Day
  const sportsDay = nthWeekdayOfMonth(year, 9, 1, 2);
  // Third Monday of July — Marine Day
  const marineDay = nthWeekdayOfMonth(year, 6, 1, 3);
  // Third Monday of September — Respect for the Aged Day
  const respectAged = nthWeekdayOfMonth(year, 8, 1, 3);
  const { shunbun, shubun } = jpEquinoxDates(year);

  const base = [
    new Date(year, 0, 1),                                   // Ganjitsu (New Year)
    comingOfAge,                                            // Seijin no Hi
    new Date(year, 1, 11),                                  // Kenkoku Kinen no Hi (Foundation Day)
    new Date(year, 1, 23),                                  // Tencho Setsu (Emperor's Birthday, since 2020)
    shunbun,                                                // Shunbun no Hi (Vernal Equinox)
    new Date(year, 3, 29),                                  // Showa no Hi
    new Date(year, 4, 3),                                   // Kenpo Kinen Bi (Constitution Day)
    new Date(year, 4, 4),                                   // Midori no Hi (Greenery Day)
    new Date(year, 4, 5),                                   // Kodomo no Hi (Children's Day)
    marineDay,                                              // Umi no Hi
    new Date(year, 7, 11),                                  // Yama no Hi (Mountain Day)
    respectAged,                                            // Keiro no Hi
    shubun,                                                 // Shubun no Hi (Autumnal Equinox)
    sportsDay,                                              // Taiiku no Hi
    new Date(year, 10, 3),                                  // Bunka no Hi (Culture Day)
    new Date(year, 10, 23),                                 // Kinro Kansha no Hi (Labor Thanksgiving)
  ].map(normaliseHolidayDate);

  // Furikae kyujitsu (substitute holiday): a national holiday falling on
  // Sunday moves to the next weekday that is not itself a holiday.
  // Kokumin no kyujitsu (sandwich day, Act on National Holidays Art. 3(3)):
  // a non-Sunday day whose immediate predecessor and successor are both
  // national holidays is itself a holiday — the 2024-2030 occurrence is
  // 2026-09-22, between Keiro no Hi (Sep 21) and Shubun no Hi (Sep 23).
  const sandwiches: Date[] = [];
  for (const holiday of base) {
    const twoAfter = normaliseHolidayDate(new Date(holiday.getFullYear(), holiday.getMonth(), holiday.getDate() + 2));
    const middle = normaliseHolidayDate(new Date(holiday.getFullYear(), holiday.getMonth(), holiday.getDate() + 1));
    if (
      getDay(middle) !== 0
      && base.some((h) => h.getTime() === twoAfter.getTime())
      && !base.some((h) => h.getTime() === middle.getTime())
    ) {
      sandwiches.push(middle);
    }
  }

  const substituted: Date[] = [];
  const isTaken = (d: Date): boolean =>
    getDay(d) === 0 || getDay(d) === 6
    || base.some((h) => h.getTime() === d.getTime())
    || sandwiches.some((h) => h.getTime() === d.getTime())
    || substituted.some((h) => h.getTime() === d.getTime());

  for (const holiday of base) {
    if (getDay(holiday) !== 0) continue;
    const candidate = new Date(holiday);
    do {
      candidate.setDate(candidate.getDate() + 1);
    } while (isTaken(candidate));
    substituted.push(normaliseHolidayDate(candidate));
  }
  return [...base, ...sandwiches, ...substituted];
}

// ---- Normalisation --------------------------------------------------------

function normaliseHolidayDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateToKey(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

// ---- HolidayRegistry class ------------------------------------------------

/**
 * Holiday-table version stamp ("YYYY.MM" of the rule revision). Surfaced on
 * every business-day result so consumers can detect when a holiday-rule
 * correction (observed/substitute days, equinox tables, Good Friday removal)
 * shifts previously saved forecasts.
 */
export const CALENDAR_VERSION = "2026.08";

export class HolidayRegistry {
  private readonly registry = new Map<string, HolidayFn>();
  /** Memoized holiday key-sets per (country, year) — the day-walk hot path. */
  private readonly keySetCache = new Map<string, Set<string>>();
  private computeCount = 0;

  constructor() {
    this.registry.set("US", (year: number) => usHolidays(year));
    this.registry.set("UK", (year: number) => ukHolidays(year));
    this.registry.set("FR", (year: number) => frHolidays(year));
    this.registry.set("DE", (year: number) => deHolidays(year));
    this.registry.set("JP", (year: number) => jpHolidays(year));
  }

  /** Returns true if the country code has a registered holiday function. */
  hasCountry(country: string): country is SupportedCountry {
    return this.registry.has(country.toUpperCase());
  }

  /** Lists all supported country codes. */
  supportedCountries(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Returns the set of holiday dates for a given country and year as
   * a Set of "YYYY-MM-DD" strings for fast lookup. Memoized per
   * (country, year): a multi-year day-walk computes each holiday set once
   * instead of rebuilding it for every day visited.
   */
  holidayDateKeys(country: string, year: number): Set<string> {
    const code = country.toUpperCase();
    const cacheKey = `${code}:${year}`;
    const cached = this.keySetCache.get(cacheKey);
    if (cached) return cached;
    const fn = this.registry.get(code);
    const keys = new Set<string>();
    if (fn) {
      this.computeCount++;
      for (const d of fn(year)) keys.add(dateToKey(d));
    }
    this.keySetCache.set(cacheKey, keys);
    return keys;
  }

  /**
   * Returns all holiday Date objects for a given country and year.
   * (Not memoized — the bulk accessor; use holidayDateKeys on hot paths.)
   */
  holidays(country: string, year: number): readonly Date[] {
    const fn = this.registry.get(country.toUpperCase());
    return fn ? fn(year) : [];
  }

  /** Observability/test hook: how many holiday-set computations have run (vs. cache hits). */
  holidayComputeCount(): number {
    return this.computeCount;
  }

  /** Test hook: clears the memoization cache (compute counter is preserved). */
  clearHolidayCache(): void {
    this.keySetCache.clear();
  }
}

/** Singleton registry instance. */
export const holidayRegistry = new HolidayRegistry();

// ---- Public API -----------------------------------------------------------

/**
 * Adds N business days to a start date, skipping weekends and holidays.
 */
export function addBusinessDays(
  startDate: string,
  days: number,
  countryCode: string,
): ToolResult<BusinessDayResult> {
  const parsed = parseDate(startDate);
  if ("isError" in parsed) {
    return { ok: false, error: parsed };
  }

  const code = countryCode.toUpperCase();
  // Fallback: unknown countries get weekend-only counting (no holiday awareness)
  const knownCountry = holidayRegistry.hasCountry(code);

  // Walk day-by-day to properly skip both weekends AND holidays
  const direction = days >= 0 ? 1 : -1;
  const targetCount = Math.abs(days);
  let added = 0;
  const current = new Date(parsed);
  const holidaysSkipped: string[] = [];

  while (added < targetCount) {
    current.setDate(current.getDate() + direction);
    const year = current.getFullYear();
    const holidayKeys = knownCountry ? holidayRegistry.holidayDateKeys(code, year) : new Set<string>();

    if (isWeekend(current)) continue;
    if (holidayKeys.has(dateToKey(current))) {
      holidaysSkipped.push(dateToKey(current));
      continue;
    }
    added++;
  }

  return {
    ok: true,
    data: {
      startDate: format(parsed, "yyyy-MM-dd"),
      endDate: format(current, "yyyy-MM-dd"),
      businessDays: targetCount,
      countryCode: code,
      calendarVersion: CALENDAR_VERSION,
      humanReadable: `${targetCount} business days from ${format(parsed, "yyyy-MM-dd")} to ${format(current, "yyyy-MM-dd")} (${code}).`,
    },
  };
}

/**
 * Counts business days between two dates (exclusive of start, inclusive of end).
 * Skips weekends and holidays for the given country.
 */
export function countBusinessDays(
  startDate: string,
  endDate: string,
  countryCode: string,
): ToolResult<BusinessDayResult> {
  const startParsed = parseDate(startDate);
  if ("isError" in startParsed) {
    return { ok: false, error: startParsed };
  }

  const endParsed = parseDate(endDate);
  if ("isError" in endParsed) {
    return { ok: false, error: endParsed };
  }

  const code = countryCode.toUpperCase();
  // Fallback: unknown countries get weekend-only counting (no holiday awareness)
  const knownCountry = holidayRegistry.hasCountry(code);

  // Iterate day-by-day from start (exclusive) to end (inclusive)
  const holidaysSkipped: string[] = [];
  let businessDays = 0;

  const current = new Date(startParsed);
  current.setDate(current.getDate() + 1);

  const endTime = endParsed.getTime();

  while (current.getTime() <= endTime) {
    const year = current.getFullYear();
    const holidayKeys = knownCountry ? holidayRegistry.holidayDateKeys(code, year) : new Set<string>();

    if (!isWeekend(current) && !holidayKeys.has(dateToKey(current))) {
      businessDays++;
    } else if (holidayKeys.has(dateToKey(current)) && !isWeekend(current)) {
      holidaysSkipped.push(dateToKey(current));
    }

    current.setDate(current.getDate() + 1);
  }

  return {
    ok: true,
    data: {
      startDate: format(startParsed, "yyyy-MM-dd"),
      endDate: format(endParsed, "yyyy-MM-dd"),
      businessDays,
      countryCode: code,
      calendarVersion: CALENDAR_VERSION,
      humanReadable: `${businessDays} business days between ${format(startParsed, "yyyy-MM-dd")} and ${format(endParsed, "yyyy-MM-dd")} (${code}).`,
    },
  };
}

/**
 * Returns true if the given date is a business day (not a weekend, not a holiday).
 */
export function isBusinessDay(date: string, countryCode: string): boolean {
  const parsed = parseISO(date);
  if (isNaN(parsed.getTime())) return false;

  if (isWeekend(parsed)) return false;

  const code = countryCode.toUpperCase();
  const holidayKeys = holidayRegistry.holidayDateKeys(code, parsed.getFullYear());
  return !holidayKeys.has(dateToKey(parsed));
}

/**
 * Returns true if the given date/time (interpreted in the given timezone)
 * falls within the specified working hours.
 */
export function isWithinWorkingHours(
  date: string,
  timezone: string,
  startHour: number,
  endHour: number,
): boolean {
  const parsed = parseISO(date);
  if (isNaN(parsed.getTime())) return false;

  let zoned: Date;
  try {
    zoned = toZonedTime(parsed, timezone);
  } catch {
    return false;
  }

  const hour = getHours(zoned);

  if (startHour <= endHour) {
    if (hour < startHour || hour >= endHour) return false;
  } else {
    if (hour < startHour && hour >= endHour) return false;
  }

  // Hour-granularity check: any time within the range is valid.
  return true;
}

// Re-exported from shared utility for backward compatibility.
export { getUrgencyCategory } from "./internal/urgency.js";
