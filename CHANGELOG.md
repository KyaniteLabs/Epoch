# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (estimation math direction — audit tickets 13)
- **`cocomo_validate` coefficient adjustments no longer amplify bias.** The per-type recommendations previously used `1 + bias/100` (and `1 + bias/200` for the exponent), so a positive bias (systematic overprediction) recommended *growing* the coefficient — overpredicting further. Both now correct against the bias (`1 - typeBias/100` for `organic.a`; `1 - typeBias/200` for `embedded.b`, kept at a deliberately conservative half-strength because exponent corrections compound at large KLOC). The overall scale factor was already sign-correct and is unchanged.
- **`cocomo_estimate` `iterative_cycles` is now monotonic non-decreasing over [0.5, 10] with no cliff at 2.0.** Previously 2.0 mapped to a 2.0x multiplier but 2.01 collapsed to 1.201x (a ~40% drop for *more* iterations). Values <= 2.0 remain literal multipliers; above 2.0 the input is a literal cycle count and each additional cycle adds a fixed 0.1 of multiplier anchored at the literal-region endpoint: 2.0 -> 2.0x, 3 -> 2.1x, 10 -> 2.8x. Estimates for cycle counts above 2.0 therefore increase relative to the old normalized values (e.g. 10 cycles: 2.0x -> 2.8x).
- **Percentile indexing (nearest-rank/ceil-rank) fixed** in `monte_carlo_schedule`'s P10/P50/P80/P95 and telemetry execution benchmarks: the old floor-rank index was biased one rank high — p95 of an n=20 sample returned the maximum, p50 of n=1000 returned the 501st order statistic. p95 of small samples now sits strictly below the max; the n=1000 median is the 500th order statistic.
- **`weightedMedian` (recency-weighted correction factors) reduces to the unweighted median under equal weights.** An exact half-weight tie previously resolved to the lower median (weightedMedian([1,3]) returned 1); ties now split the difference between the straddling values (weightedMedian([1,3]) = 2), matching the file's own `median()`.

### Changed (breaking metric semantics — audit ticket 13)
- **`monte_carlo_schedule` `criticalPathProbability` now means P(total <= `target_hours`) and is `null` without a deadline.** The field previously always read ~0.80 because the "target" was the simulation's own p80 — a tautology carrying no information. Supply the new optional `target_hours` input (working hours; task durations are 8-hour days) to get the real probability of fitting the deadline; the result also carries `targetHours`, and `humanReadable` appends the probability line only when a target was supplied. Consumers treating the old constant ~0.80 as signal must re-evaluate; consumers reading the field must handle `null`.
- **`monte_carlo_schedule` per-task `riskEvents[].impactDays` is now per-task** — the mean per-simulation excess of that task's sampled duration beyond 1.5x its PERT expected value (E[(X - 1.5·E[X])⁺], in days). Previously the project-level p95-p50 spread was copied onto every row, so every risk event carried the same impact regardless of the task. Risk events are now sorted by expected impact (descending).

### Fixed (calendar truth 2026-2027 — audit ticket 14)
- **US observed days**: fixed-date federal holidays (New Year's, Juneteenth, Independence, Veterans, Christmas) falling on Saturday are now observed the preceding Friday and on Sunday the following Monday (5 U.S.C. 6103). Previously `add_business_days`/`count_business_days` counted e.g. Friday 2026-07-03 (observed Independence Day) and Monday 2027-07-05 as regular business days.
- **UK substitute days** (England & Wales): bank holidays falling on a weekend now substitute the next weekday that is not itself a bank holiday (e.g. Boxing Day Sat 2026-12-26 -> substitute Mon 2026-12-28). The 2025 Early May bank holiday one-off move to Thursday 8 May (VE Day 80th) is included.
- **Good Friday removed from the US federal holiday set** — it is not a U.S. federal holiday; listing it made arbitrary Spring Fridays (e.g. 2026-04-03) non-business days in the US. It remains in the UK/DE sets, where it is a real holiday. **Behavior change**: US business-day counts around Good Friday increase by one per occurrence.
- **JP equinox dates corrected via an official per-year table (2024-2030)**, verified against the National Astronomical Observatory of Japan: Shunbun 2024-03-20, 2025-03-20, 2026-03-20, 2027-03-21, 2028-03-20, 2029-03-20, 2030-03-20; Shubun 2024-09-22, 2025-09-23, 2026-09-23, 2027-09-23, 2028-09-22, 2029-09-23, 2030-09-23. The previous year-based ternaries had both dates inverted for several years (e.g. 2027 Shunbun was 03-20 instead of 03-21). Years outside the table use the Meeus astronomical computation (JST), which reproduces every table entry exactly; JP Sunday holidays also now get their substitute (振替休日) Monday, and the Emperor's Birthday (Feb 23) was added to the JP set.
- **Holiday sets are memoized per (country, year)** — multi-year day-walks compute each holiday set once instead of rebuilding it for every day visited (~15 allocations per day previously).
- **Business-day outputs now carry a `calendarVersion` stamp** (`CALENDAR_VERSION`, currently "2026.08") naming the holiday-rule revision that produced them, so saved forecasts can detect when a holiday-rule correction (like the ones above) shifts results.

### Changed (breaking output — ticket 11, estimate-basis unification; rides 0.5.0)
- **One estimate basis end-to-end: displayed == recorded == calibrated.** `pert_estimate` and `reference_class_estimate` previously displayed (and interval-scaled) an `adjustedEstimate` the ledger never recorded, while ratio quantiles were calibrated on the ledger-recorded basis — biasing every empirical P80 interval low by the correction factor (a 10h estimate with ratio quantiles [0.6, 1.5] showed 5.34–13.35 at the default factor and 10.8–27 at `ai_native=0`; the same-basis interval is 6–15). Intervals and the `humanReadable` point estimate now use the recorded basis: raw PERT `expected` × unit factor for `pert_estimate`, `correctedEstimate` for `reference_class_estimate`. `adjustedEstimate` keeps its name and shape as a labeled dual field for one minor version (PRD D1), with a new additive `basisNote` on both tools naming which fields carry which basis.
- **Ratio populations are split by tool and basis era, permanently.** `coverage.ts` never pools actual/estimate ratio populations across tools or across bases. New estimate rows carry a `basisVersion: 2` stamp (legacy rows are implicitly v1 — the era in which displayed ≠ recorded); interval prediction uses the v2 population of the calling tool's `(tool, task_type)` cell once it reaches 30 stamped pairs, else falls back to the v1 population computed on the v1 recorded basis, and the new additive `intervalPopulation` output field states which population was used. A v2-only ledger (fresh install) uses its own population at the ordinary minimum of 5 pairs. `feedback_health`'s `intervalCoverage` scores each pair against its own era's population; mixed-era ledgers never blend. The split has no automatic aging-out — retiring it requires an explicit future decision.
- **Community dataset schema stays stable via dual labeled fields.** `estimation-record.schema.json` gains an optional `estimate_basis_version` (1 or 2) property; `estimated_hours` remains the ledger-recorded basis in both eras. Existing exports validate unchanged; contributors may label eras so downstream ratio populations stay split. `pnpm run dataset:verify` remains the CI gate.
- **Migration note:** if you consumed `pert_estimate`/`reference_class_estimate` `interval` endpoints or parsed the `humanReadable` point estimate expecting the adjusted basis, re-read the fields — interval endpoints and displayed point estimates are now on the recorded basis and are wider by the correction factor you previously saw folded in. Consumers of `adjustedEstimate` are unaffected; consumers of the recorded hours (`expected`, `correctedEstimate`, ledger rows, community exports) are unaffected — those never changed.

## [0.4.1] - 2026-08-14

Hotfix release (W1 of the post-audit remediation program): restores the estimate-vs-actual feedback contract, makes every agent-facing error readable, publishes real OpenAPI schemas, bounds adversarial inputs, and stops the public surfaces contradicting the package.

### Fixed
- **`estimate_from_context` feedback loop restored.** The tool was registered but absent from the canonical tool-alias set, so its estimates never joined the ledger and `record_actual` rejected its `feedbackRef` tokens with "Unknown error." The tool surface is now defined authoritatively in `src/lib/tool-aliases.ts`; the registry (names, counts, estimation/non-estimation partition) and the feedback-health denominator derive from it, pinned by sync tests, so a 24-vs-25-style drift fails CI instead of shipping. Every `record_actual` failure reason (including per-entry batch reasons) now maps to a distinct actionable message.
- **Validation failures are readable sentences, not zod JSON blobs.** The dispatcher catches `ZodError` at its seam and renders one `path: message — got <value>` line per issue (e.g. `tokens: must be greater than 0 — got 0`), preserving custom schema guidance text and surfacing the rejected value. The HTTP boundary now distinguishes caller-fixable validation failures (422, message surfaced verbatim) from internal thrown errors (500, generic-safe message — filesystem paths/stack details from internal errors no longer leak over HTTP; both carry an `errorKind` discriminator).
- **`/openapi.json` request schemas are real.** The zod-v3-internals walker was dead under zod 4 and rendered every tool's request schema empty; the spec is now built with zod v4's native JSON-Schema conversion, degrading per tool to a documented fallback if a schema is unrepresentable instead of failing the whole document.
- **CLI failures are loud.** Non-interactive `telemetry enable` without `--yes` exits non-zero instead of silently no-oping; `auto-actuals` follows the standard CLI result contract (exit codes, format/quiet handling); `serve` is a real documented command with validated port handling.

### Added
- **Input safety bounds** on every single-call server-freeze vector: business-day `days` (±100,000), task-array sizes (≤500), Monte Carlo iterations (≤100,000) and the iterations×tasks product (≤10,000,000, rejected with a workable-iterations retry hint), and `estimate_from_context` context length (≤50,000 chars). Bounds surface in the published JSON Schemas.

### Changed
- **Node.js floor raised to `>=22`** (`engines.node`, CI matrix 22/24). Node 20 reached end-of-life in April 2026 and was never tested for this release line; the publish runtime is Node 24.

### Release hygiene
- Version strings on release surfaces (`server.json`, `docs/llms.txt`, `site/llms-full.txt`) now derive from `package.json` at release time via `scripts/stamp-release-versions.mjs` (wired into the release workflow before every publish step; `--check` guards drift). README license/tech-stack/model-count/sample-size claims corrected to match the package (Apache-2.0, TypeScript 6/Zod 4/Vitest 4, 16 models, sourced 139-pair AI-native baseline citation); the stale `site/llms-full.txt` was regenerated against the 25-tool surface; the agent skill's broken `compare-models` example was fixed against the real CLI grammar.

### Deferred
- **Ledger read caching and write batching are deferred to 0.5.0 — explicitly accepted risk.** Estimation-call latency in 0.4.1 still grows with ledger history (every estimation call re-parses `estimates.jsonl`). The deferral is deliberate (W2's accuracy fixes must be pinned against the straightforward read path before a cache layer changes the numbers under them) and tracked as Principle-5 work in the remediation program; 0.5.0 lands size+mtime-keyed read caching and batched writes with full re-validation under cache.

## [0.4.0] - 2026-07-10

### Changed
- **Privacy fix**: telemetry submissions no longer transmit the full-precision `completed_at` timestamp — the wire now carries date-only `date` exactly as PRIVACY.md/TELEMETRY.md always promised. The full-precision value remains local-only as the submission cursor. Receivers continue to accept (and ignore) `completed_at` from older clients.
- `pert_estimate` and `reference_class_estimate` now lead their `humanReadable` output with a calibrated P80 interval (per-task-type empirical ratio quantiles when >=5 matched pairs exist, else a PERT-variance fallback for `pert_estimate` — both cases say which source was used) before the point estimate, and expose it additively as a new `interval` output field (plus `intervalNote` when a fallback/insufficient-data note applies); `computeToolTaskCorrectionFactors` (`src/lib/calibration-factors.ts`) gained an optional recency-weighting parameter (exponential decay / hard rolling window) for the `(pert_estimate, task_type)` learned correction factor, but the live backtest (`scripts/backtest-pert-correction.mjs`) found no tested scheme that robustly beat the unweighted baseline, so the default stays unweighted — `EPOCH_PERT_LEARNED_CORRECTION` remains off by default either way.
- Docs refresh: README/llms.txt/server.json now reflect the shipped `estimate_from_context` tool (24→25 tools), the current Claude 5 model catalog, and an evidence-backed self-improvement section (`scripts/backtest-pert-correction.mjs` receipt).

### Added
- New `calibration_provenance` value `auto_wallclock` and CLI subcommand `epoch auto-actuals --session <id> [--dry-run]`, which auto-records wall-clock-derived actuals (never overwriting a verified actual) for a session's un-actualed pending estimates, gated by a dedicated sanity bound ([0.05h, 12h], <10x ratio vs. estimate) shared across the CLI pre-filter, `recordActualDetailed()`'s write-time guard, and `isExcluded()`'s calibration-math guard; `feedback_health` now reports a `byProvenance` block (verified vs. auto matched-pair counts and MdAPE) so any drift introduced by auto-recorded actuals stays visible instead of silently blending into the headline metrics.


### Explored (no shipped change)
- Investigated a single-file `bun build --compile` executable as a faster-startup alternative to `npx` distribution. Currently **blocked** by a Bun 1.3.14 bundler linking defect that only manifests when the CLI dispatcher and MCP entry (`@modelcontextprotocol/sdk`, which calls `z.custom()` at module top level) are bundled together — each half compiles and runs correctly in isolation. Full repro, root-cause analysis, and a ready-to-use `scripts/build-binary.sh` (for once Bun ships a fix) are in `docs/BINARY.md`. No runtime code changed.

## [0.3.1] - 2026-07-10

### Removed
- **Rust port and launcher.** The `rust/` workspace (epoch-cli/epoch-mcp/epoch-http/xtask), the release-time prebuild staging (`prebuilds/`), the `dist/native/epoch-rust-launcher.js` bin shim, and all Rust parity/soak/promotion-gate/scorecard contract tooling under `src/contract/`, `src/benchmarks/`, and `scripts/` have been removed. The Rust replacement effort was cancelled before promotion; the npm `epoch` bin now points directly at the TypeScript CLI bundle (`dist/index.js`), which already implements the same CLI/MCP-stdio/HTTP argument dispatch the launcher forwarded to in its TS-fallback path. CLI commands, MCP stdio mode, HTTP mode, and `epoch telemetry *` are unaffected — this is an internal implementation change, not a behavior change.
- **Breaking (internal/experimental only)**: `EPOCH_RUST_BIN_DIR` and other `EPOCH_RUST_*` environment variables are no longer honored — they only ever affected the (now-removed) Rust binary resolution path and were not documented as part of the stable public interface.
- The `rust:*`, `promotion:rust-*`, `contract:rust-readiness`, `benchmark:rust-promotion*`, and `verify:rust-milestone0` npm scripts (19 total) — their target files no longer exist.
- The unreferenced Rust-based `Dockerfile` (its sole purpose was booting the now-deleted `epoch-mcp` Rust binary; nothing in CI built or published it).
- Two previously flaky Rust-promotion test suites (`rust-replacement-scorecard.test.ts`, `rust-soak-ledger-cli.test.ts`) are gone along with the code they tested.

## [0.3.0] - 2026-07-10

### Added (Phase 3 contract wave — additive, non-breaking)
- Optional `task_label`, `project`, `session_id` string inputs on all 8 estimation tools (`pert_estimate`, `reference_class_estimate`, `cocomo_estimate`, `sprint_forecast`, `monte_carlo_schedule`, `schedule_risk`, `critical_path`, `token_time_bridge`). Persisted verbatim on the estimate row; `task_label` is additionally surfaced as an optional `task_label` field on each entry in `get_pending_estimates` output when present.
- Optional `complexity` (1–5) input on `pert_estimate`, matching the existing `reference_class_estimate` complexity scale. Currently persisted for future per-complexity correction-factor conditioning; not yet applied to the headline estimate.
- New additive `pert_estimate` output fields: `rawEstimate` (pre-correction expected-based headline, same value as `expected`), `correctionFactor` (the raw learned `(pert_estimate, task_type)` correction factor from `computeToolTaskCorrectionFactors`, independent of the `ai_native` developer-profile factor; `1.0` when `EPOCH_PERT_LEARNED_CORRECTION` is off or the cell hasn't reached `MIN_RECORDS_PER_FACTOR`), and `n` (matched-pair sample size for that correction cell; `0` when the flag is off or no `task_type` was supplied). These mirror `reference_class_estimate`'s existing `rawEstimate`/`correctionFactor` provenance fields. **Additive-but-parity-breaking**: this changes `pert_estimate`'s output key set, so the Rust parity branch must add matching keys and rebase before its freeze (see `src/contract/rust-parity-cases.ts`).
- Optional `unit` (`minutes`/`hours`/`days`/`weeks`) and `calibration_provenance` inputs on `record_actual` and (per-entry) `batch_record_actuals`. `unit` wires through to the existing lib-level unit-normalization support in `recordActualDetailed()` (previously only reachable via the library API, not the MCP tool surface). `calibration_provenance` is now persisted on the actual record and honored by the shared exclusion predicate (`isExcluded()`) via `ActualRecord.calibrationProvenance`.
- New `estimate_from_context` tool registered (schema: `context` string plus optional `task_type`/`complexity`/`team_id` hints). Not yet implemented — returns a structured `{implemented: false, plannedPhase: 5, ...}` response. Registered now (schema + registry + CLI + parity case) so its input contract is stable before the Rust parity freeze; classification/delegation logic lands in a future release.
- New `record_actual/synthetic-id-rejected` Rust-parity case pinning the shared exclusion predicate's synthetic/seed-id write-gate (`isSyntheticId()`) so both runtimes reject identically.

### Changed
- `pert_estimate`'s headline `adjustedEstimate` value shifts when the (opt-in, default OFF) `EPOCH_PERT_LEARNED_CORRECTION` flag is enabled: for a given `task_type`, once the learned (`pert_estimate`, `task_type`) correction factor has at least `MIN_RECORDS_PER_FACTOR` (3) matched, exclusion-filtered estimate/actual pairs, that learned factor REPLACES the `ai_native` developer-profile correction factor in the `adjustedEstimate` computation (never multiplied with it). Below that threshold, behavior is unchanged. No output keys are added or removed. See `scripts/backtest-pert-correction.mjs` for the MdAPE/median-ratio backtest guard that gates recommending the flag be turned on.
- **BREAKING (behavioral/reported-metric change)**: `feedback_health` and `accuracy_trend` now suppress calibration verdicts (e.g. "Sufficient for calibration", "Good coverage", bias labels like "systematic overestimation") whenever a tool/task-type/overall bucket has fewer than `MIN_N_FOR_VERDICT` (default **20**, overridable via `EPOCH_MIN_N_FOR_VERDICT`) matched estimate-actual pairs. Below the threshold, the `recommendation` / `humanReadable` fields now read `"Insufficient sample (n=X)..."` instead. JSON keys are unchanged — only the string *values* differ. Downstream dashboards, exports, or snapshot tests that pattern-match on the old wording (or that treated any non-empty `recommendation` as a calibration signal) must be recomputed/updated.
- Non-estimation tool calls (`record_actual`, `batch_record_actuals`, `get_current_time`, `convert_timezone`, `parse_duration`, `time_math`, `add_business_days`, `count_business_days`, `feedback_health`, `get_pending_estimates`, `accuracy_trend`, `calibrate_estimates`, `compare_models`, `token_cost_estimate`, `cocomo_validate`, `cocomo_ground_truth`) no longer append rows to `estimates.jsonl`. They are now recorded separately to a new `tool-calls.jsonl` telemetry stream (via `recordToolCall()`). Only the 8 tools that actually produce a time/effort estimate (`pert_estimate`, `reference_class_estimate`, `cocomo_estimate`, `sprint_forecast`, `monte_carlo_schedule`, `schedule_risk`, `critical_path`, `token_time_bridge`) still join the estimates ledger. **This shifts `totalEstimates`, `matchRate`, `selfImprovement.readyTypes`, and `dataQuality.dataCompletenessScore` in `feedback_health` output** — all previously counted non-estimation tool calls as "estimates". Anyone tracking these numbers over time (dashboards, alerts, exported snapshots) must treat pre/post-upgrade values as non-comparable and recompute baselines from the new `estimates.jsonl` contents.
- New pending estimates now get a 30-day `expiresAt` (overridable via `EPOCH_PENDING_TTL_DAYS`). `get_pending_estimates` now excludes expired rows, so `count`/`estimates` in its response may shrink for stale, never-actualed estimates versus the previous unbounded-lifetime behavior.

### Migration notes
- If you snapshot or diff `feedback_health` / `accuracy_trend` output for monitoring, treat this release as a hard reset of the historical series for `totalEstimates`, `matchRate`, `readyTypes`, `dataCompletenessScore`, and any `recommendation`/`humanReadable` text you parse — recompute baselines after upgrading rather than comparing against pre-upgrade values.
- `tool-calls.jsonl` is additive (new file under `~/.epoch/`, or `$EPOCH_DATA_DIR`); no migration of existing data is required, but any external tooling that reads `estimates.jsonl` directly should be updated to expect fewer, purely-estimation rows going forward.
- **Rust parity freeze gate**: this release adds 3 new `pert_estimate` output keys (`rawEstimate`, `correctionFactor`, `n`) and a new `estimate_from_context` tool. Both are additive/non-breaking for npm/HTTP/CLI consumers, but they break `src/contract/rust-parity.ts`'s sorted-key comparison and tool-name inventory until the Rust reader/CLI adds matching support. The `codex/rust-epoch-promotion-gates` branch (or successor) must rebase onto `main` after this lands and re-green `rust-parity.test.ts` before any Rust-replacement freeze/promotion decision.

### Added (Phase 5 — estimate_from_context logic, interval coverage, model catalog)
- **`estimate_from_context` is now implemented.** Classifies free-text task context (issue body, PR/diff description, task summary) into `task_type`/`complexity` using a new LOCAL, deterministic keyword/signal heuristic — **no LLM call** (`src/lib/context-estimate.ts`; documented in full in that file's header, per the no-fabricated-estimate rule). Caller-supplied `task_type`/`complexity` hints always override the classification. The resolved inputs are then delegated to the same reference-class-forecasting path used by `reference_class_estimate` (`referenceClassEstimate()` in `src/lib/analytics.ts`), and the response now carries the full reference-class estimate output (`rawEstimate`, `correctedEstimate`, `correctionFactor`, `sampleSize`, `baselineSource`, `scopeUsed`, `scopeInferred`, `confidence`, `estimatedTokenCost`) plus a new `classification` provenance block (`classified_task_type`, `classified_complexity`, `confidence`, `signals`, `task_type_from_hint`, `complexity_from_hint`). The previous `{implemented: false, plannedPhase: 5, ...}` stub response is gone. When classification confidence is `"low"` (no clear signals found in the supplied context), an additional `lowConfidenceNote` field is returned rather than silently guessing.
- **Behavioral change**: `estimate_from_context` moved from the non-estimation telemetry set to the estimation-tools set — it now produces a real hour estimate (`correctedEstimate`) and joins `estimates.jsonl`, making it eligible for `record_actual` pairing (previously routed to `tool-calls.jsonl` as non-estimation telemetry while it was a stub).
- New additive `intervalCoverage` block on `feedback_health` output (`src/lib/coverage.ts`): P50/P80/P90 prediction intervals — from a `pert_estimate` row's own recorded `expected`/`stdDeviation` where available, else per-task-type empirical actual/estimate ratio quantiles (minimum 5 matched pairs) via the shared overlay-merge loader + exclusion predicate — and a coverage-calibration report (`n`, `p80CoverageRate`, `targetP80Coverage: 0.8`, `byTaskType`, `note`) showing what fraction of matched actuals landed inside their predicted P80 interval. Documented as an in-sample sanity check, not out-of-sample validation (see the file header for the full methodology note). Computed and merged in at the dispatcher layer (not inside `FeedbackHealthReport`) to avoid an import cycle with `feedback.ts`.
- Model catalog refreshed: `llmModelEnum` (`src/schemas/index.ts`), `MODEL_CALIBRATIONS` (`src/lib/analytics.ts`), and `data/supplementary-database.json`'s `modelCalibration` gain 4 new entries — `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`. **Pricing (`costInput`/`costOutput`, $ per 1M tokens) is primary-source verified**: Claude Opus 4.8 $5/$25, Claude Sonnet 5 $3/$15 (standard rate; $2/$10 introductory through 2026-08-31, not used here), Claude Haiku 4.5 $1/$5, Claude Fable 5 $10/$50 — sourced from the `claude-api` skill's curated Anthropic model/pricing reference (cached 2026-06-24), retrieved and cross-checked 2026-07-09; full citation in `data/supplementary-database.json`'s `sources.claudeModelPricingPhase5` and `src/schemas/index.ts`'s `llmModelEnum` comment. `claude-mythos-5` (Project Glasswing-only; identical pricing to Fable 5) was intentionally omitted as not broadly applicable to a general cost-comparison catalog. Latency/throughput calibration fields (`tokensPerSecond`, `timeToFirstTokenMs`, `avgApiLatencyMs`) for the 4 new entries are **not** pricing and are **not** primary-source verified — they reuse the nearest existing same-tier Claude entry's figures as a documented placeholder (disclosed inline in both `analytics.ts` and the JSON `sources` entry). `compare_models` / `token_cost_estimate` pick up the new models automatically (additive; no schema/tool-input changes — `llmModelEnum` was already unwired from the free-form `model: z.string()` input fields, so this is a pure catalog/enum addition).

### Added (Phase 6 — calibration dashboard)
- New `scripts/build-calibration-dashboard.mjs` (+ `src/lib/dashboard-data.ts`, `scripts/lib/render-calibration-dashboard.mjs`): generates a single, self-contained, read-only calibration decision-surface HTML report from the live Epoch ledger (`.omc/reports/epoch-calibration-dashboard.html` by default; `--out <path>` to override). STRICTLY read-only — computed entirely through the existing shared library surface (`getFeedbackHealthReport()`, `loadLedgerWithOverlays()`, `isExcluded()`, `computeIntervalCoverage()`, `computeToolTaskCorrectionFactors()`, `computeAccuracyTrend()`); never reads `estimates.jsonl`/`feedback.jsonl` directly except via `ledger.ts`'s exported `readLines()`/constants (for the orphan-actual scan, mirroring `src/lib/migrations/repair-orphaned-actuals.ts`'s existing pattern).
- Report sections: headline (matched pairs, capped MdAPE, match rate, trend, before/after remediation notes), per-tool and per-task-type calibration tables (median actual/predicted, MdAPE, min-n gating status), PERT learned-correction status (flag state, held-out backtest vs the Tier-1 `[0.7, 1.3]` band with an inline SVG band chart), P80 interval-coverage report (overall + per-task-type, inline SVG bar chart), a data-integrity audit (quarantine/label/orphan/expired-pending/dedup counts), and an explicit `knownLimitations` note.
- Design: CSS custom-property design tokens, light/dark via `prefers-color-scheme` + a persisted `data-theme` toggle, inline SVG charts with direct labels (no chartjunk), skip-to-content link, `<main>` landmark, `role="img"`/`aria-label` on both SVGs, `:focus-visible`, `prefers-reduced-motion` fallback, and wide tables scrolling in their own `overflow-x` container (page body never scrolls horizontally). No external fetches; renders identically from `file://`.
- **Known limitation surfaced by this work** (not fixed — out of Phase 6's surgical, lib-internals-untouched scope): `feedback.ts`'s `matchEstimatesToActuals()`/`getFeedbackHealthReport()` read the ledger directly and apply `isExcluded()` without merging the `estimates.flags.jsonl`/`estimates.labels.jsonl` overlay sidecars, unlike `ledger.ts`'s `loadLedgerWithOverlays()` (used by this dashboard's Section 6 integrity counts and the PERT backtest). On the current corpus every quarantine overlay flag is also independently caught by `isExcluded()`'s exact-match + `2026-05-05` date-signature rule, so the two paths agree today — but a quarantine/orphan flag without a matching backfill signature would be visible in Section 6 without being excluded from the headline/per-tool/per-task-type matched-pair math. Documented in `src/lib/dashboard-data.ts`'s `KNOWN_LIMITATIONS` and regression-guarded by a dedicated `dashboard-data.test.ts` case.
- Unit tests: `src/lib/dashboard-data.test.ts` (8 cases against synthetic temp-dir fixtures, following the existing `coverage.test.ts`/`calibration-factors.test.ts` real-`EPOCH_DATA_DIR`-override pattern).

## [0.2.9] - 2026-06-29

### Added
- Rust promotion evidence packet tooling for strict TypeScript parity, qualified performance comparison, release-binary E2E coverage, package smoke proof, rollback rehearsal, cumulative soak ledgers, and replacement scorecards.
- Rust package launcher and prebuild staging support for CLI, MCP, and HTTP binaries behind the npm `epoch` entrypoint.
- Release-gate commands for Rust parity, adversarial compatibility, shadow soak, soak status, soak runner, promotion gate, and replacement scorecard reporting.

### Changed
- Rust replacement readiness now fails closed on deploy evidence quality: release-tagged qualified benchmarks, package command signatures, binary identity, public-surface coverage, HTTP deploy coverage, rollback proof, and continuous clean soak are all scored explicitly.
- Telemetry submit now routes through the Rust launcher so the replacement candidate covers the full user-facing command surface.

### Fixed
- Installed-package smoke checks now prove the packaged CLI, MCP stdio, and live HTTP `/health` paths rather than trusting package metadata alone.
- Soak ledgers, status reports, promotion gates, and replacement scorecards now share one package evidence validator to avoid drift between operator status and deploy automation.

## [0.2.7] - 2026-05-25

### Fixed
- Added required `mcpName` npm metadata for MCP Registry validation.

## [0.2.6] - 2026-05-25

### Added
- `epoch data where` — show local Epoch data file locations (read-only, no network).
- `epoch data status` — show local data file counts, feedback match rate, telemetry status, and reference database health.
- `epoch share-data --validate --description` — export anonymized community data in valid `estimation-record` schema format.
- `pnpm run dataset:build` and `pnpm run dataset:verify` scripts for the public aggregate benchmark.
- `scripts/validate-public-benchmark.mjs` — validates `data/public-benchmark.json` against aggregate-only rules.
- CI step for community data validation (`node scripts/validate-community-data.mjs`).
- CI step for reference database verification (`node scripts/verify-reference-db.mjs`).
- `docs/ops/machines.md` — canonical machine inventory (ubuntu-receiver, mac-mini, hermes-vps).
- `docs/ops/epoch-fleet-audit.md` — runbook for live fleet auditing.
- `scripts/audit-epoch-fleet.sh` — convenience script for SSH-based fleet audits.
- `src/lib/data-status.ts` — read-only local data inspection functions.
- `src/lib/community-export.ts` — community-data-compatible export with schema validation.
- 22 new tests (9 data-status, 13 community-export).
- `scripts/consolidate-and-improve.sh` — consolidates data from all fleet machines and rebuilds the bundled reference database.
- `scripts/verify-reference-db.mjs` — validates the bundled reference database for CI.

### Changed
- **Bundled reference database rebuilt from consolidated fleet data:** sample size 5,895 → 126,223 (21x increase). Correction factor 0.300 → 0.890 (realistic). Data from laptop (10,118 estimates), Mac mini (225 estimates), and NuC receiver (438 telemetry records) merged and self-improved.
- README rewritten to clarify Epoch works accurately out of the box — no data collection or account required.
- `epoch share-data` now produces valid `data/community`-compatible files with `_schema`, `description`, and `records` fields instead of a raw array.
- `windows-receiver` is documented as a historical alias only. Current references use `ubuntu-receiver`.
- Release metadata now includes explicit npm package ownership for MCP Registry publishing.
- Telemetry endpoint env overrides remain runtime-only and are not persisted back into local config.
- Telemetry submission and status now honor `EPOCH_TELEMETRY=0` disable overrides consistently.
- Telemetry submission cursors now advance after each successful chunk to avoid duplicate retries after partial failures.
- Community export validation now rejects schema-invalid required field types.
- Fleet ingestion scripts now create missing data directories and preserve distinct sessions while deduplicating.
- Weekly consolidation avoids destructive reset fallback unless checkout back to `main` succeeds.
- `addDays` now handles invalid input dates without throwing.

## [0.2.2] - 2026-05-07

### Added
- Added `epoch telemetry set-endpoint` to configure a telemetry receiver without changing opt-in state.
- Added `epoch telemetry submit` to manually send queued anonymized telemetry to the configured endpoint.
- Added `--endpoint` support to `epoch telemetry enable` and `epoch telemetry submit`.
- Added a built-in `POST /v1/telemetry` HTTP receiver that verifies HMAC signatures and writes aggregate receipt metadata to `~/.epoch/telemetry-receipts.jsonl`.
- Added `EPOCH_TELEMETRY_ENDPOINT` override support for status and submission flows.

### Changed
- `epoch telemetry status` now reports endpoint usability, queued anonymized record count, endpoint source, `lastSubmissionAt`, and `totalRecordsSubmitted`.
- Telemetry docs now describe local receiver testing, endpoint configuration, and receipt metadata.

### Fixed
- Placeholder telemetry endpoints such as `https://example.com/v1/telemetry` are now treated as not configured.
- Telemetry submission now fails clearly when no usable endpoint exists instead of pretending the placeholder endpoint is real.

## [0.2.1] - 2026-05-07

### Changed
- Renamed the canonical published package to `@kyanitelabs/epoch`.
- Updated README, site install examples, LLM discovery docs, package metadata, and AGENTS identity to use the Kyanite Labs npm scope.
- Pointed package metadata at the GitHub Pages landing page.
- Removed the stale `NPM_TOKEN` release workflow environment hook so npm trusted publishing can use OIDC.

### Notes
- `@kyanitelabs/epoch@0.2.1` was the first Kyanite-scoped npm release.
- Future releases must bump the version before publishing; npm will reject republishing an existing version.

## [0.2.0] - 2026-05-03

### Added
- Expanded Epoch to 24 structured tools across temporal reasoning, estimation, analytics, cost, risk, profiles, feedback, and calibration.
- Added the feedback loop surface: `feedbackToken` on estimation outputs, pending-estimate listing, batch actual recording, feedback health, and self-improvement support.
- Added AI-native reference baselines, scope signals, task-type calibration, complexity-aware correction factors, MdAPE/capped MdAPE reporting, trend detection, and data completeness scoring.
- Added token-cost outputs across estimation and risk tools.
- Added `docs/llms.txt` for AI-agent discovery.

### Fixed
- Hardened JSONL feedback handling, NaN/empty-array guards, critical path validation, schedule risk validation, duplicate actual rejection, and schema/output consistency across CLI, HTTP, and MCP paths.
- Routed MCP tools through the dispatcher so telemetry, feedback recording, schemas, and output formatting share one implementation path.
- Rebuilt public reference baselines from task-level data and removed misleading synthetic-data accuracy claims.

### Changed
- Switched to the ESM `tsup` build pipeline.
- Raised test coverage substantially across tools, dispatch, CLI, HTTP, calibration, and telemetry-adjacent code paths.

## [0.1.14] - 2026-05-03

### Added
- `cappedMdape` in `AccuracyMetrics` — caps individual percentage errors at 500% before computing the median, giving a more useful metric when extreme outliers exist
- `cappedMdape` field in feedback health `byTool` and `byTaskType` entries — exposes the outlier-robust accuracy metric per breakdown
- `biasLabel` helper — qualitative bias direction labels (systematic overestimation, mild overestimation, well-calibrated, mild underestimation, systematic underestimation)
- Recommendations in feedback health now show `capped MdAPE` and bias direction label instead of raw MdAPE alone
- 4 tests for cappedMdape (1), bias direction in recommendations (2), well-calibrated label (1)

### Changed
- 887 tests (was 883)

## [0.1.15] - 2026-05-03

### Added
- `trend` field in feedback health `byTool` and `byTaskType` entries — shows accuracy trajectory (improving/degrading/stable) per breakdown
- `overallCappedMdape` in data quality section — outlier-robust accuracy at the top level
- `humanReadable` summary now shows both capped and raw MdAPE
- `recordActualDetailed` — returns structured result with specific failure reason (duplicate, below_threshold, write_failed)
- `record_actual` tool returns specific error messages per failure reason (was generic "storage unavailable")
- 2 tests for trend field, 1 for accuracy-trend null guard, 2 for record_actual error messages

### Fixed
- `accuracy_trend` crash on undefined `completedAt` — null-guarded sort and dateRange formatting (reported by external dogfood session)
- `record_actual` generic error message replaced with specific reasons for each failure mode

### Changed
- 892 tests (was 887)

## [0.1.13] - 2026-05-03

### Added
- Duration validation in `criticalPath` — rejects zero, negative, and NaN durations with descriptive error messages
- Self-reference detection in `criticalPath` — rejects tasks that list themselves as predecessors
- Velocity validation in `sprintForecast` — rejects negative and NaN velocity values with index-specific error messages
- Null guard on `completedAt` in feedback matching — handles actuals with `completedAt` instead of `reportedAt`
- `bias` field in feedback health `byTool` and `byTaskType` entries — shows systematic over/under estimation direction per tool and task type
- 10 tests total (8 previous + 2 bias field tests)

### Fixed
- `matchEstimatesToActuals` sort crash when actual records lack `reportedAt` field — now falls back to `completedAt` or empty string

### Changed
- 883 tests (was 873)

## [0.1.12] - 2026-05-03

### Added
- `estimatedCost` in monte_carlo_schedule output — estimates AI token cost at p50 (50k tokens/hour × estimatedHours)
- `estimatedTokenCost` in schedule_risk output — estimates AI token cost (50k tokens/hour × estimatedHours)
- `estimatedTokenCost` in sprint_forecast output — estimates AI token cost (50k tokens/hour × totalHours)
- `estimatedTokenCost` in token_time_bridge output — estimates AI token cost (50k tokens/hour × estimatedHours)
- `estimatedTokenCost` in reference_class_estimate output — estimates AI token cost (50k tokens/hour × correctedEstimate)
- `recommendation` in feedback_health byTool entries — actionable per-tool guidance (needs data, sufficient, good coverage)
- `recommendation` in feedback_health byTaskType entries — same per-task-type actionable guidance
- `dataCompletenessScore` in feedback_health dataQuality — 0-100 score from tool coverage (40%), type coverage (30%), pair count (30%)
- 11 tests for token cost outputs (5), per-tool recommendations (3), per-task-type recommendations (2), and data completeness score (1)

### Changed
- 873 tests (was 862)
- All 5 estimation tools now provide estimatedTokenCost for consistent cost tracking

## [0.1.11] - 2026-05-03

### Added
- `taskTypeBreakdown` in schedule_risk output — shows risk level and MdAPE per task type from historical data (requires 3+ records per type)
- `estimatedTokenCost` in critical_path output — estimates AI token cost at 50k tokens/hour
- 3 tests for task-type risk breakdown (2) and CP token cost (1)

### Changed
- 862 tests (was 859)

## [0.1.10] - 2026-05-03

### Added
- `confidence` and `velocityCv` fields in sprint_forecast output — rates forecast reliability based on velocity history size and coefficient of variation (low/medium/high)
- `riskLevel` field in pert_estimate output — assesses estimation risk from spread ratio (pessimistic-optimistic)/mostLikely (low < 1.0, medium < 2.0, high ≥ 2.0)
- `aiSpeedup` and `speedupCategory` fields in cocomo_estimate output — shows AI speedup factor (nominal / LLM-adjusted) with qualitative category (moderate < 5x, significant < 10x, extreme ≥ 10x)
- 13 tests for sprint confidence (6), PERT risk level (4), and COCOMO speedup (3)

### Changed
- 859 tests (was 846)

## [0.1.9] - 2026-05-03

### Added
- `optimisticSprints` in sprint_forecast output — lower-bound sprint count using velocity + 1 std dev
- `converged` in monte_carlo_schedule output — checks p50 stability between 25% and 75% iteration checkpoints
- `task_type` optional parameter on all estimation tools (cocomo, sprint, critical_path, token_time_bridge, token_cost_estimate) — enables per-task-type accuracy tracking
- 5 tests for sprint optimistic sprints and monte carlo convergence

### Changed
- Sprint forecast uses 0.75x fallback for optimistic with single velocity data point
- 846 tests (was 842)

## [0.1.8] - 2026-05-03

### Added
- `complexity` parameter on `schedule_risk` (1-5) — complexity ≥ 4 widens confidence intervals via cone-of-uncertainty scaling
- `task_type` optional parameter on `pert_estimate` and `monte_carlo_schedule` — enables per-task-type accuracy tracking for these tools
- `mdape` in schedule_risk `historicalAccuracy` output schema (was computed but not in MCP output schema)
- 8 tests for complexity-based risk scaling and task_type propagation

### Changed
- 842 tests (was 834)

## [0.1.7] - 2026-05-03

### Added
- Complexity-aware correction factors in self-improvement engine — `complexityCorrectionFactors` stores per-task-type, per-complexity-level CFs (e.g., feature/1=0.30 vs feature/5=0.28)
- `getComplexityCorrectionFactor(taskType, complexity)` lookup with fallback to task-type CF
- `complexity` field on `HistoricalRecord` — extracted from estimate inputs and propagated through feedback pipeline
- `seedRecordsFiltered` count in feedback health report showing how many seed/synthetic records were excluded
- MdAPE as primary metric in `accuracy-trend` humanReadable output (was MAPE-only)
- 4 tests for complexity correction factors (computation, minimum threshold, lookup, null fallback)
- `scripts/` utility scripts for data analysis (health-check, check-cf, check-complexity-cf, analyze-outliers, etc.)

### Changed
- `getCorrectionFactorForTaskType` priority: complexity-aware → tool-specific → task-type → industry defaults
- `referenceClassEstimate` passes `complexity` to correction factor lookup for more targeted adjustments
- 834 tests (was 830)

## [0.1.6] - 2026-05-03

### Added
- Seed/synthetic data filter in `matchEstimatesToActuals` — excludes records with `seed-` prefixed IDs, "seed"/"synthetic"/"dogfood-seed" in notes, or actual/estimate ratio below 0.03
- `MIN_RATIO` constant (0.03) for extreme outlier detection
- `isSeedRecord` helper function for seed data classification
- 6 tests for seed data filtering (seed prefix, seed notes, synthetic notes, extreme ratio, reasonable ratio, mixed dataset)

### Changed
- Matched pairs reduced from 237 to 123 after filtering 114 seed/synthetic records
- Global correction factor updated to 0.50 (was 0.75) — reflects AI-native reality
- Task-type correction factors now range from 0.23 (documentation) to 1.01 (migration)
- 830 tests (was 824)

## [0.1.5] - 2026-05-03

### Added
- `matchedPairs` count in feedback health report — top-level and per-tool/per-taskType, distinguishing quality-filtered pairs from raw actuals
- `humanReadable` summary string in feedback health report with matched pair count, tool/type coverage, MdAPE, and recommendation
- `total_duration` hour extraction in feedback matching — enables calibration for `critical_path` estimates
- `total_duration` in dispatcher `HOUR_FIELDS` so critical_path outputs always receive feedback tokens
- Explicit tool-to-task-type lookup table replacing fuzzy string matching (`reference_class_estimate` no longer misclassified as "testing")
- Task type label in `schedule_risk` humanReadable output (e.g., "Schedule risk for feature: low")
- `scripts/self-improve.ts` utility for running self-improvement outside MCP server context
- 4 tests for matchedPairs field and orphan feedback handling
- 2 tests for task type label in schedule risk output
- 12 tests for extractEstimatedHours covering all 8 extraction paths and edge cases

### Fixed
- `calibrateEstimates` correction factor computed as `median(actual/estimated)` ratio instead of broken `1 + MdAPE/100` formula
- Adaptive window sizing in `accuracy-trend` to avoid tiny last windows
- Task type inference for estimation tools — explicit lookup replaces fragile `includes()` matching
- Feedback health output schema updated to include `matchedPairs` and `humanReadable` fields
- Global correction factor clamped to [0.1, 3.0] — was unclamped, could return 0 from zero-actual records
- Zero-actual records filtered from all correction factor computation paths
- Task-type correction factors now require minimum 3 records (was unguarded)
- Benchmark merge rounds min_ms/max_ms to avoid floating-point artifacts (e.g., 13.995 → 14.0)

### Changed
- Calibration data seeded across all 7 estimation tools (238 matched pairs, was 0)
- Global correction factor updated to 0.75 (was 0.70)
- 824 tests (was 809)

## [0.1.4] - 2026-05-03

### Added
- `estimatedHours` field on `critical_path` output (total_duration × 8) — enables feedback tokens for CPM estimates
- `self-improve` CLI command to manually trigger correction factor recomputation
- Data quality indicator in `feedback-health`: overallMdape, outlierRatio, recommendation string
- `dateRange` field in accuracy trend windows showing first-to-last record dates
- 5 tests for urgency category boundary conditions

### Fixed
- Seed data artifacts (actualHours < 0.25h) filtered from accuracy computation — MdAPE improved 150% → 100%
- AI-native correction factor bypass removed: data-driven CFs now applied when ≥5 records exist, even with AI baselines — fixes systematic 2x overestimation
- Monte Carlo and Critical Path now receive feedback tokens via `estimatedHours` output field

### Changed
- AI-native scope baselines differentiated by task type (bugfix 0.1–6h, migration 0.5–16h instead of uniform 8–10h)
- `MINIMUM_ACTUAL_HOURS` constant (0.25h) replaces inline magic number
- Global correction factor updated to 0.5 (was 0.3)

## [0.1.3] - 2026-05-02

### Added
- MdAPE (Median Absolute Percentage Error) in accuracy metrics — robust to outliers where MAPE is inflated by extreme seed data
- AI-native scope baselines derived from 139 matched estimate-actual pairs (0.1–5h vs human 4–17h)
- Correction factor floor lowered from 0.5 to 0.1 (AI-native work finishes at 0.06–0.43x of human estimates)
- 10 tests for MdAPE computation and AI-native baseline logic
- 10 tests for sprint_forecast and monte_carlo_schedule edge cases (schema validation, deterministic seeds, risk events)
- 10 tests for token_time_bridge (all 12 models, reasoning depth scaling, tool overhead, urgency, fallback calibration)
- 4 tests for cost estimation edge cases (premium vs fast cost, table formatting, urgency inheritance)
- 3 tests for schedule_risk MdAPE (outlier-robust risk levels, humanReadable output)
- 7 tests for feedback module (duplicate rejection, batch operations, MdAPE in health report)
- 6 tests for MCP adapter (ZodEffects unwrap, tool registration, read/write annotations)
- 6 tests for dispatcher routing (unknown tools, validation, feedbackToken propagation)
- NaN guards on `actual_hours` in HTTP endpoint
- Duplicate actual prevention in `recordActual`
- Self-improvement engine writes reference database to `~/.epoch/` instead of source tree

### Changed
- `referenceClassEstimate` accepts `aiNative` flag to use AI-native baselines with CF=1.0 (avoids double correction)
- `scheduleRisk` uses MdAPE (median) instead of MAPE for confidence intervals and risk classification — outlier-robust
- `accuracyTrend` uses MdAPE for trend detection (15% threshold for improving/degrading)
- `calibrateEstimates` uses MdAPE for correction factor computation
- Feedback health report includes `mdape` alongside `mape` for both by-tool and by-task-type breakdowns
- RCE CLI now supports `--scope`, `--ai-native`, `--team-id` flags
- `adjustedEstimate` rounding uses 2 decimal places (was 1, losing values like 0.045)
- Test count: 738 → 794

### Fixed
- `inferScopeFromComplexity` was a stub always returning "medium" — now maps complexity 1-2→small, 3→medium, 4→large, 5→xl
- Task-type correction factors in self-improve engine were unclamped (could produce 15x multipliers) — now clamped to [0.5, 3.0]
- `computeAccuracyMetrics` reported inflated `sample_size` including zero-actual records — now uses valid records count
- Trend computation in `computeAccuracyMetrics` split all records instead of valid records — fixed
- `batch-record-actuals` HTTP endpoint bypassed Zod schema validation — now validates types and filters invalid entries
- `record-actual` endpoint accepted `actualHours: 0` — now requires positive values
- `record-actual` validation error response missing `isError: true` field — added
- `record-actual` returned `ok: true` with `recorded: false` on write failure — now returns proper error
- Stale `llms.txt`: tool count 24→21, wrong param names (`window_days`→`window_size`, `planned_hours`→`estimated_hours`)
- Empty `NODE_AUTH_TOKEN` in release workflow — now uses `secrets.NPM_TOKEN`
- Hardcoded private IP in canary-runner for LM Studio — now defaults to `localhost:1234`
- Rate limiter map grew indefinitely under moderate load — added probabilistic expired entry cleanup
- `getFeedbackHealthReport` re-reads JSONL files N+3 times — extracted `matchEstimatesToActuals`, now reads once
- `feedbackToken` missing from OpenAPI output schemas — added to 6 estimation tool schemas
- CLI `parseFloat` silently produces NaN on invalid input — replaced with `safeFloat` wrapper (exits with error)
- `--iterative-cycles` help text showed range 0.5-2.0 but schema allows 0.5-10.0 — fixed
- TypeScript TS2345: `r.tool` (string|undefined) used as Map key — added null guard
- `criticalPath` returned `-Infinity` for empty tasks array — now returns proper error
- `monteCarloSim` returned success with zeroed percentiles for iterations<=0 — now returns error
- `extractEstimatedHours` assumed hours for unrecognized unit — now returns null (skips record)
- Self-improvement engine had race condition on concurrent `updateReferenceDatabase` — added mutex flag
- `accuracy-trend` `Math.min/max` on empty arrays produced Infinity — added guard
- 3 tools registered in tool-registry but missing from CLI (cocomo_ground_truth, batch_record_actuals, feedback_health) — added
- Tool counts stale across README, package.json, tool-registry comment — updated 21→24

### Added
- 9 canary surface tests for previously untested tools (token_cost_estimate, compare_models, accuracy_trend, schedule_risk, calibrate_estimates, cocomo_validate, get_pending_estimates, feedback_health)
- 15 tests for `formatters.ts` (previously zero coverage)
- Lint step in CI workflow
- 3 CLI commands: `batch-record-actuals`, `feedback-health`, `cocomo-ground-truth`
- 2 tests for empty criticalPath and zero monteCarlo iterations

### Changed
- Test count: 544 → 738

## [0.1.2] - 2026-05-02

### Fixed
- Division-by-zero in PERT variance, COCOMO effort, Monte Carlo triangular sample
- NaN/Infinity output guards on all estimation computation results
- Rate limiter Map growing unbounded (pruned at 10k entries)
- `parseInt` NaN fallback on `EPOCH_RATE_LIMIT` and `PORT` env vars
- Version hardcoded in entry points — centralized via `getVersion()`
- Telemetry buffer not flushed on process exit
- HTTP error handler leaking internal error messages to clients
- `recordActual` returning true even when filesystem write fails
- MCP/CLI schema drift: PERT missing "months" unit, model field too restrictive, velocity validation inconsistent, iterative_cycles not normalized in MCP path
- Non-null assertions in topological sort replaced with defensive guards
- COCOMO accepts extreme kloc values (now capped at 1e9)
- Monte Carlo accepts invalid task ordering without warning (now validates)
- Rate limiting trusts `x-forwarded-for` by default (now requires `EPOCH_TRUST_PROXY=1`)

### Added
- HTTP graceful shutdown via SIGINT/SIGTERM with telemetry flush
- 60-second TTL cache on `loadReferenceDb` (was re-reading file per request)
- Atomic file writes for reference database (write-to-tmp + renameSync)
- `EPOCH_TRUST_PROXY` env var for controlling rate limit IP resolution
- 22 telemetry tests (previously zero coverage)
- 3 edge-case tests for kloc overflow and Monte Carlo validation
- Research documentation, calibration data, and architecture diagram

### Changed
- Removed unused dependencies: `zod-to-json-schema`, `@asteasolutions/zod-to-openapi`
- Package description updated: 19 → 21 tools
- Test count: 357 → 544, coverage: 80% → 90%
- ESLint errors: 13 → 0

## [0.1.1] - 2026-05-02

### Added
- `record_actual` MCP/CLI/HTTP tool for submitting actual hours on past estimates
- `get_pending_estimates` MCP/CLI/HTTP tool for listing estimates awaiting feedback
- Estimation feedback loop: actual hours feed into self-improvement correction factors
- Developer profile correction applied consistently across MCP, CLI, and HTTP paths
- `src/version.ts` — single source of truth for version (reads package.json at runtime)
- Telemetry module tests (22 tests)
- Schema validation tests (72 tests)
- Edge-case tests for cost, accuracy-trend, and feedback modules

### Fixed
- Division-by-zero in self-improvement correction factors when estimatedHours is 0
- Division-by-zero in Monte Carlo triangular sample when optimistic equals pessimistic
- Division-by-zero in telemetry TPS calculation when elapsedMs rounds to 0
- NaN/Infinity output guards on PERT and COCOMO computation results
- Rate limiter Map growing unbounded — stale entries pruned at 10k threshold
- `parseInt` on `EPOCH_RATE_LIMIT` and `PORT` env vars without NaN fallback
- `recordActual` returning true even when filesystem write silently fails
- HTTP error handler leaking internal error messages to clients
- Version hardcoded as "0.1.0" in three entry points despite package.json being "0.1.1"
- Telemetry buffer not flushed on process exit

### Changed
- `loadReferenceDb` now caches for 60 seconds (was re-reading file 3-4x per request)
- Atomic file writes use write-to-tmp + renameSync for reference database
- HTTP `record_actual` endpoint propagates write failure in response
- Tool count: 19 → 21 (added feedback tools)
- Test count: 356 → 541

## [0.1.0] - 2026-05-01

### Added
- 19 structured MCP tools across 5 layers (temporal, calendar, estimation, analytics, cost/risk)
- Triple surface: MCP stdio server, CLI (Commander.js), REST API (Hono)
- PERT three-point estimation with confidence intervals
- COCOMO II with LLM-adapted cost drivers
- Monte Carlo schedule simulation with seeded PRNG
- Sprint velocity forecasting
- Critical Path Method with merge-bias adjustment
- Reference class forecasting with planning fallacy correction
- Token-to-time bridge for 12 LLM model families
- Token cost estimation and model comparison
- Accuracy trend tracking with sliding-window MAPE
- Schedule risk scoring with confidence intervals
- COCOMO validation against 195 historical projects
- Self-improving engine with feedback loop
- Community data pipeline with JSON Schema validation
- `ai_native` mode for dual human/AI estimation
- Built-in AI discoverability (llms.txt, OpenAPI 3.1, ai-plugin.json)
- Holiday-aware business day calculations (US, UK, FR, DE, JP)
- CI workflow with pnpm
