# Epoch

A local-first time-estimation and feedback toolkit for engineering leads, planners and AI agents. Its core experience is **estimate with explicit assumptions → preserve the estimate reference → record actual duration → inspect/calibrate error**, rather than guessing a deadline or promising that a model can finish work on time.

## Existing surfaces and features

- 26 tools exposed through stdio MCP, a Commander CLI and a local Hono REST API; [public-surface contract](src/contract/public-surface.ts) names the supported tools/routes/commands.
- Temporal/timezone/duration operations and holiday-aware business-day math; PERT, COCOMO II, sprint, critical-path and Monte Carlo estimates; reference-class/context estimates, token-time mapping, wait bounds, model-cost comparison and schedule risk.
- Estimate/actual ledgers, pending estimates, batch actual recording, feedback health/accuracy trends, optional Git-derived actuals, self-improvement and opt-in telemetry/export/receipt tooling.
- A package/library entrypoint, public agent skill, documentation/discovery pages and dataset/evaluation scripts. Hosted receiver/deployment runbooks are operator surfaces, not proof that an arbitrary installation has a working public service.

## Existing data, not fresh measurements

- [src/data/reference-database.json](src/data/reference-database.json): bundled correction factors, execution benchmarks, model latency and token-time calibration; metadata declares `sampleSize: 117791`. This aggregate is not a count of independent customer projects or all validated task-duration estimates.
- [data/cocomo-calibration-data.json](data/cocomo-calibration-data.json): **195 actual project entries** across COCOMO81, NASA93, Albrecht and Kemerer; legacy human/pre-AI data, with a documented mismatch against a higher declared count.
- [data/eval-corpus](data/eval-corpus/): a frozen **1,147-row** GitHub closing-issues corpus plus provenance/raw collection artifacts. Issue/PR calendar duration is not automatically human effort or transferable AI execution time.
- Supplementary/public benchmark data, schemas and community example format. The [corpus manifest](data/eval-corpus/MANIFEST.md) records exclusions and historical count discrepancies; do not turn its older pilot prose into today's corpus count.

## Limits

Estimates, intervals, cost tables and model profiles are only as current/representative as inputs and calibration. Core estimation does not call a paid inference model. Normal tool calls still write local telemetry/ledger data; they are not filesystem-read-only merely because most tool annotations describe computational operations. Remote telemetry is disabled by default but can be explicitly enabled/configured. Local files and exports may include sensitive task context: review before sharing. Tests and successful CLI discovery are not user-side proof of estimation accuracy, production receiver health or all-host integration.
