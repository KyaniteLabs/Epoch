// ---------------------------------------------------------------------------
// Epoch — TypeScript ↔ Rust Parity Harness: CLI entry
//
// Runs the parity harness and emits a machine-readable JSON report on stdout.
//
//   pnpm run promotion:rust-parity                 # smoke: report-only, gated
//                                                  #   on operational health
//   tsx src/contract/rust-parity-cli.ts            # strict promotion gate
//                                                  #   (requires 100% parity)
//   ... --min-output 95 --min-error 100            # custom thresholds
//   ... --quiet                                    # JSON only, no summary
//
// Exit codes:
//   0  harness healthy and (unless --report-only) parity thresholds met
//   1  operational failure (missing binary, a should-pass case errored,
//      incomplete tool coverage) OR parity below thresholds
//
// Build the binary first: cargo build --manifest-path rust/Cargo.toml \
//   -p epoch-cli --release   (or set EPOCH_RUST_CLI=/path/to/epoch-cli)
// ---------------------------------------------------------------------------

import { runRustParity, type ParityReport } from "./rust-parity.js";

const EXPECTED_TOOL_COUNT = 24;

interface CliOptions {
  minOutput: number;
  minError: number;
  reportOnly: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    minOutput: 100,
    minError: 100,
    reportOnly: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--min-output") {
      options.minOutput = Number(argv[++i]);
    } else if (arg === "--min-error") {
      options.minError = Number(argv[++i]);
    } else if (arg === "--report-only") {
      options.reportOnly = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: rust-parity-cli [--report-only] [--min-output PCT] " +
          "[--min-error PCT] [--quiet]\n",
      );
      process.exit(0);
    }
  }
  return options;
}

function summarize(report: ParityReport): string {
  const lines: string[] = [];
  lines.push("Epoch TypeScript ↔ Rust parity");
  lines.push(`  rust binary:           ${report.rustBinary ?? "MISSING"}`);
  lines.push(`  tools covered:         ${report.toolsCovered.length}/${EXPECTED_TOOL_COUNT}`);
  lines.push(`  total cases:           ${report.totalCases}`);
  lines.push(`  matched cases:         ${report.matchedCases}/${report.totalCases}`);
  lines.push(
    `  output parity (gate):  ${report.outputParityPercent}% ` +
      `(${report.outputMatched}/${report.outputCases})`,
  );
  lines.push(
    `  error compatibility:   ${report.errorCompatibilityPercent}% ` +
      `(${report.errorMatched}/${report.errorCases})`,
  );
  lines.push(
    `  narrative parity:      ${report.narrativeParityPercent}% ` +
      `(${report.narrativeMatched}/${report.narrativeCases}) — informational`,
  );
  if (report.diffs.length) {
    lines.push(`  semantic diffs (${report.diffs.length}):`);
    for (const diff of report.diffs) {
      lines.push(`    - [${diff.kind}] ${diff.case} (${diff.tool}): ${diff.detail}`);
    }
  }
  if (report.narrativeDiffs.length) {
    lines.push(`  narrative diffs (${report.narrativeDiffs.length}) — not gating:`);
    for (const diff of report.narrativeDiffs) {
      lines.push(`    - ${diff.case} (${diff.tool})`);
    }
  }
  return lines.join("\n");
}

/** Operational problems that always fail, independent of parity thresholds. */
function operationalFailures(report: ParityReport): string[] {
  const failures: string[] = [];
  if (!report.rustBinary) {
    failures.push(
      "Rust binary not found — build it: cargo build --manifest-path rust/Cargo.toml -p epoch-cli --release",
    );
  }
  if (report.toolsCovered.length < EXPECTED_TOOL_COUNT) {
    failures.push(
      `incomplete tool coverage: ${report.toolsCovered.length}/${EXPECTED_TOOL_COUNT}`,
    );
  }
  const crashed = report.diffs.filter((d) => d.kind === "unexpected-error");
  if (crashed.length) {
    failures.push(
      `${crashed.length} should-pass case(s) errored: ${crashed
        .map((d) => d.case)
        .join(", ")}`,
    );
  }
  return failures;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const report = runRustParity();

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet) {
    process.stderr.write(`\n${summarize(report)}\n`);
  }

  const failures = operationalFailures(report);

  if (!options.reportOnly) {
    if (report.outputParityPercent < options.minOutput) {
      failures.push(
        `output parity ${report.outputParityPercent}% < required ${options.minOutput}%`,
      );
    }
    if (report.errorCompatibilityPercent < options.minError) {
      failures.push(
        `error compatibility ${report.errorCompatibilityPercent}% < required ${options.minError}%`,
      );
    }
  }

  if (failures.length) {
    process.stderr.write(`\nPARITY ${options.reportOnly ? "SMOKE" : "GATE"} FAILED:\n  - ${failures.join("\n  - ")}\n`);
    process.exit(1);
  }

  if (!options.quiet) {
    const label = options.reportOnly
      ? `PARITY SMOKE PASSED (harness healthy; semantic gate at ${report.outputParityPercent}%)`
      : "PARITY GATE PASSED";
    process.stderr.write(`\n${label}\n`);
  }
}

main();
