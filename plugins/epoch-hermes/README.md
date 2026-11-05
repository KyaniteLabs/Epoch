# Epoch for Hermes (native plugin)

Calibrated P50/P80/P95 estimates on your Hermes Kanban board.

| Surface | What it does |
|---|---|
| `kanban_task_claimed` hook | Estimates the task and posts a comment. A body line `epoch: 2/4/10h` (optimistic/most-likely/pessimistic) gives a Monte Carlo P50/P80/P95; otherwise a reference-class point estimate from the title. Runs on a daemon thread, never delays worker spawn. |
| `kanban_task_completed` hook | Records wall-clock hours (`completed_at - started_at`) against the stored Epoch `feedbackRef`, so estimates calibrate. |
| `/epoch <subcommand> [flags]` | Any Epoch CLI subcommand, e.g. `/epoch pert-estimate --optimistic 2 --most-likely 4 --pessimistic 10`. |
| `epoch_estimate` tool | Agent-callable estimate. |

## Install

```bash
hermes plugins install KyaniteLabs/Epoch --subdir plugins/epoch-hermes   # or symlink into ~/.hermes/plugins/epoch
hermes plugins enable epoch
```

Requires Node >= 22 and `npx` on PATH. No API key or secret. Settings (all optional) under
`plugins.entries.epoch.settings` in `config.yaml`: `epoch_command` (default
`npx -y @kyanitelabs/epoch@0.6.0`; set to `epoch` if installed globally), `comment_on_claim`,
`record_actuals`, `iterations`, `timeout_seconds`.

## Privacy

Estimates and actuals live in Epoch's local ledger. Epoch telemetry is off unless you run
`epoch telemetry enable`. Kanban task titles/bodies are passed to the local Epoch CLI only.

The MCP server + skills for Claude/Cursor stay in [`../epoch`](../epoch).
