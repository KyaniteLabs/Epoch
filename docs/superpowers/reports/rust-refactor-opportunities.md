# Rust Refactor Opportunities Audit

**Date:** 2026-06-25
**Branch:** `codex/rust-promo-refactor`
**Scope:** `rust/crates/` workspace (7 crates, 8 members)
**Rust edition:** 2024 (MSRV 1.93)

---

## Executive Summary

The Rust refactor is shipping-quality code with good test coverage, correct behavior,
and clean MCP/HTTP/CLI surface compliance. However, a systematic audit reveals six
categories of improvement opportunity. The most impactful are **consolidating duplicated
utility helpers** across crates and **reducing unnecessary allocations in hot paths**.

---

## 1. Duplicated Utility Functions (Highest Priority)

Six formatting/rounding helpers are independently defined in 4–6 files each.
Consolidating into a shared `epoch-core::util` module would eliminate ~200 lines of
duplication and prevent drift.

| Function    | Files where duplicated | Signature |
|-------------|-----------------------|-----------|
| `format_number` | `estimation.rs`, `temporal.rs`, `cost.rs`, `analytics.rs`, `risk.rs`, `cocomo.rs` | `fn format_number(value: f64) -> String` |
| `round1`    | `estimation.rs`, `analytics.rs`, `risk.rs`, `cost.rs`, `feedback.rs` | `fn round1(v: f64) -> f64` |
| `round2`    | `estimation.rs`, `analytics.rs`, `risk.rs`, `cost.rs`, `cocomo.rs` | `fn round2(v: f64) -> f64` |
| `round3`    | `estimation.rs`, `cocomo.rs` | `fn round3(v: f64) -> f64` |
| `median`    | `analytics.rs`, `risk.rs` | `fn median(values: Vec<f64>) -> f64` |
| `all_finite` | `estimation.rs` (only) | `fn all_finite(values: &[f64]) -> bool` |

**Recommendation:** Extract to `epoch-core::util` and re-export from `epoch-core::lib`.
All callers import via `use epoch_core::util::*`.

---

## 2. Panic / Crash Risks

| Location | Risk | Severity |
|----------|------|----------|
| `calendar.rs:294` — `NaiveDate::from_ymd_opt(…).expect("valid fixed holiday")` | Panics if an invalid date constant is added. Currently safe (all holidays use valid constants), but frays at the edges. | Low |
| `temporal.rs:240` — `and_hms_opt(0,0,0).unwrap()` | Unwrap on a `chrono::NaiveTime` construction from midnight. Always succeeds but idiomatically risky. | Low |
| `temporal.rs:207-208` — `diff_dates` falls back to Unix epoch on parse error | Silent data corruption: if both dates are unparseable, returns "0" diff with no error signal. The function returns a plain `DateDiffResult`, not `Result`, so callers can't distinguish "0 difference" from "parse failure." | **Medium** |

**Recommendation:** Change `diff_dates` to return `Result<DateDiffResult, ToolError>`.
Update the `time_math` dispatcher in `dispatcher.rs` to propagate the error.

---

## 3. Allocation Hotspots

| Module | Location | Issue |
|--------|----------|-------|
| `estimation.rs:454` | `monte_carlo_sim` allocates `Vec::with_capacity(iterations)` for up to 50k `f64` values | Acceptable but worth noting for very high iteration counts. |
| `feedback.rs:316` | `all_matched.clone()` creates a full copy of the matched records before splitting | An extra `Vec<FeedbackMatchedRecord>` allocation. |
| `feedback.rs:634-647` | `analytics_records` builds a new `Vec<HistoricalRecord>` with clone of each field | Conversion from `FeedbackMatchedRecord` to `HistoricalRecord` duplicates String fields. Could implement `From` trait or use conversion by ownership. |
| `cocomo.rs:300-311` | `dataset_groups` and `type_groups` rebuild project groups by iterating twice | Could collect in one pass. |
| `dispatcher.rs:469-495` | `historical_records` and `risk_records` each iterate and clone calibration data | Two iterators over the same data; could be deduplicated. |

**Recommendation:** Add `impl From<FeedbackMatchedRecord> for HistoricalRecord` instead of
manual cloning. Evaluate whether `all_matched.clone()` can be replaced with `.into_iter()`.

---

## 4. Clone-Heavy Patterns

The dispatcher (`dispatcher.rs`) is the largest source of unnecessary cloning:

- `required_string()` always returns an owned `String` even when the value could be borrowed.
- `value_object_to_btree()` at line 854 clones every key and value from a `&Map<String, Value>`.
- `record_feedback_candidate()` clones the entire `input` object into a `BTreeMap`.
- `historical_records()` and `risk_records()` each allocate new owned vectors despite
  both consuming the same `calibration_data()` source.
- `get_pending_estimates()` chains `.rev().take(10).rev()` — functionally correct but
  semantically noisy.

**Example hot clone:**
```rust
// dispatcher.rs:855-859
fn value_object_to_btree(object: Option<&Map<String, Value>>) -> BTreeMap<String, Value> {
    object.into_iter()
        .flat_map(|object| object.iter())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}
```
This is called for every estimate tool dispatch. If the `input` object is large, this is
redundant with the extraction that already happens in each `dispatch_*` method.

**Recommendation:** Either store `&Map` references or defer the conversion to only
the fields needed. Consider using `serde_json::Map` directly rather than converting to
`BTreeMap` then serializing again.

---

## 5. Dispatcher Maintainability

The `RustToolDispatcher` is a 900-line file with 25+ private dispatch methods sharing
a repetitive pattern:

```rust
fn dispatch_<tool>(&mut self, input: &Value) -> ToolValueResult {
    let object = object(input)?;
    let field = required_string(object, &["field", "fieldCamel"])?;
    let opt = optional_f64(object, &["opt", "optCamel"])?.unwrap_or(1.0);
    to_value(core_fn(field, opt)?)
}
```

**Specific issues:**

- **Key aliasing:** The `get()` helper (line 532) does O(n) linear search through
  snake_case and camelCase variants. This is acceptable for small lookups but
  inconsistent — some keys accept 5+ aliases (`"start_date", "date", "from_date",
  "startDate", "fromDate"`).
- **Error type friction:** The dispatcher returns `ToolValueResult` which is
  `Result<Value, ToolError>`. Core functions return their own types. Every call goes
  through `to_value(…)` which re-serializes. A `#[derive(Serialize)]` bound on domain
  types avoids this.
- **Feedback injection:** `record_feedback_candidate()` mutates the result `Value` by
  inserting a `"feedbackRef"` key. This couples estimation tools with feedback
  infrastructure. A cleaner approach would wrap results in a feedback-aware envelope.

**Recommendation:** Introduce a `From<Value>` derive or macro for input extraction.
Replace manual `optional_*` / `required_*` functions with a derive-based extractor.
Consider separating feedback envelope from tool output.

---

## 6. Error Handling Inconsistencies

| Tool / Function | Error pattern | Issue |
|----------------|--------------|-------|
| `monte_carlo_sim` | Returns error *values* (struct with `"0"` strings, not `Err`) | Inconsistent with every other tool which returns `Result<_, ToolError>`. Forces callers to check `p50 == "0"` instead of matching `Err`. |
| `add_days` | Returns `"Invalid Date"` string | Silent error — callers receive a string that looks like a date but isn't. Better to return `Result<String, ToolError>`. |
| `is_business_day` / `is_within_working_hours` | Returns `false` on parse error | Silent failure indistinguishable from legitimate `false`. |

**Recommendation:** Refactor `monte_carlo_sim` to return `Result<MonteCarloResult, ToolError>`.
Change `add_days` to return `Result<String, ToolError>` and update time_math dispatcher.

---

## 7. Idiomatic Rust Improvements

| Observation | Details |
|-------------|---------|
| `#[derive(Default)]` on `RustToolDispatcher` | Derives `Default` but `next_feedback_id` starts at 0. The `new()` method is explicit about this — good. Keep as-is. |
| `let Some(task) = ... else { continue }` pattern in `critical_path` | Three occurrences of `let Some(task) = task_map.get(name) else { continue }` which should never fail since `sorted` is derived from `task_map`. Idiomatic to use `unwrap()` or restructure to avoid. |
| `.copied()` vs `.cloned()` | Some iterator chains use `.copied()` when `Copy` is available (good), others use `.cloned()` (also fine, but `.copied()` is preferred for `Copy` types). |
| `filter_map` with `is_some` | Some chains like `filter(|x| x.is_some()).map(|x| x.unwrap())` could be simplified to `filter_map(|x| x)`. |
| Manual `Vec` construction in `compare_models` | The ASCII table at lines 294-306 builds a `Vec<String>` and joins. Could use a `write!` macro or `format!` with a folding pattern. |

---

## 8. Test Coverage Gaps

| Module | Gap |
|--------|-----|
| `temporal.rs` | `parse_duration` and `format_elapsed` lack edge-case tests for extreme values (e.g., very large durations, overflow scenarios). |
| `calendar.rs` | Holiday functions are unit-tested only indirectly through business-day tests. Individual holiday lists (UK, FR, DE, JP) have no dedicated coverage. |
| `monte_carlo_sim` | No test for edge case where `iterations == 1` producing a single-value result. |
| `format_number` | No dedicated test covering the various rounding/trailing-zero behaviors. |

---

## Recommended Action Plan

| Priority | Task | Effort | Risk |
|----------|------|--------|------|
| P0 | Consolidate `format_number`, `round1/2/3`, `median` into `epoch-core::util` | Medium | Low |
| P1 | Fix `diff_dates` to return `Result` (panic-risk item) | Small | Low |
| P1 | Fix `monte_carlo_sim` to return `Result` (consistency) | Small | Low-Medium |
| P2 | Add `From<FeedbackMatchedRecord>` impl to replace manual `analytics_records` | Small | Low |
| P2 | Remove `clone()` in `all_matched` by using `into_iter()` | Trivial | Low |
| P3 | Derive-based input extractor for dispatcher | Large | Medium |
| P3 | Separate feedback envelope from tool results | Large | Medium |

---

## Appendix: File Inventory

| Crate | Files | Lines (approx) | Role |
|-------|-------|-----------------|------|
| `epoch-contract` | `lib.rs`, `registry.rs` | 950 | Shared types, tool registry |
| `epoch-core` | 8 source files | 2600 | Domain logic (estimation, analytics, cost, risk, cocomo, calendar, temporal, feedback) |
| `epoch-data` | `lib.rs` | 170 | Bundled data loaders |
| `epoch-mcp` | `main.rs`, `lib.rs`, `protocol.rs`, `dispatcher.rs` | 1120 | MCP runtime and tool dispatcher |
| `epoch-cli` | `main.rs`, `lib.rs` | 340 | CLI entrypoint and command routing |
| `epoch-http` | `main.rs`, `lib.rs` | 310 | HTTP entrypoint and routing |
| `epoch-canary` | `lib.rs` | 15 | Integration test canary |
| `xtask` | `main.rs` | 40 | Dev workflow helper |
