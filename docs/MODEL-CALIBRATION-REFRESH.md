# Model-calibration refresh runbook (S4.1 model-table freshness)

The bundled model calibration table (`data/model-calibrations.json`, consumed
via `src/lib/model-calibration-table.ts` as `MODEL_CALIBRATIONS`) carries
stamped data: every entry has `measured_at` (ISO date the values were last
set/measured) and `provenance` (`kind` + `source`, plus an honesty `note` for
placeholders). Stale tables bias every `token_time_bridge` /
`token_cost_estimate` estimate silently — this runbook is the zero-cost,
fail-closed path for keeping it fresh between releases.

## Cadence + tripwires

- Target cadence: **quarterly** (roadmap #4 policy), or on any major model launch.
- `epoch data status` prints the table's `refreshedAt`, `ageDays`, `stale`
  (>90d), per-entry stale list, and the placeholder entry list.
- The growth-side weekly sweep (`tools/contest-watch.sh`) flags
  `MODEL-TABLE-AGE` when the table's last value refresh is older than 90 days.

## Sources (approved, zero-cost, public — no API keys, no spend)

The approved source class is the supplementary-DB `llmBenchmarks` list
(`data/supplementary-database.json` → `sources.llmBenchmarks`):

| Source | What it measures | Cost |
| --- | --- | --- |
| Artificial Analysis (artificialanalysis.ai) | output tokens/s, TTFT, latency per model | free public pages |
| BenchLM.ai, LLMversus, SaltTechno | throughput/latency benchmarks | free public pages |
| Official provider pages (Anthropic/OpenAI/Google/Meta/Mistral/DeepSeek) | model specs | free public pages |

What was actually used for the stamps in this repo today:

- The 12 `curated` entries carry the repo's own curated-aggregate citation
  (`sources.curatedBenchmarks`), value-refreshed 2026-07-09 (Phase 5). They
  are NOT fresh primary-source re-measurements and say so in their stamp.
- The 4 `placeholder` entries (`claude-haiku-4-5`, `claude-opus-4-8`,
  `claude-sonnet-5`, `claude-fable-5`) are sibling-figure copies, marked
  `kind: "placeholder"` with the sibling named in `provenance.source`.
- Community records: `data/schemas/model-calibration.schema.json` is the
  ingestion schema; community files land in `data/community/`.

## Procedure

1. **Collect a snapshot (zero-cost).** Open the public page(s) above in a
   browser, save the per-model numbers as a JSON snapshot of community-schema
   records (or full stamped-table records for new models). Record the fetch
   date and page URL in each record's `measured_at` / `benchmark_source`.
2. **Dry-run the refresh** (no write, full validation, diff + receipt):

   ```sh
   node scripts/refresh-model-calibrations.mjs \
     --input path/to/snapshot.json --dry-run
   ```

   Community records in `data/community/` are picked up automatically.
3. **Review the diff.** Each changed entry prints old → new values with its
   source and `measured_at`. Community-schema records refresh ONLY
   `tokensPerSecond`; `reasoningOverheadMs`/`toolCallLatencyMs` carry over
   (their semantics are not measured by that source) and the receipt says so
   per entry. A new model from a community-schema record is rejected — new
   models need a stamped-table record.
4. **Apply** (atomic write; re-runs validation on the complete output first):

   ```sh
   node scripts/refresh-model-calibrations.mjs \
     --input path/to/snapshot.json --receipt data/model-calibrations.last-receipt.json
   ```

   Commit the updated `data/model-calibrations.json` and the receipt.

## Fail-closed contract

The script exits non-zero and leaves the table **byte-identical** when any of:

- a refresh record matches neither the community schema (all required fields,
  including `measured_at`) nor the stamped-table format;
- ANY entry in the output table lacks `measured_at` or a valid `provenance`
  stamp (`kind` ∈ curated|placeholder|public_source|community, non-empty
  `source`);
- `measured_at` is in the future, or a numeric field fails sanity bounds;
- a merge would drop an existing entry.

A failed run never partially writes — the complete output table is validated
before the atomic temp-file + rename.

## Staleness surfacing in outputs

- `token_time_bridge` / `token_cost_estimate` responses carry a `calibration`
  block (`provenance`, `measuredAt`, `ageDays`, `stale`); when the stamped
  table was used and its age exceeds 90 days, `stale: true` and the
  human-readable line gains a refresh note.
- Users can shadow the bundled table between releases by writing a stamped
  `model-calibrations.json` to their Epoch data dir (`~/.epoch/` or
  `$EPOCH_DATA_DIR`); a corrupt override is skipped, not trusted.
