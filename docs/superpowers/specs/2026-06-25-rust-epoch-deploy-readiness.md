# Rust Epoch Deploy Readiness Scorecard

- **Date:** 2026-06-25
- **Status:** Draft readiness spec for the Rust replacement program
- **Applies to:** TypeScript Epoch -> Rust Epoch migration

This spec defines the deploy-readiness gate for replacing the current TypeScript Epoch server with a Rust implementation. It turns parity and performance evidence into a single decision with explicit thresholds.

## Decisions

- `NO`: Rust is not ready for any external exposure.
- `SHADOW`: Rust may run only in hidden comparison mode.
- `CANARY`: Rust may serve a limited slice of real traffic with rollback in place.
- `REPLACE`: Rust may become the default implementation.

## Readiness Rules

The decision is the highest tier whose gates are all satisfied. The scorer reports that decision plus the first gate blocking the next promotion, so the ladder can never advance past an unmet gate.

### 1. Parity Gate

Rust must match the TypeScript oracle on the public contract:

- MCP tool names: 24/24 exact match.
- Write tools: `record_actual` and `batch_record_actuals` preserved.
- HTTP routes: 11/11 exact match.
- CLI command paths: 39/39 exact match.

Thresholds:

- `NO` if any public-surface mismatch exists.
- `SHADOW` if public-surface parity is complete but tool output parity is below 99.5%.
- `CANARY` if tool output parity is at least 99.5% across the agreed fixture suite.
- `REPLACE` if parity is 100% across the full fixture suite with the compatibility exceptions explicitly approved.

### 2. Error and Output Compatibility Gate

Requirements:

- Response envelope shape matches the TypeScript implementation.
- Error messages remain actionable and include the same retry semantics.
- Field names stay stable for documented outputs.

Thresholds:

- `SHADOW` is the floor once the public surface matches, even while envelope and field compatibility are still being closed out.
- `CANARY` requires at least 99.5% pass rate with no unclassified failures.
- `REPLACE` requires 100% pass rate on the approved compatibility suite with the exception record signed off.

### 3. Performance Gate

Rust must be materially better than TypeScript before replacement.

Metrics:

- Median latency improvement.
- p95 latency improvement.
- Startup time improvement.
- Memory footprint improvement.

Thresholds:

- `CANARY` requires at least 10% median latency improvement and no regression greater than 5% on p95 or memory.
- `REPLACE` requires at least 20% median latency improvement, at least 10% p95 improvement, and no regression in startup or memory.

### 4. Soak Reliability Gate

Rust must survive sustained use without data loss, panics, or contract drift.

Thresholds:

- `CANARY` requires at least 24 hours of soak with zero crashes and zero data-loss incidents.
- `REPLACE` requires at least 72 hours of soak with zero crashes, zero data-loss incidents, and no unresolved telemetry anomalies.

### 5. Rollback Gate

Rollback must be simple and tested.

Thresholds:

- `CANARY` requires a validated rollback that completes in one deploy step.
- `REPLACE` requires rollback evidence from a successful rehearsal and a recovery point that preserves local state.

### 6. Observability Gate

Rust must expose enough signal to prove correctness and diagnose regressions.

Thresholds:

- `CANARY` requires tool-level metrics, parity-failure attribution, and local-state event tracing.
- `REPLACE` requires the same plus release-tagged comparisons against the TypeScript oracle.

## Required Inputs

Readiness decisions are computed from parity and performance evidence:

- `parity.json` for contract, output, error, soak, rollback, and observability evidence.
- `perf.json` for latency, startup, and memory evidence.

The scorer (`pnpm run contract:rust-readiness`) accepts either a single combined `readiness.json` with top-level `parity` and `perf` keys, or the two evidence files passed separately. It emits the decision, the first failing gate, and a short rationale that can be pasted into a release note.

## Promotion Packet Workflow

Use the packet command to generate the evidence chain in one local, repeatable run:

```bash
pnpm run promotion:rust-packet -- --iterations 3
```

The command writes a git-ignored packet under `.epoch-promotion/latest/` by default:

- `parity.json` from the strict TypeScript-vs-Rust parity gate.
- `perf.json` from the promotion benchmark smoke run.
- `shadow-soak.json` from repeated hidden TypeScript-oracle comparisons.
- `shadow-soak-rollback.json` after the rollback rehearsal enriches the parity evidence.
- `readiness-input.json`, `readiness-assessment.json`, and `promotion-packet.json`.

For replacement readiness, release-tag the comparison run:

```bash
pnpm run promotion:rust-packet -- --iterations 3 --release-tag <release-or-commit-id>
```

`--release-tag` raises the observability evidence to `release` only for that packet. It does not override the soak gate; `CANARY` still requires at least 24 measured soak hours, and `REPLACE` still requires at least 72 measured soak hours with zero crashes, zero data-loss incidents, and zero unresolved telemetry anomalies.
