---
name: epoch
description: Use Epoch for time estimation, business-day math, PERT/COCOMO/Monte Carlo forecasting, token cost comparison, schedule risk, and estimate-vs-actual feedback. Trigger when an agent needs realistic duration, deadline, model-cost, or planning calibration instead of a vibes-based guess.
---

# Epoch

Use Epoch when a task needs grounded time, cost, schedule, or calibration answers. Epoch is both an MCP server and a CLI, with 25 tools covering temporal math, calendar math, estimation (including estimate_from_context for free-text classification), analytics, cost and risk, and feedback. Estimates lead with a calibrated P80 interval when enough matched history exists. At session end, `epoch auto-actuals --session <id>` (or the installed Stop hook) auto-records wall-clock actuals for the session's unfinished estimates, provenance-labeled `auto_wallclock` so they never silently blend with verified actuals.

## Start Here

- Read `../../README.md` for tool categories, MCP setup, and examples.
- Read `../../package.json` for the package name, binary name, and verification scripts.
- Use the MCP server when the host can call tools directly: `npx @kyanitelabs/epoch`.
- Use the CLI for terminal workflows: `epoch <command>` or `node dist/index.js <command>` from a built checkout.

## Workflow

1. Classify the question before choosing a tool:
   - Timezone or duration math: `get-current-time`, `convert-timezone`, `parse-duration`, `time-math`.
   - Working-day planning: `add-business-days`, `count-business-days`.
   - Task/project estimates: `pert-estimate`, `cocomo-estimate`, `sprint-forecast`, `critical-path`, `monte-carlo-schedule`.
   - Evidence-based calibration: `reference-class-estimate`, `calibrate-estimates`, `accuracy-trend`, `self-improve`.
   - Model or token economics: `token-time-bridge`, `token-cost-estimate`, `compare-models`.
   - Delivery confidence: `schedule-risk`, `cocomo-validate`.
   - Learning loop: `record-actual`, `get-pending-estimates`, `batch-record-actuals`, `feedback-health`.
2. Ask for missing quantitative inputs only when the estimate would otherwise be meaningless. Reasonable defaults are acceptable for exploratory planning, but label them as assumptions.
3. Prefer JSON output for agent workflows and table output for human summaries.
4. Record actuals when the work completes if an estimate or feedback token was produced.

## CLI Examples

```bash
epoch pert-estimate --optimistic 1 --most-likely 2 --pessimistic 5 --unit hours --format json
epoch count-business-days --start-date 2026-06-01 --end-date 2026-07-15 --country US
epoch compare-models --tokens 50000 --format table
epoch record-actual --estimate-id <feedback-token> --actual-hours 3.25 --notes "Completed with build and verification"
```

`--format`/`--quiet` are root options: they work directly after `epoch` (e.g. `epoch --format table compare-models --tokens 50000`) and, with this commander version, after the subcommand's own options as shown above. Every example above was executed verbatim against the built CLI (`node dist/index.js <command>`) and exits 0 when given valid inputs; `compare-models` takes a single `--tokens <n>` budget (plus optional `--tool-calls`, `--reasoning-depth`, `--sort-by`) — there are no separate input/output token flags.

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

## Guardrails

- Do not present an estimate as a promise. Include uncertainty, assumptions, and risk when relevant.
- Use business-day tools for calendar commitments; do not count weekdays manually.
- Use model-cost tools for LLM budget questions; do not infer current prices from memory.
- Close the loop with `record-actual` whenever possible so Epoch improves over time.
