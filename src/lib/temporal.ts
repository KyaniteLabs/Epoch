// ---------------------------------------------------------------------------
// Epoch MCP Server — Layer 1: Core Temporal Utilities
// Pure functions with no MCP dependencies. All errors returned, never thrown.
// ---------------------------------------------------------------------------

import { format, parseISO, addDays as dateFnsAddDays, differenceInSeconds } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import type {
  TemporalResult,
  DurationResult,
  DateDiffResult,
  ToolResult,
  ToolError,
} from "../types/index.js";
import { makeError } from "./internal/error-helpers.js";

// ---- Helpers --------------------------------------------------------------

function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length < 2) return false;
  try {
    const now = new Date();
    formatInTimeZone(now, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
    return true;
  } catch {
    return false;
  }
}

function parseTimestamp(ts: string): Date | ToolError {
  const parsed = parseISO(ts);
  if (isNaN(parsed.getTime())) {
    return makeError(
      `Invalid timestamp: "${ts}". Use ISO-8601 format like "2026-05-01T14:30:00Z".`,
      "Provide a valid ISO-8601 date string.",
    );
  }
  return parsed;
}

// ---- Public API -----------------------------------------------------------

/**
 * Returns the current time in the given IANA timezone.
 */
export function getCurrentTime(timezone: string): ToolResult<TemporalResult> {
  if (!isValidTimezone(timezone)) {
    return {
      ok: false,
      error: makeError(
        `Invalid timezone: "${timezone}". Use IANA identifiers like 'America/New_York'.`,
        "Try a canonical IANA timezone such as 'UTC', 'America/Los_Angeles', or 'Europe/London'.",
      ),
    };
  }

  const now = new Date();

  return {
    ok: true,
    data: {
      iso: formatInTimeZone(now, timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      humanReadable: formatInTimeZone(now, timezone, "EEEE, MMMM d, yyyy 'at' h:mm a (zzz)"),
      timezone,
      utcOffset: formatInTimeZone(now, timezone, "XXX"),
    },
  };
}

/**
 * Converts a timestamp from its embedded timezone to a target timezone.
 */
export function convertTimezone(
  timestamp: string,
  targetTz: string,
): ToolResult<TemporalResult> {
  const parsed = parseTimestamp(timestamp);
  if ("isError" in parsed) {
    return { ok: false, error: parsed };
  }

  if (!isValidTimezone(targetTz)) {
    return {
      ok: false,
      error: makeError(
        `Invalid target timezone: "${targetTz}". Use IANA identifiers like 'Asia/Tokyo'.`,
        "Try a canonical IANA timezone such as 'UTC', 'America/Chicago', or 'Europe/Berlin'.",
      ),
    };
  }

  return {
    ok: true,
    data: {
      iso: formatInTimeZone(parsed, targetTz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      humanReadable: formatInTimeZone(parsed, targetTz, "EEEE, MMMM d, yyyy 'at' h:mm a (zzz)"),
      timezone: targetTz,
      utcOffset: formatInTimeZone(parsed, targetTz, "XXX"),
    },
  };
}

/**
 * Parses a duration string such as "2h30m", "1d6h", "45m", "1w2d", "3h15m30s".
 * Supports combinations of y (years), mo (months), w (weeks), d (days), h (hours),
 * m (minutes), s (seconds).
 */
export function parseDuration(durationString: string): ToolResult<DurationResult> {
  if (!durationString || durationString.trim().length === 0) {
    return {
      ok: false,
      error: makeError(
        "Empty duration string.",
        "Provide a duration like '2h30m', '1d6h', '45m', or '1w2d'.",
      ),
    };
  }

  const input = durationString.trim();

  // Pattern matches repeated groups like "2h", "30m", "1d", "2mo", "1y"
  const TOKEN_RE = /(\d+(?:\.\d+)?)\s*(y|mo|w|d|h|m|s)/g;
  const parts: { value: number; unit: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(input)) !== null) {
    const value = match[1];
    const unit = match[2];
    if (!value || !unit) continue;
    parts.push({ value: parseFloat(value), unit });
  }

  if (parts.length === 0) {
    return {
      ok: false,
      error: makeError(
        `Could not parse duration: "${input}". No valid duration tokens found.`,
        "Use combinations of y, mo, w, d, h, m, s — e.g. '2h30m' or '1w3d12h'.",
      ),
    };
  }

  // Verify the entire input was consumed (allow whitespace)
  const reconstructed = parts.map(p => `${p.value}${p.unit}`).join("");
  const normalisedInput = input.replace(/\s+/g, "");
  if (reconstructed !== normalisedInput) {
    return {
      ok: false,
      error: makeError(
        `Unrecognised tokens in duration: "${input}".`,
        "Use only y, mo, w, d, h, m, s — e.g. '2h30m', '1d', '3mo2w'.",
      ),
    };
  }

  let totalSeconds = 0;
  let years = 0;
  let months = 0;
  let weeks = 0;
  let days = 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  for (const part of parts) {
    switch (part.unit) {
      case "y":
        years += part.value;
        totalSeconds += part.value * 365.25 * 24 * 3600;
        break;
      case "mo":
        months += part.value;
        totalSeconds += part.value * 30.44 * 24 * 3600;
        break;
      case "w":
        weeks += part.value;
        totalSeconds += part.value * 7 * 24 * 3600;
        break;
      case "d":
        days += part.value;
        totalSeconds += part.value * 24 * 3600;
        break;
      case "h":
        hours += part.value;
        totalSeconds += part.value * 3600;
        break;
      case "m":
        minutes += part.value;
        totalSeconds += part.value * 60;
        break;
      case "s":
        seconds += part.value;
        totalSeconds += part.value;
        break;
    }
  }

  // Build a human-readable summary
  const segments: string[] = [];
  if (years > 0) segments.push(`${years} year${years !== 1 ? "s" : ""}`);
  if (months > 0) segments.push(`${months} month${months !== 1 ? "s" : ""}`);
  if (weeks > 0) segments.push(`${weeks} week${weeks !== 1 ? "s" : ""}`);
  if (days > 0) segments.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0) segments.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes > 0) segments.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
  if (seconds > 0) segments.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);

  return {
    ok: true,
    data: {
      input,
      totalSeconds: Math.round(totalSeconds * 100) / 100,
      humanReadable: segments.length > 0 ? segments.join(" ") : "0 seconds",
    },
  };
}

/**
 * Formats a duration given in milliseconds into a human-readable string.
 * Pure utility — no error path because a number is always formattable.
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const segments: string[] = [];
  if (days > 0) segments.push(`${days}d`);
  if (hours > 0) segments.push(`${hours}h`);
  if (minutes > 0) segments.push(`${minutes}m`);
  if (seconds > 0 || segments.length === 0) segments.push(`${seconds}s`);

  return segments.join(" ");
}

/**
 * Adds N calendar days to an ISO date string and returns the result as
 * an ISO date string (YYYY-MM-DD).
 */
export function addDays(date: string, days: number): string {
  const parsed = parseISO(date);
  const result = dateFnsAddDays(parsed, days);
  return format(result, "yyyy-MM-dd");
}

/**
 * Computes the difference between two ISO date strings.
 * Returns days, hours, minutes, and total_seconds.
 * If end < start the values will be negative.
 */
export function diffDates(start: string, end: string): DateDiffResult {
  const startDate = parseISO(start);
  const endDate = parseISO(end);

  const totalSeconds = differenceInSeconds(endDate, startDate);

  const absSeconds = Math.abs(totalSeconds);
  const sign = totalSeconds < 0 ? -1 : 1;

  const days = sign * Math.floor(absSeconds / 86400);
  const hours = sign * Math.floor((absSeconds % 86400) / 3600);
  const minutes = sign * Math.floor((absSeconds % 3600) / 60);

  return {
    days,
    hours,
    minutes,
    total_seconds: totalSeconds,
  };
}
