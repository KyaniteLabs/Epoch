// ---------------------------------------------------------------------------
// Epoch — Rust-vs-TypeScript adversarial compatibility QA
//
// Purpose: before the Rust runtime can replace the TypeScript MCP server, it
// must refuse the same malformed input the TypeScript server refuses. This
// harness feeds a battery of adversarial tool calls to BOTH implementations and
// compares the accept/reject polarity of each.
//
//   TypeScript side : src/dispatcher dispatch() — every handler Zod-parses its
//                     input first, so dispatch() faithfully reflects what the
//                     MCP, HTTP, and CLI surfaces all do (accept vs reject).
//   Rust side       : the `epoch-mcp` stdio binary, driven with a JSON-RPC
//                     `tools/call` message per case (full transport + dispatch
//                     + core path), one process per case for crash isolation.
//
// A "high-severity diff" is the dangerous direction: TypeScript REJECTS the
// input but Rust ACCEPTS it (a malformed payload would slip through after the
// promotion) — or Rust crashes. The opposite direction (Rust stricter than TS)
// is a medium-severity functional regression.
//
// Output: a machine-readable JSON report under docs/superpowers/reports/ with
// pass/fail counts, per-category / per-severity tallies, and the high-severity
// diff list. Report-only by default (exit 0); pass --strict to exit non-zero
// when any high/critical diff is found, so it can gate a promotion in CI.
//
// Run: pnpm run promotion:rust-adversarial [-- --strict] [--no-build]
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Isolate import-time TypeScript side effects (telemetry / feedback persistence)
// into a throwaway temp dir BEFORE the dispatcher is loaded, so the run never
// touches ~/.epoch or the working tree. Individual cases get stricter
// implementation-local data dirs below; sharing a data dir between TypeScript
// and Rust would turn valid write compatibility into false duplicate failures.
const ISOLATED_DATA_DIR = mkdtempSync(join(tmpdir(), "epoch-rust-adversarial-"));
process.env["EPOCH_DATA_DIR"] = ISOLATED_DATA_DIR;
process.env["EPOCH_TELEMETRY_DISABLED"] = "1";

const { dispatch } = await import("../src/dispatcher/index.js");

// ---- Paths ----------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const RUST_MANIFEST = join(REPO_ROOT, "rust", "Cargo.toml");
const REPORT_DIR = join(REPO_ROOT, "docs", "superpowers", "reports");
const REPORT_PATH = join(REPORT_DIR, "rust-promotion-adversarial-report.json");

// ---- Outcome model --------------------------------------------------------

type Polarity = "accepted" | "rejected" | "crash";
type RejectKind = "validation" | "transport" | "none";

interface Outcome {
  polarity: Polarity;
  rejectKind: RejectKind;
  detail: string;
}

type Severity = "none" | "low" | "medium" | "high" | "critical";

interface CaseSpec {
  id: string;
  category: string;
  /** What the case is probing, for the report. */
  note: string;
  /** Tool name. For unknown-tool cases this is the bad name itself. */
  tool: string;
  /** "object" = JSON-RPC tools/call with `args`; "raw" = send `raw` verbatim. */
  mode: "object" | "raw";
  args?: unknown;
  raw?: string;
}

interface CaseResult {
  id: string;
  category: string;
  note: string;
  tool: string;
  ts: Outcome;
  rust: Outcome;
  verdict: "pass" | "fail";
  severity: Severity;
  diff: string;
}

// ---------------------------------------------------------------------------
// Adversarial cases — eight categories required by the promotion QA.
// ---------------------------------------------------------------------------

const CASES: CaseSpec[] = [
  // 1. Malformed JSON (transport layer) -------------------------------------
  rawCase("malformed-json", "json-broken-brace", "pert_estimate", "{bad json"),
  rawCase("malformed-json", "json-trailing-colon", "pert_estimate", '{"optimistic":}'),
  rawCase("malformed-json", "json-not-json", "pert_estimate", "this is not json at all"),
  rawCase("malformed-json", "json-truncated", "pert_estimate", '{"optimistic":1,"most_likely":'),
  rawCase("malformed-json", "json-bare-array", "pert_estimate", "[1, 2, 3,]"),

  // 2. Missing required fields ----------------------------------------------
  objCase("missing-required", "pert-missing-pessimistic", "pert_estimate", {
    optimistic: 1,
    most_likely: 2,
  }),
  objCase("missing-required", "convert-missing-target-tz", "convert_timezone", {
    timestamp: "2026-06-24T12:00:00Z",
  }),
  objCase("missing-required", "token-cost-missing-model", "token_cost_estimate", {
    tokens: 1000,
  }),
  objCase("missing-required", "record-actual-missing-hours", "record_actual", {
    estimate_id: "abc",
  }),
  objCase("missing-required", "critical-path-missing-tasks", "critical_path", {}),
  objCase("missing-required", "reference-class-missing-task-type", "reference_class_estimate", {
    complexity: 3,
  }),

  // 3. Wrong types ----------------------------------------------------------
  objCase("wrong-type", "pert-optimistic-object", "pert_estimate", {
    optimistic: { value: 1 },
    most_likely: 2,
    pessimistic: 4,
  }),
  objCase("wrong-type", "sprint-velocity-string", "sprint_forecast", {
    backlog_points: 20,
    velocity_history: "8,10,9",
  }),
  objCase("wrong-type", "critical-path-tasks-string", "critical_path", {
    tasks: "A,B,C",
  }),
  objCase("wrong-type", "arguments-is-array", "pert_estimate", [1, 2, 4]),
  objCase("wrong-type", "record-actual-hours-string", "record_actual", {
    estimate_id: "abc",
    actual_hours: "5",
  }),
  objCase("wrong-type", "schedule-risk-complexity-string", "schedule_risk", {
    estimated_hours: 8,
    complexity: "3",
  }),
  objCase("wrong-type", "pert-most-likely-bool", "pert_estimate", {
    optimistic: 1,
    most_likely: true,
    pessimistic: 4,
  }),

  // 4. Invalid date / timezone ----------------------------------------------
  objCase("invalid-date-tz", "convert-invalid-tz", "convert_timezone", {
    timestamp: "2026-06-24T12:00:00Z",
    target_tz: "Mars/Phobos",
  }),
  objCase("invalid-date-tz", "current-time-invalid-tz", "get_current_time", {
    timezone: "Not/AZone",
  }),
  objCase("invalid-date-tz", "convert-invalid-timestamp", "convert_timezone", {
    timestamp: "not-a-timestamp",
    target_tz: "America/Los_Angeles",
  }),
  objCase("invalid-date-tz", "add-business-days-bad-date", "add_business_days", {
    start_date: "2026-13-45",
    days: 3,
  }),
  objCase("invalid-date-tz", "count-business-days-bad-range", "count_business_days", {
    start_date: "garbage",
    end_date: "also-garbage",
  }),

  // 5. Bad feedback IDs -----------------------------------------------------
  objCase("bad-feedback-id", "record-actual-unknown-id", "record_actual", {
    estimate_id: "does-not-exist-zzz-000",
    actual_hours: 4,
  }),
  objCase("bad-feedback-id", "record-actual-empty-id", "record_actual", {
    estimate_id: "",
    actual_hours: 4,
  }),
  objCase("bad-feedback-id", "batch-unknown-ids", "batch_record_actuals", {
    entries: [
      { estimate_id: "missing-1", actual_hours: 2 },
      { estimate_id: "missing-2", actual_hours: 3 },
    ],
  }),

  // 6. Numeric extremes -----------------------------------------------------
  objCase("numeric-extreme", "pert-negative-optimistic", "pert_estimate", {
    optimistic: -1,
    most_likely: 2,
    pessimistic: 4,
  }),
  objCase("numeric-extreme", "cocomo-negative-kloc", "cocomo_estimate", {
    kloc: -5,
  }),
  objCase("numeric-extreme", "cocomo-factor-out-of-range", "cocomo_estimate", {
    kloc: 2,
    reasoning_complexity: 99,
  }),
  objCase("numeric-extreme", "monte-carlo-iterations-over-cap", "monte_carlo_schedule", {
    tasks: [{ name: "A", optimistic: 1, most_likely: 2, pessimistic: 4 }],
    iterations: 100001,
  }),
  objCase("numeric-extreme", "schedule-risk-complexity-over-max", "schedule_risk", {
    estimated_hours: 8,
    complexity: 50,
  }),
  objCase("numeric-extreme", "pert-overflow-pessimistic", "pert_estimate", {
    optimistic: 1,
    most_likely: 2,
    pessimistic: 1e308,
  }),
  objCase("numeric-extreme", "token-cost-negative-tokens", "token_cost_estimate", {
    tokens: -1000,
    model: "gpt-4o-mini",
  }),
  objCase("numeric-extreme", "reference-class-complexity-zero", "reference_class_estimate", {
    task_type: "feature",
    complexity: 0,
  }),

  // 7. Empty arrays ---------------------------------------------------------
  objCase("empty-array", "critical-path-empty-tasks", "critical_path", { tasks: [] }),
  objCase("empty-array", "monte-carlo-empty-tasks", "monte_carlo_schedule", {
    tasks: [],
    iterations: 100,
  }),
  objCase("empty-array", "sprint-empty-velocity", "sprint_forecast", {
    backlog_points: 20,
    velocity_history: [],
  }),
  objCase("empty-array", "batch-empty-entries", "batch_record_actuals", { entries: [] }),

  // 8. Unknown tool names ---------------------------------------------------
  unknownToolCase("unknown-tool", "unknown-plain", "no_such_tool"),
  unknownToolCase("unknown-tool", "unknown-typo", "pert_estimat"),
  unknownToolCase("unknown-tool", "unknown-empty", ""),
  unknownToolCase("unknown-tool", "unknown-proto", "__proto__"),
  unknownToolCase("unknown-tool", "unknown-casing", "PERT_ESTIMATE"),
];

function objCase(
  category: string,
  id: string,
  tool: string,
  args: unknown,
): CaseSpec {
  return { id, category, note: id, tool, mode: "object", args };
}

function rawCase(
  category: string,
  id: string,
  tool: string,
  raw: string,
): CaseSpec {
  return { id, category, note: id, tool, mode: "raw", raw };
}

function unknownToolCase(category: string, id: string, tool: string): CaseSpec {
  return { id, category, note: id, tool, mode: "object", args: {} };
}

// ---------------------------------------------------------------------------
// TypeScript evaluation
// ---------------------------------------------------------------------------

async function evaluateTs(spec: CaseSpec, dataDir: string): Promise<Outcome> {
  const previousDataDir = process.env["EPOCH_DATA_DIR"];
  process.env["EPOCH_DATA_DIR"] = dataDir;
  try {
    if (spec.mode === "raw") {
      // Transport layer: both MCP (SDK) and HTTP (c.req.json) reject unparseable
      // bodies before dispatch is ever reached. Mirror that with JSON.parse.
      try {
        JSON.parse(spec.raw ?? "");
        return { polarity: "accepted", rejectKind: "none", detail: "JSON.parse accepted raw input" };
      } catch (err) {
        return {
          polarity: "rejected",
          rejectKind: "transport",
          detail: `JSON.parse threw: ${(err as Error).message}`,
        };
      }
    }

    try {
      const result = await dispatch(spec.tool, spec.args as Record<string, unknown>);
      if (result.ok) {
        return { polarity: "accepted", rejectKind: "none", detail: "dispatch returned ok" };
      }
      return {
        polarity: "rejected",
        rejectKind: "validation",
        detail: result.error?.message ?? "dispatch returned not-ok",
      };
    } catch (err) {
      // dispatch() catches handler throws, so this only fires on a real crash.
      return {
        polarity: "crash",
        rejectKind: "none",
        detail: `dispatch threw: ${(err as Error).message}`,
      };
    }
  } finally {
    if (previousDataDir === undefined) {
      delete process.env["EPOCH_DATA_DIR"];
    } else {
      process.env["EPOCH_DATA_DIR"] = previousDataDir;
    }
  }
}

// ---------------------------------------------------------------------------
// Rust evaluation — one `epoch-mcp` process per case for crash isolation.
// ---------------------------------------------------------------------------

function buildLine(spec: CaseSpec): string {
  if (spec.mode === "raw") return spec.raw ?? "";
  return JSON.stringify({
    jsonrpc: "2.0",
    id: spec.id,
    method: "tools/call",
    params: { name: spec.tool, arguments: spec.args ?? {} },
  });
}

function parseFramed(stdout: string): unknown {
  const sep = stdout.indexOf("\r\n\r\n");
  const body = sep >= 0 ? stdout.slice(sep + 4) : stdout;
  const altSep = sep < 0 ? body.indexOf("\n\n") : -1;
  const candidate = altSep >= 0 ? body.slice(altSep + 2) : body;
  return JSON.parse(candidate.trim());
}

function evaluateRust(binary: string, spec: CaseSpec, dataDir: string): Outcome {
  const line = buildLine(spec);
  const proc = spawnSync(binary, {
    input: `${line}\n`,
    encoding: "utf-8",
    env: {
      ...process.env,
      EPOCH_DATA_DIR: dataDir,
      EPOCH_TELEMETRY_DISABLED: "1",
    },
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (proc.error) {
    return { polarity: "crash", rejectKind: "none", detail: `spawn error: ${proc.error.message}` };
  }
  if (proc.status !== 0 && proc.status !== null) {
    return {
      polarity: "crash",
      rejectKind: "none",
      detail: `non-zero exit ${proc.status}: ${(proc.stderr ?? "").trim().slice(0, 200)}`,
    };
  }
  if (proc.signal) {
    return {
      polarity: "crash",
      rejectKind: "none",
      detail: `killed by signal ${proc.signal} (likely timeout / hang)`,
    };
  }

  const stdout = proc.stdout ?? "";
  if (stdout.trim() === "") {
    // No response emitted. For an unparseable line the binary emits a -32700;
    // genuine silence means the message was swallowed — treat as a reject only
    // if stderr is clean, else a crash.
    const stderr = (proc.stderr ?? "").trim();
    if (stderr) {
      return { polarity: "crash", rejectKind: "none", detail: `no stdout, stderr: ${stderr.slice(0, 200)}` };
    }
    return { polarity: "rejected", rejectKind: "transport", detail: "no response emitted" };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseFramed(stdout) as Record<string, unknown>;
  } catch (err) {
    return {
      polarity: "crash",
      rejectKind: "none",
      detail: `unparseable response: ${(err as Error).message}`,
    };
  }

  // Top-level JSON-RPC error (parse error -32700, unknown method -32601, ...).
  if (parsed["error"] && typeof parsed["error"] === "object") {
    const code = (parsed["error"] as Record<string, unknown>)["code"];
    const message = (parsed["error"] as Record<string, unknown>)["message"];
    return {
      polarity: "rejected",
      rejectKind: "transport",
      detail: `jsonrpc error ${String(code)}: ${String(message)}`,
    };
  }

  const result = parsed["result"] as Record<string, unknown> | undefined;
  if (!result) {
    return { polarity: "crash", rejectKind: "none", detail: "response missing result and error" };
  }

  if (result["isError"] === true) {
    const structured = result["structuredContent"] as Record<string, unknown> | undefined;
    const toolError = structured?.["error"] as Record<string, unknown> | undefined;
    return {
      polarity: "rejected",
      rejectKind: "validation",
      detail: String(toolError?.["message"] ?? "tool returned isError"),
    };
  }

  return { polarity: "accepted", rejectKind: "none", detail: "tool returned isError:false" };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compare(spec: CaseSpec, ts: Outcome, rust: Outcome): {
  verdict: "pass" | "fail";
  severity: Severity;
  diff: string;
} {
  if (rust.polarity === "crash") {
    return {
      verdict: "fail",
      severity: "critical",
      diff: "Rust crashed / hung on an input the TypeScript server handled gracefully.",
    };
  }
  if (ts.polarity === "crash") {
    // TS should never crash (dispatch catches); flag if it does.
    return {
      verdict: "fail",
      severity: "high",
      diff: "TypeScript dispatch crashed instead of returning a structured error.",
    };
  }

  if (ts.polarity === rust.polarity) {
    return { verdict: "pass", severity: "none", diff: "Same accept/reject polarity." };
  }

  if (ts.polarity === "rejected" && rust.polarity === "accepted") {
    return {
      verdict: "fail",
      severity: "high",
      diff: "TypeScript REJECTS this input but Rust ACCEPTS it — malformed payload would pass after promotion.",
    };
  }

  // ts accepted, rust rejected
  return {
    verdict: "fail",
    severity: "medium",
    diff: "Rust REJECTS input the TypeScript server accepts — functional regression after promotion.",
  };
}

// ---------------------------------------------------------------------------
// Rust binary resolution
// ---------------------------------------------------------------------------

function resolveRustBinary(allowBuild: boolean): string {
  const override = process.env["EPOCH_RUST_MCP_BIN"];
  if (override && existsSync(override)) return override;

  const release = join(REPO_ROOT, "rust", "target", "release", "epoch-mcp");
  const debug = join(REPO_ROOT, "rust", "target", "debug", "epoch-mcp");
  if (existsSync(release)) return release;
  if (existsSync(debug)) return debug;

  if (!allowBuild) {
    throw new Error(
      "epoch-mcp binary not found. Build it with `cargo build --manifest-path rust/Cargo.toml -p epoch-mcp` or drop --no-build.",
    );
  }

  console.error("[rust-adversarial] epoch-mcp binary missing — building (debug)…");
  execFileSync("cargo", ["build", "--manifest-path", RUST_MANIFEST, "-p", "epoch-mcp"], {
    stdio: "inherit",
  });
  if (!existsSync(debug)) {
    throw new Error("cargo build completed but epoch-mcp binary still missing.");
  }
  return debug;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  const allowBuild = !argv.includes("--no-build");

  const binary = resolveRustBinary(allowBuild);

  const results: CaseResult[] = [];
  for (const spec of CASES) {
    const tsDataDir = mkdtempSync(join(tmpdir(), `epoch-rust-adversarial-ts-${spec.id}-`));
    const rustDataDir = mkdtempSync(join(tmpdir(), `epoch-rust-adversarial-rust-${spec.id}-`));
    let ts: Outcome;
    let rust: Outcome;
    try {
      ts = await evaluateTs(spec, tsDataDir);
      rust = evaluateRust(binary, spec, rustDataDir);
    } finally {
      rmSync(tsDataDir, { recursive: true, force: true });
      rmSync(rustDataDir, { recursive: true, force: true });
    }
    const { verdict, severity, diff } = compare(spec, ts, rust);
    results.push({
      id: spec.id,
      category: spec.category,
      note: spec.note,
      tool: spec.tool,
      ts,
      rust,
      verdict,
      severity,
      diff,
    });
  }

  const pass = results.filter((r) => r.verdict === "pass").length;
  const fail = results.length - pass;

  const bySeverity: Record<Severity, number> = {
    none: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  const byCategory: Record<string, { total: number; pass: number; fail: number }> = {};
  for (const r of results) {
    bySeverity[r.severity] += 1;
    const cat = (byCategory[r.category] ??= { total: 0, pass: 0, fail: 0 });
    cat.total += 1;
    if (r.verdict === "pass") cat.pass += 1;
    else cat.fail += 1;
  }

  const highSeverityDiffs = results.filter(
    (r) => r.severity === "high" || r.severity === "critical",
  );

  const report = {
    report: "rust-promotion-adversarial-compatibility",
    description:
      "Adversarial accept/reject comparison between the TypeScript Epoch dispatcher and the Rust epoch-mcp binary, gating the Rust-replaces-TypeScript promotion.",
    methodology: {
      typescript: "src/dispatcher dispatch() — handlers Zod-parse first; raw cases use JSON.parse to mirror the transport layer.",
      rust: "rust/target epoch-mcp binary driven with one JSON-RPC tools/call per case (one process per case for crash isolation).",
      severityModel: {
        critical: "Rust crashed or hung on input TypeScript handled.",
        high: "TypeScript rejects but Rust accepts (malformed input slips through after promotion).",
        medium: "Rust rejects but TypeScript accepts (functional regression).",
        none: "Same accept/reject polarity (compatible).",
      },
    },
    meta: {
      packageVersion: packageVersion(),
      rustBinary: binary.replace(`${REPO_ROOT}/`, ""),
      totalCases: results.length,
    },
    summary: {
      total: results.length,
      pass,
      fail,
      compatibilityRate: Number(((pass / results.length) * 100).toFixed(1)),
      bySeverity,
      byCategory,
      highSeverityDiffCount: highSeverityDiffs.length,
    },
    highSeverityDiffs: highSeverityDiffs.map((r) => ({
      id: r.id,
      category: r.category,
      tool: r.tool,
      severity: r.severity,
      diff: r.diff,
      ts: r.ts,
      rust: r.rust,
    })),
    cases: results,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  // ---- Human summary ------------------------------------------------------
  console.log("");
  console.log("Rust-vs-TypeScript adversarial compatibility QA");
  console.log("================================================");
  console.log(`Rust binary : ${report.meta.rustBinary}`);
  console.log(`Cases       : ${results.length}`);
  console.log(`Pass        : ${pass}`);
  console.log(`Fail        : ${fail}  (compatibility ${report.summary.compatibilityRate}%)`);
  console.log(
    `Severity    : critical=${bySeverity.critical} high=${bySeverity.high} medium=${bySeverity.medium}`,
  );
  console.log("");
  console.log("By category:");
  for (const [cat, c] of Object.entries(byCategory)) {
    console.log(`  ${cat.padEnd(18)} ${c.pass}/${c.total} pass`);
  }
  if (highSeverityDiffs.length > 0) {
    console.log("");
    console.log(`High-severity diffs (${highSeverityDiffs.length}):`);
    for (const r of highSeverityDiffs) {
      console.log(`  [${r.severity.toUpperCase()}] ${r.category}/${r.id} (${r.tool})`);
      console.log(`      ${r.diff}`);
      console.log(`      TS  : ${r.ts.polarity} — ${r.ts.detail}`);
      console.log(`      Rust: ${r.rust.polarity} — ${r.rust.detail}`);
    }
  }
  console.log("");
  console.log(`Report written: ${REPORT_PATH.replace(`${REPO_ROOT}/`, "")}`);

  if (strict && highSeverityDiffs.length > 0) {
    console.error("");
    console.error(`--strict: failing with ${highSeverityDiffs.length} high/critical diff(s).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[rust-adversarial] fatal:", err);
  process.exitCode = 2;
});
