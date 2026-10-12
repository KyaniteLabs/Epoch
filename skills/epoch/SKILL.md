---
name: epoch
description: Use Epoch for calibrated time estimates, business-day math, and schedule risk. Covers PERT, COCOMO II, Monte Carlo, sprint forecasting, token-to-time mapping, model-cost comparison, and estimate-vs-actual feedback via MCP or CLI.
---

# Epoch

Use Epoch when a task needs grounded time, cost, schedule, or calibration answers instead of a guessed duration. Epoch is a time estimation MCP server and CLI (`npx @kyanitelabs/epoch`) with 26 tools (canonical set defined in `src/lib/tool-aliases.ts`) covering temporal math, calendar math, estimation, analytics, cost and risk, and feedback. Estimates lead with a calibrated P80 interval when enough matched history exists. At session end, `epoch auto-actuals --session <id>` records wall-clock actuals for the session's unfinished estimates, provenance-labeled `auto_wallclock` so they never silently blend with verified actuals.

## Start Here

- Read `../../README.md` for the tool-category table, MCP setup, and worked examples.
- Use the MCP server when the host can call tools directly: `npx @kyanitelabs/epoch` (or `claude mcp add epoch -- npx @kyanitelabs/epoch`).
- Use the CLI for terminal workflows: `epoch <command>`, or `node dist/index.js <command>` from a built checkout.
- Depth: `../../docs/TELEMETRY.md` and `../../docs/PRIVACY.md` describe what is stored locally; `../../docs/BINARY.md` covers the packaged binary; `../../llms.txt` is the pinned tool reference.

## Default path (do this first)

1. Classify the question before choosing a tool (MCP names; CLI uses kebab-case equivalents):
   - Timezone or duration math: `get_current_time`, `convert_timezone`, `parse_duration`, `time_math`.
   - Working-day planning: `add_business_days`, `count_business_days` (holidays for US/UK/FR/DE/JP).
   - Task/project estimates: `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `critical_path`, `monte_carlo_schedule`; free-text task descriptions: `estimate_from_context`.
   - Evidence-based calibration: `reference_class_estimate`, `calibrate_estimates`, `accuracy_trend` (CLI-only: `epoch self-improve` recomputes correction factors from feedback data).
   - Model or token economics: `token_time_bridge`, `token_cost_estimate`, `compare_models`.
   - Delivery confidence: `schedule_risk`, `cocomo_validate` (plus `cocomo_ground_truth` for ingesting ground truth).
   - Learning loop: `record_actual`, `get_pending_estimates`, `batch_record_actuals`, `feedback_health`.
2. Ask for missing quantitative inputs only when the estimate would otherwise be meaningless; label assumed defaults as assumptions.
3. Prefer `--format json` output for agent workflows, `--format table` for human summaries (`--format`/`--quiet` are root options; they work directly after `epoch`).
4. Record actuals when the work completes if an estimate or feedback token was produced.

## CLI Examples

```bash
epoch pert-estimate --optimistic 1 --most-likely 2 --pessimistic 5 --unit hours --format json
epoch count-business-days --start-date 2026-06-01 --end-date 2026-07-15 --country US
epoch compare-models --tokens 50000 --format table
epoch record-actual --estimate-id <feedback-token> --actual-hours 3.25 --notes "Completed with build and verification"
```

`compare-models` takes a single `--tokens <n>` budget (plus optional `--tool-calls`, `--reasoning-depth`, `--sort-by`); there are no separate input/output token flags.

## MCP Setup

```json
{
  "mcpServers": {
    "epoch": {
      "command": "npx",
      "args": ["@kyanitelabs/epoch"]
    }
  }
}
```

## Cautions

- Do not present an estimate as a promise. Include uncertainty, assumptions, and risk when relevant.
- Use business-day tools for calendar commitments; do not count weekdays manually.
- Use model-cost tools for LLM budget questions; do not infer current prices from memory.
- Derive AI-adjusted effort through `cocomo_estimate`'s cost-driver inputs, not a hand-waved speedup factor.
- Close the loop with `record-actual` whenever possible so Epoch improves over time.
