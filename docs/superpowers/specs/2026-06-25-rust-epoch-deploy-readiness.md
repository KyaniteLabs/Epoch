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

### 3. Binary Identity Gate

Promotion evidence must identify the exact Rust binary that produced the parity and soak observations.

Thresholds:

- `CANARY` requires a valid `rustBinarySha256` attached to the readiness evidence.
- `REPLACE` requires the same binary identity, and cumulative soak ledgers must contain exactly one Rust binary hash.

### 4. Performance Gate

Rust must be materially better than TypeScript before replacement.

Metrics:

- Median latency improvement.
- p95 latency improvement.
- Startup time improvement.
- Memory footprint improvement.

Thresholds:

- `CANARY` requires at least 10% median latency improvement and no regression greater than 5% on p95 or memory.
- `REPLACE` requires at least 20% median latency improvement, at least 10% p95 improvement, and no regression in startup or memory.

Raw benchmark reports fail closed when p95, startup, or memory measurements are missing. Missing evidence is not treated as zero regression.

### 5. Soak Reliability Gate

Rust must survive sustained use without data loss, panics, or contract drift.

Thresholds:

- `CANARY` requires at least 24 total measured soak hours and a 24-hour continuous clean soak window with zero crashes and zero data-loss incidents.
- `REPLACE` requires at least 72 total measured soak hours and a 72-hour continuous clean soak window with zero crashes, zero data-loss incidents, and no unresolved telemetry anomalies.

### 6. Rollback Gate

Rollback must be simple and tested.

Thresholds:

- `CANARY` requires a validated rollback that completes in one deploy step.
- `REPLACE` requires rollback evidence from a successful rehearsal and a recovery point that preserves local state.

### 7. Observability Gate

Rust must expose enough signal to prove correctness and diagnose regressions.

Thresholds:

- `CANARY` requires tool-level metrics, parity-failure attribution, and local-state event tracing.
- `REPLACE` requires the same plus release-tagged comparisons against the TypeScript oracle.

## Required Inputs

Readiness decisions are computed from parity and performance evidence:

- `parity.json` for contract, output, error, soak, rollback, and observability evidence.
- `perf.json` for latency, startup, and memory evidence.

The scorer (`pnpm run contract:rust-readiness`) accepts either a single combined `readiness.json` with top-level `parity` and `perf` keys, or the two evidence files passed separately. It emits the decision, the first failing gate, and a short rationale that can be pasted into a release note.

For `CANARY` or `REPLACE`, parity evidence must include `rustBinarySha256`, either at `parity.rustBinarySha256` or in the raw packet metadata. Missing or malformed binary identity keeps the decision in `SHADOW`.

## Promotion Packet Workflow

Use the packet command to generate the evidence chain in one local, repeatable run:

```bash
pnpm run promotion:rust-packet -- --iterations 3
```

The command writes a git-ignored packet under `.epoch-promotion/latest/` by default:

- `parity.json` from the strict TypeScript-vs-Rust parity gate.
- `perf.json` from the promotion benchmark smoke run.
- `shadow-soak.json` from repeated hidden TypeScript-oracle comparisons, including `soakHours`, `continuousSoakHours`, and the SHA-256 of the Rust binary under test.
- `shadow-soak-rollback.json` after the rollback rehearsal enriches the parity evidence.
- `readiness-input.json`, `readiness-assessment.json`, and `promotion-packet.json`.

For replacement readiness, release-tag the comparison run:

```bash
pnpm run promotion:rust-packet -- --iterations 3 --release-tag <release-or-commit-id>
```

`--release-tag` raises the observability evidence to `release` only for that packet. It does not override the soak gate; `CANARY` still requires at least 24 measured hours with a 24-hour continuous clean window, and `REPLACE` still requires at least 72 measured hours with a 72-hour continuous clean window, zero crashes, zero data-loss incidents, and zero unresolved telemetry anomalies.

To accumulate soak across multiple packet runs, append each packet to the local soak ledger:

```bash
pnpm run promotion:rust-soak-ledger -- --packet-dir .epoch-promotion/latest
```

The ledger writes cumulative readiness artifacts next to the packet by default:

- `.epoch-promotion/soak-ledger.json` stores every measured packet run.
- `readiness-input-cumulative.json` sums measured soak hours and failures, then uses the longest clean continuous window as `continuousSoakHours`.
- `readiness-assessment-cumulative.json` scores the cumulative evidence with the same deploy-readiness gates.
- `soak-ledger-summary.json` shows total soak hours, continuous clean soak hours, continuity lost to gaps, release-tagged soak hours, latest run, and current decision.

The ledger is conservative:

- It sums crashes, data-loss incidents, unresolved telemetry anomalies, and unclassified failures across all runs.
- It uses the worst observed compatibility and performance percentages across all runs.
- It fails closed if any run is missing `rustBinarySha256` or if runs from different Rust binary hashes are mixed in one ledger.
- It only credits clean contiguous observation windows toward `continuousSoakHours`; orchestration gaps up to 120 seconds can preserve continuity but do not earn soak credit.
- It counts rollback as ready only after at least one successful rehearsal.
- It reports `observabilityLevel: release` only when all accumulated soak hours came from release-tagged comparison packets.

To keep a long soak resumable, use the runner instead of hand-looping packet plus ledger commands:

```bash
pnpm run promotion:rust-soak-runner -- --target canary --max-runs 1 --release-tag <release-or-commit-id>
```

The runner starts at most one packet by default, appends it to `.epoch-promotion/soak-ledger.json`, and writes `.epoch-promotion/latest/soak-runner-summary.json`. For real canary or replacement evidence, prefer one supervised long invocation with `--until-target`; optionally pair it with `--max-runs` as a safety cap. Manual restarts separated by more than the ledger's 120-second continuity gap increase `continuityLostHours` and do not advance the continuous soak gate. `--until-target` keeps running only while the first blocker is `soak`; if compatibility, performance, rollback, observability, or binary identity blocks promotion, it stops with `stopReason: "non-soak-gate-blocked"`. Re-run only until the summary reports `targetReached: true`. `targetReached` is scorer-only deployment evidence; a local smoke override can only set `smokeTargetReached`. Keep the ledger outside `--packet-dir`; packet directories are cleaned before each packet run.

Before canarying or replacing TypeScript, run the final promotion gate against the runner summary:

```bash
pnpm run promotion:rust-gate -- --target canary
```

For a long replacement-target runner that is still active, check the cumulative ledger summary without waiting for the final runner summary:

```bash
pnpm run promotion:rust-gate -- --target canary --ledger .epoch-promotion/soak-ledger.json
```

The gate exits 0 only when the strict scorer reached the requested target, the Rust binary SHA-256 is present, the current deploy binary hash matches the soak evidence, the required total and continuous soak hours are present, and replacement evidence is release-tagged. `--ledger` reads the durable cumulative ledger directly; `--ledger-summary` is also available for a previously written cumulative summary. Runner summaries are additionally rejected if they were produced with `--target-hours`. By default the gate hashes `rust/target/release/epoch-cli`; pass `--rust-binary <path>` when deployment uses a packaged binary at a different path.

A replacement-target runner summary may be checked against the canary gate; this lets one long replacement soak unlock canary as soon as the strict scorer reaches `CANARY`, while still failing closed until it later reaches `REPLACE`.

The runner uses `.epoch-promotion/soak-runner.lock` to prevent double-counting from overlapping runners and `.epoch-promotion/soak-runner-state.json` as an in-progress sentinel. If a previous runner died before cleanup, the next invocation fails closed until the interrupted run is investigated.

While a long soak is active, monitor the durable ledger without touching the in-progress packet directory:

```bash
pnpm run promotion:rust-soak-status -- --ledger .epoch-promotion/soak-ledger.json
```

The status command is read-only. It reports whether the recorded runner process is active, completed soak hours, continuous clean soak hours, the continuity-gap threshold, release-tagged soak, remaining canary/replacement hours, the Rust binary hash, and any ledger warnings.

For replacement evidence, the runner requires a release tag:

```bash
pnpm run promotion:rust-soak-runner -- --target replace --release-tag <release-or-commit-id> --max-runs 1
```

`--target-hours` is only for local smoke tests of the runner path. Production promotion still depends on the deploy-readiness scorer's fixed 24-hour canary and 72-hour replacement gates, and deployment automation must ignore `smokeTargetReached`.
