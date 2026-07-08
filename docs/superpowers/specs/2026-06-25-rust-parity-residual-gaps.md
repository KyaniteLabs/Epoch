# Rust ↔ TypeScript parity — residual gap closure

**Status:** closed in the Rust promotion branch. The residual divergences below
were originally found on novel inputs outside `src/contract/rust-parity-cases.ts`.
They are now covered by golden parity cases, so `promotion:rust-parity:gate`
protects them directly.

## Closed gaps

### 1. PERT confidence-bound rounding

`pert_estimate` now matches the TypeScript oracle for confidence bounds by
rounding the final bound, not by rounding `expected` before the bound is
computed.

Protected by:

- `pert_estimate/confidence-rounding-boundary` in `src/contract/rust-parity-cases.ts`
- `pert_confidence_bounds_use_unrounded_expected_value` in `rust/crates/epoch-core/src/estimation.rs`

### 2. Reference-class sparse correction factors

`reference_class_estimate` now uses the same sparse-data correction factor
priority as TypeScript for non-AI-native calls: complexity-specific, then
tool-specific, then task-type, then canary-derived fallback, then industry
fallback.

Protected by:

- `reference_class_estimate/feature-large-hybrid` in `src/contract/rust-parity-cases.ts`
- `resolves_reference_correction_factor_with_typescript_priority_order` in `rust/crates/epoch-data/src/lib.rs`
- `reference_class_accepts_sparse_reference_database_correction_factor` in `rust/crates/epoch-core/src/analytics.rs`

## Current rule

When a novel input reveals a Rust-vs-TypeScript divergence, add it to the golden
parity corpus before closing the implementation gap. A residual note is not a
promotion waiver.
