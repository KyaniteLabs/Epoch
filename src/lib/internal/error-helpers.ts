// ---------------------------------------------------------------------------
// Epoch MCP Server — Shared error helper
// Single source of truth for creating ToolError objects.
// ---------------------------------------------------------------------------

import type { z } from "zod";
import type { ToolError } from "../../types/index.js";

/**
 * Creates a structured {@link ToolError} with an optional retry hint.
 * Every lib module should use this instead of hand-rolling error objects.
 */
export function makeError(message: string, retryHint?: string): ToolError {
  return { isError: true, message, retryHint };
}

// ---- Error classification (ticket 06) ----------------------------------------
//
// ToolErrors carry an optional `errorKind` tag so transport seams can tell
// caller-fixable failures apart from server-side ones without string-matching
// the message:
//
//   - "validation": the caller can fix the inputs and retry (HTTP 422).
//   - "internal":   an unexpected server-side failure the caller cannot fix
//                   (HTTP 500-class; the message may embed filesystem paths or
//                   stack details, so HTTP responses replace it with a generic
//                   one — see src/entries/http.ts).
//
// `isError` stays `true` on both so existing MCP error handling is unchanged.

/** Distinguishes caller-fixable validation failures from internal 500-class failures. */
export type ErrorKind = "validation" | "internal";

/** A {@link ToolError} with the optional transport-facing classification tag. */
export interface TaggedToolError extends ToolError {
  readonly errorKind?: ErrorKind;
}

/** True when a ToolError was tagged as an internal (500-class) failure. */
export function isInternalError(error: ToolError): boolean {
  return (error as TaggedToolError).errorKind === "internal";
}

/** Create a validation-flavored error: actionable text, safe to surface verbatim. */
export function makeValidationError(message: string, retryHint?: string): TaggedToolError {
  return { isError: true, errorKind: "validation", message, retryHint };
}

/** Create an internal-flavored error: the message may carry server-side detail. */
export function makeInternalError(message: string, retryHint?: string): TaggedToolError {
  return { isError: true, errorKind: "internal", message, retryHint };
}

// ---- Zod issue formatting (ticket 06) ----------------------------------------
//
// zod v4's ZodError.message stringifies the whole issues array as JSON — an
// unreadable blob for an agent trying to self-correct parameters. The
// dispatcher catches ZodError and renders one `path: message — got <value>`
// line per issue instead, e.g.
//
//   tokens: must be greater than 0 — got 0
//
// Custom schema messages (e.g. "days must be <= 100000. For larger shifts…")
// are preserved verbatim; only zod's own terse bound phrasing
// ("Too small: expected number to be >0") is rewritten into "must be …" form.

/** A zod issue viewed as its optional bound/collection metadata. */
interface BoundMetadata {
  readonly origin?: string;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly inclusive?: boolean;
}

/** Anything shaped like a zod v4 ZodError (issues array). */
interface ZodErrorLike {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly code: string;
    readonly message: string;
  }[];
}

/** Render an issue path as a dotted field reference ("entries.0.estimate_id"). */
function formatIssuePath(path: readonly PropertyKey[]): string {
  return path
    .map((segment) =>
      typeof segment === "symbol" ? (segment.description ?? String(segment)) : String(segment),
    )
    .join(".");
}

const ZOD_DEFAULT_BOUND_PREFIX = /^Too (?:small|big): expected /;

/**
 * Rewrite zod's default bound message into "must be …" phrasing.
 * Returns null when the schema supplied a custom message (detectable because
 * it no longer starts with zod's "Too small/big: expected …" template).
 */
function readableBoundMessage(issueCode: string, meta: BoundMetadata): string | null {
  const plural = (noun: string, n: number): string => `${noun}${n === 1 ? "" : "s"}`;

  if (issueCode === "too_small") {
    const min = meta.minimum;
    const inclusive = meta.inclusive !== false; // zod defaults to inclusive bounds
    if (typeof min === "number") {
      switch (meta.origin) {
        case "string":
          return `must be at least ${min} character${min === 1 ? "" : "s"} long`;
        case "array":
          return inclusive
            ? `must contain at least ${min} ${plural("item", min)}`
            : `must contain more than ${min} ${plural("item", min)}`;
        default: // "number" / "int"
          return inclusive ? `must be at least ${min}` : `must be greater than ${min}`;
      }
    }
    if (min instanceof Date) {
      return inclusive ? `must be at or after ${min.toISOString()}` : `must be after ${min.toISOString()}`;
    }
  }

  if (issueCode === "too_big") {
    const max = meta.maximum;
    const inclusive = meta.inclusive !== false;
    if (typeof max === "number") {
      switch (meta.origin) {
        case "string":
          return `must be at most ${max} character${max === 1 ? "" : "s"} long`;
        case "array":
          return inclusive
            ? `must contain at most ${max} ${plural("item", max)}`
            : `must contain fewer than ${max} ${plural("item", max)}`;
        default:
          return inclusive ? `must be at most ${max}` : `must be less than ${max}`;
      }
    }
    if (max instanceof Date) {
      return inclusive ? `must be at or before ${max.toISOString()}` : `must be before ${max.toISOString()}`;
    }
  }

  return null;
}

/** Truncate a display string so a single bad input can't flood the message. */
function displayValue(value: string): string {
  const MAX = 60;
  return value.length > MAX ? `${value.slice(0, MAX - 3)}...` : value;
}

/**
 * Resolve the issue path against the caller's raw input and render the value
 * the schema actually rejected ("— got 0"). Returns null when the value is
 * unavailable (no raw input supplied) or not a primitive.
 */
function describeReceived(path: readonly PropertyKey[], rawInput: unknown): string | null {
  if (rawInput === null || typeof rawInput !== "object") return null;
  let current: unknown = rawInput;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  if (typeof current === "string") return JSON.stringify(displayValue(current));
  if (typeof current === "number" || typeof current === "bigint" || typeof current === "boolean") {
    return String(current);
  }
  if (current === null) return "null";
  return null;
}

/**
 * Format a {@link z.ZodError} into one readable `path: message` line per
 * issue (ticket 06). Never emits raw zod JSON. Issues without a path are
 * rendered as bare messages. When `rawInput` is supplied (the dispatcher has
 * it in scope), bound failures append the offending value.
 */
export function formatZodIssues(error: z.ZodError | ZodErrorLike, rawInput?: unknown): string {
  const lines = error.issues.map((issue) => {
    const meta = issue as typeof issue & BoundMetadata;
    const path = formatIssuePath(issue.path);

    let message: string;
    if (
      (issue.code === "too_small" || issue.code === "too_big") &&
      ZOD_DEFAULT_BOUND_PREFIX.test(issue.message)
    ) {
      message = readableBoundMessage(issue.code, meta) ?? issue.message;
    } else {
      message = issue.message;
    }

    const received = describeReceived(issue.path, rawInput);
    return `${path ? `${path}: ` : ""}${message}${received ? ` — got ${received}` : ""}`;
  });

  return lines.length > 0 ? lines.join("\n") : "Invalid input.";
}
