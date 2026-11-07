# reference_class_estimate calibration — measurement record (issue #42)

Card t_6b805b34 · Seat **hml — Machine Learning**, Science & Evaluation, Kyanite Labs ·
measured 2026-11-01 (PT) / receipts stamped 2026-11-02T03:21Z · replay MAPE scaling
corrected + regenerated 2026-11-02T04:06Z (review round 1) · repo HEAD at run:
`68404e5` (`main`) · instruments run on Node v22.23.4.

This directory is the durable record of the issue #42 calibration reproduction and the
wave-2 recency-integration measurement, per the evals lane. Every figure below was
**re-measured first-hand for this record** (commands and outputs in *Verification
receipts*); none is copied from an earlier report without an independent re-run. The
production ledger itself is private and is **not** committed — only aggregates and
per-task-type/per-month medians, which carry no identifying content.

## Conclusion (BLUF)

1. **The regression is reproduced.** The issue's 0.545 (measured 2026-07-10) was not
   recovered as an exact cut, but the current production ledger copy reproduces the
   degraded family that contains it: **median actual/predicted = 0.500** over all 772
   clean matched pairs (0.522 with the recorded factor applied; monthly medians
   0.50 / 0.60 / 0.833 / 1.125, May→Aug). Recorded feedback health on the same data:
   trend **degrading**, MdAPE 94.6, MAPE 197.8, bias −0.4 (its own 662-pair population).
2. **Root cause is the training basis, not primarily drift.** Production
   `referenceClassEstimate` trains its correction factor as the median of
   `actual / correctedEstimate` (post-correction) ratios. Such a factor feeds back on
   itself and pins at `sqrt(median(actual/raw))`: measured `median(actual/raw) = 0.283`
   ⇒ fixed point **0.532** — matching the 0.500–0.545 family. Drift is real but
   secondary, and runs *opposite* to the issue's "operator got faster" hypothesis: the
   monthly median `actual/raw` ratio **tripled May→Aug (0.252 → 0.775, 3.1×)**
   (median actual hours 0.25h→0.60h by July while raw baselines moved far less) — the
   operator did not get faster; recorded actuals got larger.
3. **The landed wave-2 recency machinery, applied to reference_class training on the
   pre-correction basis (`actual/rawEstimate`), restores the band.** Rolling-origin
   replay through the landed `computeToolTaskCorrectionFactors` + `RecencyOptions` +
   `weightedMedian`: **median actual/predicted 0.833–0.873 across the whole recency
   grid — inside [0.8, 1.2]**; recommended default **window-60d** (`win60`), the only
   grid member in band on both views (all-pairs 0.833, trailing-20% 1.200); MdAPE
   68.0 vs 93–100 as-landed; error trend improving.
4. **Weighting alone (staying on the post-correction basis) does NOT restore the
   band**: 0.505–0.525 under all 7 recency schemes. The basis change is the load-
   bearing fix; recency weighting is the drift-tracking complement and wins the
   tiebreak under real drift (August monthly: win60 0.797 vs equal-weight 3.036).
5. **Nothing here is a production claim yet.** The production wiring (retraining
   `referenceClassEstimate` on the wave-2 machinery, pre-correction basis, win60
   default) is a separate code change under review; until it lands and the **live**
   ledger is re-measured, production still emits the degraded family. The historical
   0.93 (mid-June) is **not current and must not be cited publicly** until re-earned
   by that post-merge measurement (issue #42 acceptance, preserved below).

## Source data (provenance)

Private production ledger copy (read-only; copied from production 2026-10-26, received
via the parent validation run t_02e7da03 workspace):

| file | sha256 (first 16) | rows |
|---|---|---|
| `estimates.jsonl` (mtime 2026-10-26T23:06Z) | `15e0c3d82d149931` | 35,885 |
| `feedback.jsonl` | `b9b8c124f87ccca7` | 2,970 |
| `estimates.flags.jsonl` | `b434922a6bc3e9e9` | 472 |
| `estimates.labels.jsonl` | `c3e5c4dfb8f2c6bf` | 1,423 |
| `estimates.quarantine.jsonl` | `75a68dc4d0ec8831` | 234 |
| `reference-database.json` | `101688e617b8ca3f` | 552 |

Measurement population: **772 clean matched `reference_class_estimate` pairs**
(estimate + actual, `isExcluded` predicate removed 39 rows), completed
2026-05-02 → 2026-08-08 (population complete through the last matched pair). The
issue's 0.545 figure was cut from the 2026-07-10 ledger state; that historical state
was not available, so the reproduction is by family, not by exact cut.

Recorded-input note (2026-11-02): after the measurement, a live process appended 22
`monte_carlo_schedule` telemetry rows to the source copy's `estimates.jsonl`
(2026-11-02T03:25:59Z, after the receipts above). The **recorded input is the first
35,885 rows** of that file; the reconstruction `head -n 35885` re-hashes to
`15e0c3d82d149931…`, matching the table above, and is what the corrected regeneration
was run against. The appended rows carry no `reference_class_estimate` estimates:
both instruments re-run on the truncated input reproduce the landed
`backtest-rce-correction.json` byte-identically (including
`feedbackHealth.totalEstimates` = 35,885), proving the reconstruction is the exact
recorded input.

## Instruments (both land in this PR)

- `scripts/backtest-rce-correction.mjs` — baseline family reproduction + recorded
  feedback health + brief-conformant frozen chronological holdout (80/20 + 70/30
  sanity, wave-2 guards) + labeled in-sample recompute. READ-ONLY on the data dir
  (copies to a scratch temp dir; never writes back).
- `scripts/replay-rce-rolling.mjs` — rolling-origin replay **through the landed wave-2
  implementation** (`computeToolTaskCorrectionFactors` + `RecencyOptions` +
  `weightedMedian`, `asOf` = each row's estimate time, `MIN_RECORDS_PER_FACTOR` gate,
  low-n fallback = the row's recorded prediction, i.e. as-landed behavior). Training
  pairs are strictly earlier (`completedAt < estimatedAt`), so there is no leakage;
  this mirrors production, which retrains the factor on every estimate.

## Verification receipts (this record's own runs)

```
$ git rev-parse HEAD && node --version
68404e56750b22638d7ae4a7cd77f0dbd9d9a0f3
v22.23.4
$ npm ci --no-audit --no-fund                                   # clean install
$ export EPOCH_DATA_DIR=<production ledger copy>                # private; digests above
$ npx tsx scripts/backtest-rce-correction.mjs                   # exit 1 = HOLD verdict, by design (line 467)
  → results/backtest-rce-correction.json  (stdout captured verbatim)
$ RCE_REPLAY_OUT=results/replay-rce-rolling.json npx tsx scripts/replay-rce-rolling.mjs   # exit 0
  → results/replay-rce-rolling.json
$ python3 replay-rce-policies.py                                # independent stdlib cross-check (not landed)
  → agrees with the TS replay within 0.001–0.01 per cell; win60 cell exact (0.833 / 1.200)
$
$ # 2026-11-02T04:06Z correction round (review round 1) — regenerate against the
$ # exact recorded input (source copy had gained 22 telemetry rows; see provenance note):
$ head -n 35885 <ledger-copy>/estimates.jsonl > <scratch>/input/estimates.jsonl
$ sha256sum <scratch>/input/estimates.jsonl
  15e0c3d82d149931ed692e2527a0cccf19156aaa1e4ee22cc151f1de888764a0   # matches provenance table
$ EPOCH_DATA_DIR=<scratch>/input RCE_REPLAY_OUT=results/replay-rce-rolling.json npx tsx scripts/replay-rce-rolling.mjs   # exit 0
$ EPOCH_DATA_DIR=<scratch>/input npx tsx scripts/backtest-rce-correction.mjs   # exit 1 = HOLD; coherence check only
  → backtest output identical to the landed artifact (totalEstimates 35,885)
```

Reproduction checks performed:

- `results/backtest-rce-correction.json` is byte-identical to the recorded artifact
  of the parent validation run (t_02e7da03, same ledger copy) after replacing the
  internal `sourceDataDir` path string with the provenance label — that field is the
  **only** edit, asserted programmatically. Re-verified 2026-11-02 against the
  reconstructed 35,885-row input: identical, `feedbackHealth.totalEstimates` 35,885.
- `results/replay-rce-rolling.json` was **regenerated 2026-11-02 with a scaling
  correction** (review round 1): `mapeOf` in `scripts/replay-rce-rolling.mjs` applied
  a ×100 percent conversion on top of `apeOf`, which already returns percent, so
  `mapePercent` / `mapeFirstHalfPercent` / `mapeSecondHalfPercent` were 100× inflated
  in the original generation (and in the parent run's bug-compatible artifact). The
  fix drops the second conversion; the file was regenerated against the exact
  recorded input (first 35,885 rows, digest above) and differs from the original
  generation in **exactly those three fields per row** (each ÷100; e.g. as-landed
  18168.781 → 181.688, wave2-none 11599.319 → 115.993), asserted programmatically —
  every other field (medians, monthly cells, MdAPE, bias, n, trend labels) is
  unchanged, and no figure quoted in this README used the inflated fields, so the
  conclusions above are unaffected.
- The frozen-holdout rerun reproduces the prior attempt exactly (corrected test
  medians 1.35–1.39 across all variants; recommendation HOLD).
- The `recorded-ledger` and `as-landed-replay` rows cross-check the replay instrument
  against deployed behavior (0.500 recorded vs 0.526 replayed on the same rows).
- Root-cause arithmetic re-derived from the pairs directly: monthly median `act/raw`
  0.252 / 0.300 / 0.606 / 0.775 (May–Aug), overall median 0.283, `sqrt(0.283)=0.532`.

## Results

### 1. Baseline family — recorded ledger (issue #42's 0.545 regime)

| cut | median actual/predicted | n |
|---|---|---|
| all clean pairs (as produced) | **0.500** | 772 |
| recorded-factor-applied | 0.522 | 772 |
| completed ≤ 2026-07-12 (issue-era) | 0.500 | 734 |
| monthly: May / Jun / Jul / Aug | 0.500 / 0.600 / 0.833 / 1.125 | 541 / 157 / 60 / 14 |
| median of per-task-type medians | 0.509 | 7 types (0.417–0.714) |

Recorded feedback health (`getFeedbackHealthReport` on the copy, its own population):
trend **degrading**, MdAPE 94.6, MAPE 197.8, bias −0.4, 662 matched pairs.

### 2. Brief-conformant frozen holdout (reported, not the headline)

Chronological 80/20 (train 617 / test 155, asOf 2026-06-03), all 7 recency variants
plus unweighted: **no variant clears both guards** — corrected test median 1.35–1.39;
winner: none; recommendation: **HOLD**. A factor frozen at the train-split date cannot
survive the July regime shift (act/raw 0.30 → 0.78). Production retrains per call, so
the rolling-origin replay is the mode-faithful evaluation; both results are recorded,
neither hidden. (In-sample recompute on full history: 0.992 all-pairs — arithmetically
necessary, labeled in-sample, not calibration evidence.)

### 3. Rolling-origin replay through the landed wave-2 machinery (headline, n=772)

| policy | basis | median all | trailing 20% | MdAPE % | trend | in band [0.8,1.2] |
|---|---|---|---|---|---|---|
| recorded ledger | post (as produced) | 0.500 | 0.745 | 100 | stable | ✗ |
| as-landed replay | post, unweighted, 90d | 0.526 | 0.794 | 93.2 | stable | ✗ |
| weighting-only, 7 schemes | post + recency | 0.505–0.525 | 0.622–0.747 | 93.1–99.0 | stable | ✗ (all) |
| **wave2 win60** | **pre + window 60d** | **0.833** | **1.200** | **68.0** | improving | **✓ both views** |
| wave2 none / exp30 / exp45 | pre + recency | 0.870 | 1.389–1.482 | 68.0 | improving | ✓ all / ✗ trailing |
| wave2 exp90 / win90 / win180 | pre + recency | 0.870–0.873 | 1.482 | 68.0 | improving | ✓ all / ✗ trailing |

Monthly medians (win60 vs equal weighting): May 0.737 / 0.737 · Jun 1.087 / 1.087 ·
Jul 1.693 / 1.675 · **Aug 0.797 / 3.036** — the August column is the drift-tracking
payoff of recency weighting under the July regime shift.

## Issue #42 acceptance mapping (as of this record)

| issue acceptance | status |
|---|---|
| Re-measure reference_class median actual/predicted on the live ledger after recency weighting lands | **Measured on the live-ledger copy via rolling replay** (mode-faithful: production retrains per call): 0.833–0.873 pre-correction + recency. The post-wiring **live production** re-measurement remains open — the wiring change (src, reviewed PR, not merged at this record) must land first. |
| Return to [0.8, 1.2] | **Met in replay** on the all-pairs family (0.833–0.873); win60 also holds trailing-20% at 1.200 (inclusive edge). Weighting-only on the current basis does not meet it (0.505–0.525). |
| Do not cite 0.93 publicly until re-earned | Preserved: 0.93 appears here only as the historical mid-June figure under the do-not-cite rule; no public material is touched by this PR. |

## Limitations (by name)

- **Trailing-20% is the weak view** — only win60 holds it (1.200, inclusive edge);
  continued upward drift would push it out again. Win60's 60d window is the most
  responsive in the grid.
- **Frozen-holdout protocol fails all variants** (1.35–1.39, HOLD) — the band claim
  rests on the rolling-origin replay, which matches production's retrain-per-call
  mode. Both are recorded above.
- **0.545 reproduced as a family, not an exact cut** — the 2026-07-10 ledger state
  was not available; no cut of the current copy contradicts the degraded regime.
- **Forward-looking counterfactual** — the replay measures what the change *would
  have* produced on this ledger; it is not a claim about the already-recorded rows.
- **Small monthly cells** — July n=60, August n=14; monthly ratios are indicative.
- **Population vs feedback-health mismatch** — the 772-pair measurement population
  and `getFeedbackHealthReport`'s own 662-pair population differ (matching rules);
  both figures are reported as measured, per population.

## What must happen next (preserved acceptance)

1. Production wiring lands (separate reviewed PR; not merged by this record): train
   `referenceClassEstimate` correction factors through
   `computeToolTaskCorrectionFactors` on the **pre-correction** basis
   (`outputs.rawEstimate`, `correctedEstimate` fallback for legacy rows) with
   `RCE_CORRECTION_RECENCY_DEFAULT = { scheme: { kind: "window", windowDays: 60 } }`;
   `MIN_RECORDS_PER_FACTOR` gate; low-n fallback unchanged.
2. **Re-measure the live production ledger after that change is deployed** — target
   median actual/predicted in [0.8, 1.2] on the live population. This record's
   replay is the pre-landing evidence, not the post-landing claim.
3. 0.93 stays out of public material until that re-measurement re-earns it.

## Files

- `README.md` — this record.
- `results/backtest-rce-correction.json` — baseline family + feedback health + frozen
  holdout + in-sample recompute (raw instrument output; `sourceDataDir` normalized).
- `results/replay-rce-rolling.json` — rolling-origin replay through the landed wave-2
  machinery, full policy grid (raw instrument output; `sourceDataDir` normalized;
  regenerated 2026-11-02 with the `mapeOf` scaling correction — see *Reproduction
  checks*).
- `scripts/backtest-rce-correction.mjs`, `scripts/replay-rce-rolling.mjs` — the
  instruments (repo `scripts/`). `backtest-rce-correction.mjs` unchanged from the
  verified run; `replay-rce-rolling.mjs` carries the 2026-11-02 `mapeOf` scaling
  fix (drop the second ×100).
