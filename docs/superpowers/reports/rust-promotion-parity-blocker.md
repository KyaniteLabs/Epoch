# Rust Promotion Parity — Harness & Blockers

**Status:** harness operational; Rust port **not yet promotable** (9 semantic gaps).
**Date:** 2026-06-25
**Owner surface:** `src/contract/rust-parity*.ts`, `pnpm run promotion:rust-parity`

## What this is

A repo-owned harness that executes all **24 Epoch public tools** on identical
inputs against **both** runtimes and reports a machine-readable parity verdict:

- **TypeScript** — the in-process tool handler from the dispatcher registry
  (`src/dispatcher/tool-registry.ts`), the same code the MCP/CLI/HTTP surfaces call.
- **Rust** — the compiled `epoch-cli` binary
  (`rust/crates/epoch-cli`), one child process per case.

The harness lives at:

| File | Role |
| --- | --- |
| `src/contract/rust-parity-cases.ts` | 33 bounded golden cases (≥1 per tool, success + error paths) |
| `src/contract/rust-parity.ts` | execution, normalization, comparison, report builder |
| `src/contract/rust-parity-cli.ts` | CLI entry → machine-readable JSON report + gate |
| `src/contract/rust-parity.test.ts` | focused vitest coverage (helpers + gated integration) |

## How to run

```bash
# Build the Rust CLI once (or set EPOCH_RUST_CLI=/path/to/epoch-cli):
cargo build --manifest-path rust/Cargo.toml -p epoch-cli --release

# Smoke (report-only): verifies the harness runs both runtimes end-to-end.
# Exit 0 when operationally healthy; prints the JSON report + summary.
pnpm run promotion:rust-parity

# Strict promotion gate: exit 1 until output parity AND error compatibility
# both reach 100%.
pnpm run promotion:rust-parity:gate
```

The JSON report carries: `totalCases`, `matchedCases`, `outputParityPercent`,
`errorCompatibilityPercent`, `narrativeParityPercent`, `toolsCovered`,
`diffs[]` (gating), and `narrativeDiffs[]` (informational).

## Normalization (expected nondeterminism)

To keep the signal honest, the harness normalizes only genuinely non-contractual
variation before comparing:

- **`feedbackRef`** — both runtimes mint estimate ids differently; stripped everywhere.
- **Wall-clock values** — `get_current_time` is compared by key/type *shape*, not values.
- **Floating point** — numbers compared with relative+absolute tolerance (1e-6).
- **Empty feedback store** — `EPOCH_DATA_DIR` is pointed at a fresh temp dir so
  stateful tools see no history, matching Rust's fresh in-memory dispatcher.
- **Narrative fields** (`humanReadable`, `summary`) — free-text presentation
  strings. Compared and reported as `narrativeParityPercent`, but **excluded
  from the gate**. The structured fields are the contract.

Seeded Monte Carlo is compared **by value**: both runtimes implement the identical
LCG (`16807 / 2147483647`) and triangular sampler, so a shared seed yields
identical results — verified by the `monte_carlo_schedule/seeded` case.

## Current verdict (2026-06-25, release build)

```
tools covered:        24/24
total cases:          33
output parity (gate): 65.4%  (17/26)
error compatibility:  100%   (7/7)
narrative parity:     72.2%  (13/18)  — informational
```

Error compatibility is already **100%**: every invalid input both runtimes reject
together (PERT ordering, empty critical path, bad timezone, missing required
fields, garbage durations, non-positive KLOC).

## Blockers to 100% semantic parity (9)

These are real divergences in the Rust port, not harness artifacts. Each must be
closed (or explicitly accepted) before the Rust runtime can be promoted.

| # | Tool(s) | Gap | Fix direction |
| --- | --- | --- | --- |
| 1 | `time_math` (diff) | TS emits `total_seconds` (snake_case); Rust emits `totalSeconds`. | Align the field name. The TS `diffDates` output is the odd one out vs the otherwise-camelCase contract — likely fix TS to `totalSeconds`, then re-snapshot. |
| 2 | `pert_estimate` | TS adds `developerProfile` + `adjustedEstimate`; Rust omits both. | Port the developer-profile gradient enrichment to the Rust estimation path. |
| 3 | `cocomo_estimate` | TS adds `developerProfile`; Rust omits. | Same enrichment port. |
| 4 | `sprint_forecast` | TS adds `developerProfile`; Rust omits. | Same enrichment port. |
| 5 | `reference_class_estimate` | TS adds `developerProfile`, `adjustedEstimate`, `note`, `scopeGuide`; Rust omits. | Port scope-guide + profile enrichment. |
| 6 | `calibrate_estimates` | `correctionFactor` TS `1` vs Rust `1.07`. | TS returns a neutral factor on an empty store; Rust applies the reference-DB baseline (1.07). Decide the canonical zero-data behavior and align. |
| 7 | `compare_models` | `models[0].estimatedCost` TS `0.0004` vs Rust `0.0003` (rounding → also shifts sort order). | Align cost rounding (and therefore the sort) between ports. |
| 8 | `cocomo_ground_truth` | Hybrid/ai_native model `bias`/`mape` differ slightly (e.g. `-86.99` vs `-86.62`). | Align the AI-profile adjustment math in the Rust ground-truth model. |

> The developer-profile enrichment (#2–#5) is one root cause spanning four tools:
> the TypeScript dispatcher handlers attach `getDeveloperProfileGradient(...)`
> output that the Rust dispatcher does not. Closing it lifts four cases at once.

## Narrative (non-gating) differences (5)

Cosmetic presentation-string differences, tracked but not blocking:

- `token_time_bridge` — `humanReadable` thousands separator (`1,200` vs `1200`).
- `compare_models` — `humanReadable` table ordering + cost rounding.
- `cocomo_validate` / `cocomo_ground_truth` — `humanReadable` lists rendered in
  `BTreeMap` (alphabetical) vs insertion order.
- `get_pending_estimates` — `summary` em-dash (`—`) vs hyphen (`-`).

These should be reconciled before a user-facing Rust release, but they do not
affect the structured tool contract.

## Promotion criteria

Promote the Rust runtime when `pnpm run promotion:rust-parity:gate` exits 0, i.e.
`outputParityPercent === 100` and `errorCompatibilityPercent === 100` across the
golden cases. Re-run after each Rust change; add golden cases as new behaviors land.
