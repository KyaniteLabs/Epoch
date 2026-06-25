# Rust ↔ TypeScript parity — residual gaps beyond the golden gate

**Status:** `promotion:rust-parity:gate` is at **100% output parity (26/26)** and
**100% error compatibility (7/7)** as of this change. The notes below record
**pre-existing** divergences that the golden case set does **not** exercise, so
they remain open for a future promotion pass. They were surfaced by running both
runtimes on novel inputs (not in `src/contract/rust-parity-cases.ts`).

These are not regressions from the gate-closing work in this branch — the cores
involved (`estimation.rs`, the reference-class correction factor) were not
modified here.

## 1. PERT confidence bounds — ±0.01 rounding order

`pert_estimate` confidence bounds can differ by a single cent of rounding for
some optimistic/most-likely/pessimistic combinations.

- Example: `{optimistic: 2, most_likely: 5, pessimistic: 10}` →
  TS `confidence95[0] = 2.67`, Rust `2.66`.
- Root cause: TS and Rust round the bound (`expected ± 2·stdDev`) at slightly
  different points in the arithmetic. The golden cases (`1/2/4`, `3/5/12`) land
  on values where both round identically, so the gate stays green.
- Fix shape: align `estimation.rs` PERT bound rounding with `src/lib/estimation.ts`
  (round the final bound, not the intermediates), then add a golden case that
  pins a `.xx5` boundary.

## 2. reference_class_estimate correctedEstimate — DB vs. hardcoded factors

For **non-AI-native** calls (`ai_native < 0.7`), `correctedEstimate` diverges
because TS reads per-task-type / per-complexity correction factors from the
reference database (`getCorrectionFactorForTaskType`), while Rust uses the
hardcoded `industry_correction_factor` table.

- Example: `{task_type: "feature", complexity: 4, scope: "large", ai_native: 0.5}`
  → TS `correctedEstimate = 12.7` (DB factor ≈ 1.0), Rust `22.9` (industry 1.8).
- The golden reference case uses `ai_native = 1.0`, which takes the AI-native
  baseline path (correction factor `1.0` in both runtimes), so the gate does not
  see this.
- This is the same family as the global-correction-factor fix in this branch
  (`epoch_data::resolve_global_correction_factor`): the remaining step is to
  port the per-task-type / per-complexity factor lookup (`taskTypeCorrectionFactors`,
  `toolTaskCorrectionFactors`, `complexityCorrectionFactors`) into the Rust
  reference-class path, reading the same resolved reference database.

## Recommended next step

Extend `src/contract/rust-parity-cases.ts` with golden cases covering hybrid /
human `ai_native` and the PERT rounding boundary, then close the two gaps above
so the broadened gate stays at 100%.
