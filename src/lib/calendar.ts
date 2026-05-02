// ---------------------------------------------------------------------------
// Epoch MCP Server — Layer 2: Calendar Math Utilities
// Business-day calculations with holiday awareness.
// Pure functions with no MCP dependencies. All errors returned, never thrown.
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
  UrgencyCategory,
  SupportedCountry,
  ToolResult,
  ToolError,
} from "../types/index.js";

// ---- Error helper ---------------------------------------------------------

function makeError(message: string, retryHint?: string): ToolError {
  return { isError: true, message, retryHint };
}

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

// -- US holidays (federal) --------------------------------------------------

function usHolidays(year: number): readonly Date[] {
  const easter = easterSunday(year);
  return [
    new Date(year, 0, 1),                                   // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3),                       // MLK Day
    nthWeekdayOfMonth(year, 1, 1, 3),                       // Presidents' Day
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 2)), // Good Friday
    lastWeekdayOfMonth(year, 4, 1),                         // Memorial Day (last Mon May)
    new Date(year, 5, 19),                                  // Juneteenth
    new Date(year, 6, 4),                                   // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1),                       // Labor Day
    nthWeekdayOfMonth(year, 9, 1, 2),                       // Columbus Day
    new Date(year, 10, 11),                                 // Veterans Day
    nthWeekdayOfMonth(year, 10, 3, 4),                      // Thanksgiving
    new Date(year, 11, 25),                                 // Christmas Day
  ].map(normaliseHolidayDate);
}

// -- UK holidays (England & Wales bank holidays) ----------------------------

function ukHolidays(year: number): readonly Date[] {
  const easter = easterSunday(year);
  return [
    new Date(year, 0, 1),                                   // New Year's Day
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 2)), // Good Friday
    normaliseHolidayDate(new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 1)), // Easter Monday
    nthWeekdayOfMonth(year, 4, 1, 1),                       // Early May Bank Holiday
    lastWeekdayOfMonth(year, 4, 1),                         // Spring Bank Holiday
    lastWeekdayOfMonth(year, 7, 1),                         // Summer Bank Holiday
    new Date(year, 11, 25),                                 // Christmas Day
    new Date(year, 11, 26),                                 // Boxing Day
  ].map(normaliseHolidayDate);
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

// -- JP holidays (Japan national holidays, major ones) ----------------------

function jpHolidays(year: number): readonly Date[] {
  // Second Monday of January — Coming of Age Day
  const comingOfAge = nthWeekdayOfMonth(year, 0, 1, 2);
  // Second Monday of October — Sports Day
  const sportsDay = nthWeekdayOfMonth(year, 9, 1, 2);
  // Third Monday of July — Marine Day
  const marineDay = nthWeekdayOfMonth(year, 6, 1, 3);
  // Third Monday of September — Respect for the Aged Day
  const respectAged = nthWeekdayOfMonth(year, 8, 1, 3);

  return [
    new Date(year, 0, 1),                                   // Ganjitsu (New Year)
    comingOfAge,                                             // Seijin no Hi
    new Date(year, 1, 11),                                  // Kenkoku Kinen no Hi (Foundation Day)
    new Date(year, 2, (year <= 2026 ? 21 : 20)),            // Shunbun no Hi approx — Vernal Equinox
    new Date(year, 3, 29),                                  // Showa no Hi
    new Date(year, 4, 3),                                   // Kenpo Kinen Bi (Constitution Day)
    new Date(year, 4, 4),                                   // Midori no Hi (Greenery Day)
    new Date(year, 4, 5),                                   // Kodomo no Hi (Children's Day)
    marineDay,                                               // Umi no Hi
    new Date(year, 7, 11),                                  // Yama no Hi (Mountain Day)
    respectAged,                                             // Keiro no Hi
    new Date(year, 8, (year <= 2026 ? 23 : 22)),            // Shubun no Hi approx — Autumnal Equinox
    sportsDay,                                               // Taiiku no Hi
    new Date(year, 10, 3),                                  // Bunka no Hi (Culture Day)
    new Date(year, 10, 23),                                 // Kinro Kansha no Hi (Labor Thanksgiving)
    new Date(year, 11, 31) as Date,                         // Omisoka is not a public holiday; skip
  ].filter(d => d.getMonth() !== 11 || d.getDate() !== 31)  // remove Omisoka placeholder
    .map(normaliseHolidayDate);
}

// ---- Normalisation --------------------------------------------------------

function normaliseHolidayDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateToKey(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

// ---- HolidayRegistry class ------------------------------------------------

export class HolidayRegistry {
  private readonly registry = new Map<string, HolidayFn>();

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
   * a Set of "YYYY-MM-DD" strings for fast lookup.
   */
  holidayDateKeys(country: string, year: number): Set<string> {
    const fn = this.registry.get(country.toUpperCase());
    if (!fn) return new Set();
    return new Set(fn(year).map(dateToKey));
  }

  /**
   * Returns all holiday Date objects for a given country and year.
   */
  holidays(country: string, year: number): readonly Date[] {
    const fn = this.registry.get(country.toUpperCase());
    return fn ? fn(year) : [];
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

/**
 * Categorises urgency by remaining hours.
 * Under 2h = "short", 2h-48h = "medium", over 48h = "long".
 */
export function getUrgencyCategory(hours: number): UrgencyCategory {
  if (hours < 2) return "short";
  if (hours <= 48) return "medium";
  return "long";
}
