# Epoch for Hermes (native plugin)

Calibrated P50/P90 estimates on your Hermes Kanban board.

| Surface | What it does |
|---|---|
| `kanban_task_claimed` hook | Estimates the task and posts a comment. An `epoch: 2/4/10h` line (optimistic/most-likely/pessimistic; `d` = 8h days) in the title or body gives a Monte Carlo P50/P90 (plus P80/P95); otherwise a reference-class point estimate. A malformed or out-of-order hint is named in the comment and ignored, never silently dropped. Runs in the background, never delays worker spawn. |
| `kanban_task_completed` hook | Records that run's wall-clock hours (`run.ended_at - run.started_at`) against the run's own Epoch `feedbackRef` with `calibration_provenance: auto_wallclock`, so Epoch's wall-clock sanity gate (0.05–12h, <10× the estimate) applies. Rejected actuals are explained on the card. |
| `/epoch <subcommand> [flags]` | Any Epoch CLI subcommand, e.g. `/epoch pert-estimate --optimistic 2 --most-likely 4 --pessimistic 10`. |
| `epoch_estimate` tool | Agent-callable estimate. Explicit `optimistic`/`most_likely`/`pessimistic` hours (all three, `0 < o <= m <= p`) override any text hint; invalid values are rejected. |

## Install

```bash
hermes plugins install KyaniteLabs/Epoch/plugins/epoch-hermes   # or symlink into ~/.hermes/plugins/epoch
hermes plugins enable epoch
```

Enable it in every profile that runs a Kanban dispatcher or worker. Requires Node >= 22 and `npx`
on PATH. No API key or secret. Settings (all optional) under `plugins.entries.epoch.settings` in
`config.yaml`:

| Setting | Default | |
|---|---|---|
| `epoch_command` | `npx -y @kyanitelabs/epoch@0.6.0` | Set to `epoch` if installed globally. |
| `epoch_data_dir` | unset (`~/.epoch`) | Pins Epoch's ledger (`EPOCH_DATA_DIR`). Set it to the same path in the dispatcher and worker profiles if their `HOME` differs. |
| `comment_on_claim` | `true` | Post the estimate comment. |
| `record_actuals` | `true` | Record wall-clock actuals on completion. |
| `iterations` | `5000` | Monte Carlo iterations. |
| `timeout_seconds` | `60` | Per Epoch CLI call. |
| `shutdown_wait_seconds` | `20` | How long an exiting process waits for in-flight Epoch work. |

## How it works

- **Board-scoped, run-scoped correlation.** The dispatcher (claim) and the assignee's worker
  (complete) usually run in different profiles, and plugin state is per profile. So the estimate
  comment carries a marker, `[epoch:estimate run=<run_id> ref=<feedbackRef>]`, on the shared board.
  Completion looks up the marker for its own `run_id`. A late result from a reclaimed run is
  dropped, because the plugin re-checks that the claim still owns the task before it posts.
- **Either event order.** If a task finishes before its estimate is ready (a short task, or a
  slow first `npx`), the claim side records the actual after it posts the estimate. Epoch accepts
  one actual per estimate, and an `[epoch:actual run=…]` marker short-circuits repeats, so each
  run is recorded once.
- **Process lifecycle.** Each job goes into a profile-local outbox before it starts. When the
  process exits, the plugin waits up to `shutdown_wait_seconds` for in-flight work. Anything left
  over (for example, a one-shot CLI that exits or is killed) replays the next time the plugin
  loads in that profile, up to 5 attempts within 7 days.
- **Public Hermes surface only.** Board reads and writes go through `ctx.dispatch_tool`
  (`kanban_show`, `kanban_comment`). Background threads run under `contextvars.copy_context()`,
  so the event's profile settings and state follow the job.

## Tests

```bash
python -m pytest plugins/epoch-hermes/tests               # unit + fake-Epoch regression tests
HERMES_AGENT_SRC=/path/to/hermes-agent python -m pytest plugins/epoch-hermes/tests   # + real Hermes, separate processes
```

## Privacy

Estimates and actuals live in Epoch's local ledger. Epoch telemetry is off unless you run
`epoch telemetry enable`. Kanban task titles and bodies go only to the local Epoch CLI.

The MCP server and skills for Claude/Cursor are in [`../epoch`](../epoch).
