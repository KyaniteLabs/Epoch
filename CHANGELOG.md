# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
