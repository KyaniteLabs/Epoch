# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `pert_estimate`'s headline `adjustedEstimate` value shifts when the (opt-in, default OFF) `EPOCH_PERT_LEARNED_CORRECTION` flag is enabled: for a given `task_type`, once the learned (`pert_estimate`, `task_type`) correction factor has at least `MIN_RECORDS_PER_FACTOR` (3) matched, exclusion-filtered estimate/actual pairs, that learned factor REPLACES the `ai_native` developer-profile correction factor in the `adjustedEstimate` computation (never multiplied with it). Below that threshold, behavior is unchanged. No output keys are added or removed. See `scripts/backtest-pert-correction.mjs` for the MdAPE/median-ratio backtest guard that gates recommending the flag be turned on.

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
