# 15 — Unknown-model fallback honesty + dead telemetry lookup

**What to build:** Unknown LLM models get the documented generic default throughput (not the bundled raw-benchmark 1685.9 tps — 22× the design default) with a confidence label reflecting provenance rather than `tps !== 75` magic. The dead per-model telemetry lookup (16 full file reads per compare_models that can never match because `model` is never recorded) is either fed real data (record the model field) or deleted. The dead `llmModelEnum` is wired in or removed, and the stale model type regenerates from the live table.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Unknown model tps == documented default; confidence label reflects data provenance
- [ ] Model field recorded by token tools (or lookup removed) — call-count/read-count assertion on compare_models
- [ ] llmModelEnum either validates model inputs (with unknown-model escape hatch) or is deleted; LLMModel type regenerated from the live calibration table (16 models)
- [ ] Test covers the shipped-reference-DB path (no longer mocks it to null)
