# Rust Promotion Parity - Harness & Current Verdict

**Status:** parity gate passing; Rust port is not yet replacement-ready until the
durable soak and qualified performance gates pass.
**Date:** 2026-06-27
**Owner surface:** `src/contract/rust-parity*.ts`, `pnpm run promotion:rust-parity`

## What this is

A repo-owned harness that executes all **24 Epoch public tools** on identical
inputs against **both** runtimes and reports a machine-readable parity verdict:

- **TypeScript** - the in-process tool handler from the dispatcher registry
  (`src/dispatcher/tool-registry.ts`), the same code the MCP/CLI/HTTP surfaces call.
- **Rust** - the compiled `epoch-cli` binary (`rust/crates/epoch-cli`), one child
  process per case.

The harness lives at:

| File | Role |
| --- | --- |
| `src/contract/rust-parity-cases.ts` | 43 bounded golden cases (24/24 tools, success paths, error paths, branch cases) |
| `src/contract/rust-parity.ts` | execution, normalization, comparison, report builder |
| `src/contract/rust-parity-cli.ts` | CLI entry, machine-readable JSON report, promotion gate |
| `src/contract/rust-parity.test.ts` | focused vitest coverage for helpers and gated integration |

## How to run

```bash
# Build the Rust CLI once (or set EPOCH_RUST_CLI=/path/to/epoch-cli):
cargo build --manifest-path rust/Cargo.toml -p epoch-cli --release

# Smoke (report-only): verifies the harness runs both runtimes end-to-end.
pnpm run promotion:rust-parity

# Strict promotion gate: exits non-zero unless structured output, errors, and
# tracked narrative fields all match the TypeScript oracle.
pnpm run promotion:rust-parity:gate
```

The JSON report carries: `totalCases`, `matchedCases`, `outputParityPercent`,
`errorCompatibilityPercent`, `narrativeParityPercent`, `toolsCovered`, `diffs[]`,
and `narrativeDiffs[]`.

## Normalization

The harness normalizes only documented non-contractual variation:

- `feedbackRef` - both runtimes mint estimate ids differently; stripped everywhere.
- Wall-clock values - `get_current_time` is compared by key/type shape, not values.
- Floating point - numbers compared with relative+absolute tolerance (1e-6).
- Empty feedback store - `EPOCH_DATA_DIR` is pointed at a fresh temp dir so
  stateful tools see no history, matching Rust's fresh in-memory dispatcher.

Seeded Monte Carlo is compared by value: both runtimes implement the identical
LCG (`16807 / 2147483647`) and triangular sampler, so a shared seed yields
identical results.

## Current Verdict

Latest strict run, release Rust CLI:

```text
tools covered:         24/24
total cases:           43
matched cases:         43/43
output parity:         100% (34/34)
error compatibility:   100% (9/9)
narrative parity:      100% (24/24)
semantic diffs:        0
narrative diffs:       0
```

The original 2026-06-25 parity blockers are resolved in the current harness.
The harness was strengthened with branch cases for:

- alternate `time_math` operations (`convert_tz`, `parse_nl`)
- backward business-day math
- invalid critical-path predecessor graphs
- zero-iteration Monte Carlo rejection
- custom sprint capacity inputs
- model comparison sorted by time
- unknown-model token-cost estimates with tool-call overhead

## Latest Fix

The expanded `token_cost_estimate/unknown-with-tools` case exposed a parity bug:
TypeScript uses the reference database `_default` token-time calibration for
unknown models, while Rust had kept the hardcoded 75 TPS fallback at the MCP
boundary.

Rust now mirrors the TypeScript rule:

- model-specific reference DB token-time calibration may override a model profile
- `_default` token-time calibration applies only when the model is unknown
- isolated core calls still preserve the hardcoded fallback unless the dispatcher
  injects external calibration

## Replacement Gate

Passing this parity harness is necessary but not sufficient to replace the
TypeScript runtime. Replacement still requires the promotion ledger to prove the
separate readiness gates, including durable clean soak time and release-tagged
qualified non-smoke performance evidence.
