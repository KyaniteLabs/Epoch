# Epoch product

Epoch helps engineering leads, planners and AI agents calculate duration ranges, reason about schedule/cost risk, and compare estimates with actual work. It supplies calculations and feedback instruments, not a guarantee that a deadline or model-quality prediction is correct.

## Core experience

Install `@kyanitelabs/epoch` and connect an MCP client, use the `epoch` CLI, or run the optional REST interface (`package.json`, `src/index.ts`, `src/entries/`). Tool inputs and responses are defined by `src/schemas/index.ts` and `src/dispatcher/tool-registry.ts`. Users estimate work, receive a persisted feedback reference where applicable, and record actuals to inspect accuracy and calibration.

Implemented capabilities include temporal/timezone and business-day arithmetic; PERT, COCOMO II, sprint forecasting, critical paths and Monte Carlo scheduling; reference-class/context estimates; token-time and cost comparisons; risk/accuracy analysis; and actual-recording/feedback health. The CLI can render a terminal histogram from actual Monte Carlo totals (`src/lib/monte-carlo-histogram.ts`, `docs/MONTE-CARLO-HISTOGRAM.md`). Agent skills and host plugins live in `skills/` and `plugins/`; `site/` provides static product and machine-readable discovery pages.

## Existing inputs and limits

Bundled inputs include `src/data/reference-database.json`, `data/cocomo-calibration-data.json`, `data/supplementary-database.json`, `data/public-benchmark.json`, and the sample community records under `data/community/`. The frozen issue-derived evaluation corpus is documented by `data/eval-corpus/MANIFEST.md`; `Research/agile_baselines_calibration_data.json` supports research. These have different provenance and uses: they are not interchangeable independent validation datasets. Schemas and verification scripts check structure/consistency, not universal predictive accuracy. See `LICENSING.md` and `CONTRIBUTING-data.md` before redistribution or contributions.

Feedback/configuration is local by default, with `EPOCH_DATA_DIR` overriding the default data location. Public telemetry submission is opt-in and filtered, not a promise that local logs contain no sensitive input (`docs/PRIVACY.md`, `docs/TELEMETRY.md`). Public HTTP operation needs an operator-reviewed security configuration. Plans under `docs/superpowers/` and open PRs are not shipped capabilities; this document does not claim deployed parity, live-host end-to-end success, or mirror adoption. See `qa/FOUNDATION-GAPS.md` for verification limits.
