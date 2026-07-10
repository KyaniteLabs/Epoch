// ---------------------------------------------------------------------------
// Epoch — TypeScript ↔ Rust Parity Harness
//
// Executes every golden case (see rust-parity-cases.ts) against BOTH runtimes
// on identical inputs:
//   • TypeScript — the in-process tool handler from the dispatcher registry
//   • Rust       — the compiled `epoch-cli` binary (one process per case)
//
// It normalizes documented nondeterminism (minted feedback ids, wall-clock
// values), compares outputs (with float tolerance) or error compatibility,
// and produces a machine-readable parity report.
//
// This is repo-owned promotion tooling, run via tsx — it is NOT part of the
// published bundle.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_REGISTRY } from "../dispatcher/tool-registry.js";
import { RUST_PARITY_CASES } from "./rust-parity-cases.js";
import type { ParityCase, ParityComparison } from "./rust-parity-cases.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root: src/contract → repo root is two levels up. */
const REPO_ROOT = resolve(HERE, "..", "..");

/** Keys minted per-runtime that must be stripped before comparison. */
const VOLATILE_KEYS = new Set(["feedbackRef"]);

/**
 * Free-text, human-facing narrative fields. These are presentation strings
 * (em-dash vs hyphen, "1,200" vs "1200", rendered map ordering) — not the
 * structured contract. They are excluded from the semantic parity GATE and
 * tracked separately as informational `narrativeParityPercent`.
 */
const NARRATIVE_FIELDS = new Set(["humanReadable", "summary"]);

/** Relative + absolute tolerance for floating-point comparison. */
const FLOAT_TOLERANCE = 1e-6;

// ---- Runtime execution ------------------------------------------------------

export interface RuntimeResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly message?: string };
}

/** Locate the compiled Rust CLI, honouring an explicit override. */
export function resolveRustBinary(): string | null {
  const candidates = [
    process.env["EPOCH_RUST_CLI"],
    join(REPO_ROOT, "rust", "target", "release", "epoch-cli"),
    join(REPO_ROOT, "rust", "target", "debug", "epoch-cli"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Run the TypeScript tool handler in-process. Thrown ZodErrors become errors. */
export function runTypeScript(
  tool: string,
  input: Record<string, unknown>,
): RuntimeResult {
  const definition = TOOL_REGISTRY.get(tool);
  if (!definition) {
    return { ok: false, error: { message: `Unknown TypeScript tool: ${tool}` } };
  }
  try {
    const result = definition.handler({ ...input });
    if (result.ok) {
      return { ok: true, value: (result as { ok: true; data: unknown }).data };
    }
    const error = (result as { ok: false; error: { message?: string } }).error;
    return { ok: false, error: { message: error?.message } };
  } catch (err: unknown) {
    return {
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** Run the compiled Rust CLI as a child process. */
export function runRust(
  binary: string,
  cliCommand: string,
  input: Record<string, unknown>,
): RuntimeResult {
  const result = spawnSync(binary, [cliCommand, JSON.stringify(input)], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, error: { message: `spawn failed: ${result.error.message}` } };
  }

  if (result.status === 0) {
    try {
      return { ok: true, value: JSON.parse(result.stdout) as unknown };
    } catch {
      return {
        ok: false,
        error: { message: `unparseable Rust stdout: ${result.stdout.slice(0, 200)}` },
      };
    }
  }

  // Non-zero exit: the CLI prints {"error": {...}} to stderr.
  try {
    const parsed = JSON.parse(result.stderr) as { error?: { message?: string } };
    return { ok: false, error: parsed.error ?? { message: result.stderr.trim() } };
  } catch {
    const message = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { ok: false, error: { message } };
  }
}

// ---- Normalization ----------------------------------------------------------

function deepClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Recursively strip per-runtime volatile keys (e.g. feedbackRef). */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(inner);
    }
    return out;
  }
  return value;
}

/** Blank a dotted path (set to null) so volatile values don't cause diffs. */
function blankPath(root: unknown, path: string): void {
  const parts = path.split(".");
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[parts[i] as string];
    } else {
      return;
    }
  }
  if (cursor && typeof cursor === "object") {
    (cursor as Record<string, unknown>)[parts[parts.length - 1] as string] = null;
  }
}

/** Clone, strip volatile keys, and blank documented ignore paths. */
export function normalize(
  value: unknown,
  ignoreFields: readonly string[] = [],
): unknown {
  const cloned = stripVolatile(deepClone(value));
  for (const field of ignoreFields) blankPath(cloned, field);
  return cloned;
}

/** Recursively drop narrative fields so the semantic comparison ignores them. */
function dropNarrative(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNarrative);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (NARRATIVE_FIELDS.has(key)) continue;
      out[key] = dropNarrative(inner);
    }
    return out;
  }
  return value;
}

/** Collect top-level narrative string fields keyed by name (for soft compare). */
function collectNarrative(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (NARRATIVE_FIELDS.has(key)) out[key] = inner;
  }
  return out;
}

// ---- Comparison -------------------------------------------------------------

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function numbersClose(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  const diff = Math.abs(a - b);
  return diff <= FLOAT_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Returns null when `a` and `b` are equal (numbers within tolerance), or a
 * human-readable description of the first divergence.
 */
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") {
    return numbersClose(a, b) ? null : `${path}: ts=${a} rust=${b}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return `${path}: type ts=${kindOf(a)} rust=${kindOf(b)}`;
    }
    if (a.length !== b.length) {
      return `${path}: length ts=${a.length} rust=${b.length}`;
    }
    for (let i = 0; i < a.length; i++) {
      const diff = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    const tsOnly = aKeys.filter((k) => !bKeys.includes(k));
    const rustOnly = bKeys.filter((k) => !aKeys.includes(k));
    if (tsOnly.length) return `${path}: ts-only keys [${tsOnly.join(", ")}]`;
    if (rustOnly.length) return `${path}: rust-only keys [${rustOnly.join(", ")}]`;
    for (const key of aKeys) {
      const diff = firstDiff(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }
  if (a === b) return null;
  return `${path}: ts=${JSON.stringify(a)} rust=${JSON.stringify(b)}`;
}

/** Type/key skeleton ignoring concrete values — used for "shape" comparison. */
function skeleton(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [skeleton(value[0])] : [];
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = skeleton((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return kindOf(value);
}

export function shapeDiff(a: unknown, b: unknown): string | null {
  const ts = JSON.stringify(skeleton(a));
  const rust = JSON.stringify(skeleton(b));
  return ts === rust ? null : `shape ts=${ts} rust=${rust}`;
}

// ---- Report -----------------------------------------------------------------

export interface ParityDiff {
  readonly case: string;
  readonly tool: string;
  readonly kind:
    | "output-mismatch"
    | "error-mismatch"
    | "unexpected-error"
    | "narrative-mismatch";
  readonly detail: string;
}

export interface ParityReport {
  readonly package: string;
  readonly rustBinary: string | null;
  readonly totalCases: number;
  readonly matchedCases: number;
  /** Output (expect="ok") cases compared on the structured contract. */
  readonly outputCases: number;
  readonly outputMatched: number;
  /** Semantic parity over structured fields — this is the promotion GATE. */
  readonly outputParityPercent: number;
  readonly errorCases: number;
  readonly errorMatched: number;
  readonly errorCompatibilityPercent: number;
  /** Narrative (humanReadable/summary) parity — informational, not gated. */
  readonly narrativeCases: number;
  readonly narrativeMatched: number;
  readonly narrativeParityPercent: number;
  readonly toolsCovered: string[];
  /** Structural/error diffs — these drive the gate. */
  readonly diffs: ParityDiff[];
  /** Cosmetic narrative diffs — reported but do not fail the gate. */
  readonly narrativeDiffs: ParityDiff[];
  /**
   * `pendingRust` cases (deferred behavioral parity — the Rust binary
   * doesn't implement the behavior yet): TS-only, verified via each case's
   * `assertTs`. Never runs against Rust and never affects
   * outputCases/errorCases/outputParityPercent/errorCompatibilityPercent —
   * skipped-with-reason on the Rust side, pinned now on the TS side.
   */
  readonly pendingRustCases: number;
  readonly pendingRustMatched: number;
  readonly pendingRustSkips: ReadonlyArray<{ readonly case: string; readonly tool: string; readonly reason: string }>;
  /** assertTs failures for pendingRust cases — informational, never gates promotion. */
  readonly pendingRustDiffs: ParityDiff[];
}

export interface RunOptions {
  /** Override the resolved binary. `null` forces "rust unavailable". */
  readonly binary?: string | null;
  /** Override the golden case list (used by tests). */
  readonly cases?: readonly ParityCase[];
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Execute the parity harness and build a machine-readable report. */
export function runRustParity(options: RunOptions = {}): ParityReport {
  const binary =
    options.binary !== undefined ? options.binary : resolveRustBinary();
  const cases = options.cases ?? RUST_PARITY_CASES;

  // Isolate feedback storage so stateful tools see an empty store on the TS
  // side, matching Rust's fresh in-memory dispatcher.
  if (!process.env["EPOCH_DATA_DIR"]) {
    process.env["EPOCH_DATA_DIR"] = mkdtempSync(join(tmpdir(), "epoch-parity-"));
  }
  process.env["EPOCH_DRY_RUN"] = "1";

  const diffs: ParityDiff[] = [];
  const narrativeDiffs: ParityDiff[] = [];
  const pendingRustDiffs: ParityDiff[] = [];
  const pendingRustSkips: Array<{ case: string; tool: string; reason: string }> = [];
  let outputCases = 0;
  let outputMatched = 0;
  let errorCases = 0;
  let errorMatched = 0;
  let narrativeCases = 0;
  let narrativeMatched = 0;
  let pendingRustCases = 0;
  let pendingRustMatched = 0;

  for (const parityCase of cases) {
    // Fixture-seeded cases get a fresh, case-isolated EPOCH_DATA_DIR for the
    // duration of this case only — kills order-dependence between them
    // (each seeds/observes its own rows, never another case's). Restored to
    // the shared harness-wide dir afterward so non-seeded cases are
    // unaffected.
    let restoreDataDir: (() => void) | undefined;
    if (parityCase.seedFixture) {
      const previousDataDir = process.env["EPOCH_DATA_DIR"];
      const caseDataDir = mkdtempSync(join(tmpdir(), "epoch-parity-case-"));
      process.env["EPOCH_DATA_DIR"] = caseDataDir;
      parityCase.seedFixture(caseDataDir);
      restoreDataDir = () => {
        if (previousDataDir === undefined) delete process.env["EPOCH_DATA_DIR"];
        else process.env["EPOCH_DATA_DIR"] = previousDataDir;
      };
    }

    try {
      if (parityCase.pendingRust) {
        // Deferred behavioral parity: the Rust binary doesn't implement this
        // yet. Run the TS side only, pin it via assertTs, and record the
        // skip — never touches outputCases/errorCases/diffs (the promotion
        // gate), so existing parity cases and thresholds are unaffected.
        pendingRustCases++;
        pendingRustSkips.push({ case: parityCase.name, tool: parityCase.tool, reason: parityCase.pendingRust });
        const ts = runTypeScript(parityCase.tool, parityCase.input);
        const detail = parityCase.assertTs
          ? parityCase.assertTs(ts)
          : ts.ok
            ? null
            : `unexpected ts error: ${ts.error?.message ?? ""}`;
        if (detail === null) {
          pendingRustMatched++;
        } else {
          pendingRustDiffs.push({ case: parityCase.name, tool: parityCase.tool, kind: "output-mismatch", detail });
        }
        continue;
      }

      const ts = runTypeScript(parityCase.tool, parityCase.input);
      const rust = binary
        ? runRust(binary, parityCase.cliCommand, parityCase.input)
        : { ok: false, error: { message: "rust binary unavailable" } };

      if (parityCase.expect === "error") {
      errorCases++;
      if (!ts.ok && !rust.ok) {
        errorMatched++;
      } else {
        diffs.push({
          case: parityCase.name,
          tool: parityCase.tool,
          kind: "error-mismatch",
          detail:
            `expected both to reject; ts.ok=${ts.ok} rust.ok=${rust.ok}` +
            (ts.ok ? "" : ` | ts-error: ${ts.error?.message ?? ""}`) +
            (rust.ok ? "" : ` | rust-error: ${rust.error?.message ?? ""}`),
        });
      }
      continue;
    }

    outputCases++;
    if (!ts.ok || !rust.ok) {
      diffs.push({
        case: parityCase.name,
        tool: parityCase.tool,
        kind: "unexpected-error",
        detail:
          `expected both to succeed; ts.ok=${ts.ok} rust.ok=${rust.ok}` +
          (ts.ok ? "" : ` | ts-error: ${ts.error?.message ?? ""}`) +
          (rust.ok ? "" : ` | rust-error: ${rust.error?.message ?? ""}`),
      });
      continue;
    }

    const comparison: ParityComparison = parityCase.comparison ?? "value";
    const tsNormalized = normalize(ts.value, parityCase.ignoreFields);
    const rustNormalized = normalize(rust.value, parityCase.ignoreFields);

    // Semantic comparison drives the gate: structured fields only.
    const tsSemantic = dropNarrative(tsNormalized);
    const rustSemantic = dropNarrative(rustNormalized);
    const detail =
      comparison === "shape"
        ? shapeDiff(tsSemantic, rustSemantic)
        : firstDiff(tsSemantic, rustSemantic);

    if (detail === null) {
      outputMatched++;
    } else {
      diffs.push({
        case: parityCase.name,
        tool: parityCase.tool,
        kind: "output-mismatch",
        detail,
      });
    }

    // Narrative comparison is informational and never fails the gate.
    const narrativeDetail = firstDiff(
      collectNarrative(tsNormalized),
      collectNarrative(rustNormalized),
    );
    if (Object.keys(collectNarrative(tsNormalized)).length > 0) {
      narrativeCases++;
      if (narrativeDetail === null) {
        narrativeMatched++;
      } else {
        narrativeDiffs.push({
          case: parityCase.name,
          tool: parityCase.tool,
          kind: "narrative-mismatch",
          detail: narrativeDetail,
        });
      }
    }
    } finally {
      restoreDataDir?.();
    }
  }

  const toolsCovered = [...new Set(cases.map((c) => c.tool))].sort();

  return {
    package: "@kyanitelabs/epoch",
    rustBinary: binary,
    totalCases: cases.length,
    matchedCases: outputMatched + errorMatched,
    outputCases,
    outputMatched,
    outputParityPercent: outputCases ? round1((outputMatched / outputCases) * 100) : 100,
    errorCases,
    errorMatched,
    errorCompatibilityPercent: errorCases
      ? round1((errorMatched / errorCases) * 100)
      : 100,
    narrativeCases,
    narrativeMatched,
    narrativeParityPercent: narrativeCases
      ? round1((narrativeMatched / narrativeCases) * 100)
      : 100,
    toolsCovered,
    diffs,
    narrativeDiffs,
    pendingRustCases,
    pendingRustMatched,
    pendingRustSkips,
    pendingRustDiffs,
  };
}
