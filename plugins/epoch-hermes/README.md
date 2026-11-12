# Epoch for Hermes (native plugin)

Epoch tells you how long a task will probably take, and how long it could take in the worst case, based on your own past tasks.

P50/P90 estimates on your Hermes Kanban board, calibrated against the actuals you record. They are forecasts, not commitments.

![Epoch for Hermes Kanban](docs/banner.png)

> **Disclosure.** This plugin shells out to `npx -y @kyanitelabs/epoch@0.8.0` (downloads Epoch
> from npm on first run; needs **Node >= 22** and `npx` on `PATH`). The child process gets a
> **scrubbed environment**: only the variables listed under "Environment passed to Epoch" below.
> Your parent environment, API keys and Hermes secrets are never passed through. The ledger and run bindings live under
> `<HERMES_HOME>/plugin-data/epoch/` (the root Hermes home, shared by every profile) unless you set
> `epoch_data_dir`. Epoch telemetry is **forced off** for every plugin run (`EPOCH_TELEMETRY=0`,
> which overrides `epoch telemetry enable`). Apart from the npm download there is no network
> access, and no API key. The task title (first 80 chars) and its `epoch:` hint go only to the
> local CLI. Hook work runs on a short-lived background thread.

> **Host dependency.** The Desktop dashboard backend (`dashboard/plugin_api.py`) reads Kanban through
> Hermes internals (`hermes_cli.kanban_db`, `kanban_db_connect`, `kanban_db_boards`) and your plugin
> settings through `hermes_cli.config`. These are not a public Hermes API. If they are missing or
> renamed, `/tasks` answers with an empty list and a "Kanban is not available" note, `/forecast`
> answers 503, and the hooks, the `/epoch` command and the tool keep working.

| Surface | What it does |
|---|---|
| `kanban_task_claimed` hook | Estimates the task and posts a comment. An `epoch: 2/4/10h` line (optimistic/most-likely/pessimistic in hours; `min`, `d` = 8h days and `w` = 5-day weeks also work; without a unit, qualifiers such as `roughly`, `approx` or `maybe` may be followed by commentary (`roughly blocked`), while unsupported units (`sprints`) and unqualified prose (`for the API`) are refused) in the title or body gives a Monte Carlo P50/P90 (plus P80/P95); otherwise a reference-class point estimate. A malformed or out-of-order hint is named in the comment and ignored, never silently dropped. Runs in the background, never delays worker spawn. |
| `kanban_task_completed` hook | Records that run's wall-clock hours (`run.ended_at - run.started_at`) against the run's own Epoch `feedbackRef` with `calibration_provenance: auto_wallclock`, so Epoch's wall-clock sanity gate applies: the run must take 0.05–12h and stay within 10× of the estimate in either direction, so a run more than 10× faster than its estimate is rejected too. Rejected actuals are explained on the card. |
| `/epoch <subcommand> [flags]` | Epoch CLI subcommands, e.g. `/epoch pert-estimate --optimistic 2 --most-likely 4 --pessimistic 10`. `serve`, `self-improve`, `share-data`, any `--output` path and telemetry/data mutations are refused (only `telemetry status`, `data where` and `data status` run). Ledger writes (`record-actual`, `batch-record-actuals`, `auto-actuals`, `mine-git`, `calibrate-estimates`) are refused on gateway platforms (Telegram, Discord, …) unless `allow_write_slash_on_gateway: true`. Estimate commands still append their estimate to the local ledger from any platform; that is how a later actual finds it. |
| `epoch_estimate` tool | Agent-callable estimate. Explicit `optimistic`/`most_likely`/`pessimistic` hours (all three, `0 < o <= m <= p`) override any text hint; invalid values are rejected. |
| `epoch_show` tool | Opens the enabled Desktop page with `view: "bars"` (Distribution), `"cdf"` (Chance done by), or `"dots"` (50 dots), optionally focusing a Kanban card by `item_id`. |

## Install

```bash
hermes plugins install KyaniteLabs/Epoch/plugins/epoch-hermes   # or symlink into ~/.hermes/plugins/epoch
hermes plugins enable epoch
```

Enable it in every profile that runs a Kanban dispatcher or worker. Requires Hermes >= 0.21.6,
Node >= 22 and `npx` on PATH. No API key or secret. The first claim may take a few seconds while
`npx` downloads Epoch; an npm `min-release-age` policy can block the pinned version until it ages
(the job stays in the outbox and retries). Settings (all optional) under `plugins.entries.epoch.settings` in
`config.yaml`:

| Setting | Default | |
|---|---|---|
| `epoch_command` | `npx -y @kyanitelabs/epoch@0.8.0` | Set to `epoch` if installed globally. |
| `epoch_data_dir` | unset → `<HERMES_HOME>/plugin-data/epoch` | Epoch ledger + run bindings (passed as `EPOCH_DATA_DIR`). The default resolves to the root Hermes home even under `profiles/<name>`, so dispatcher and worker share it. Set `~/.epoch` to reuse a standalone Epoch ledger. An `EPOCH_DATA_DIR` env var is honored when this is unset. |
| `comment_on_claim` | `true` | Post the estimate comment. |
| `record_actuals` | `true` | Record wall-clock actuals on completion. |
| `iterations` | `5000` | Monte Carlo iterations. |
| `timeout_seconds` | `60` | Per Epoch CLI call. |
| `shutdown_wait_seconds` | `20` | How long an exiting process waits for in-flight Epoch work. |
| `allow_write_slash_on_gateway` | `false` | Allow `/epoch` ledger-writing commands from gateway platforms. |
| `allow_ledger_read_on_gateway` | `false` | Allow `/epoch` commands that read the ledger (`get-pending-estimates`, `accuracy-trend`, `feedback-health`, `data status`, `reference-class-estimate`, ...) from gateway platforms. Off by default because the ledger holds task text from every profile. Gateways always allow the pure calculators (`pert-estimate`, `parse-duration`, ...). Local use (CLI, TUI, Desktop) is unaffected. |

### Environment passed to Epoch

Only these variables reach the `npx` child, and only when set in the parent: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `TMP`, `TEMP`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `NODE_EXTRA_CA_CERTS`, `NVM_DIR`, `NVM_BIN`, `VOLTA_HOME`, `FNM_DIR`, `npm_config_cache`, `npm_config_registry`, `npm_config_prefix`, `npm_config_userconfig` (and their upper-case forms), `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lower-case), `SSL_CERT_FILE`, `SSL_CERT_DIR`.
Epoch itself adds `EPOCH_DATA_DIR`, `EPOCH_TELEMETRY=0`, `NO_COLOR`, `NO_UPDATE_NOTIFIER`,
`npm_config_update_notifier=false` and `npm_config_fund=false`. `NODE_OPTIONS` is always dropped,
because it can preload code into Node. The registry, cache, CA and proxy variables stay because
`npx` needs them to download Epoch; proxy URLs may carry credentials, and `HOME` lets npm read
your `~/.npmrc`, so keep secrets out of those if you do not want npm to see them.

## What it looks like

On claim, an estimate lands on the card:

![Estimate comment on claim](docs/kanban-claim-comment.png)

On completion, that run's wall-clock actual is recorded back to the ledger:

![Actual recorded on completion](docs/actual-recorded.png)

These are renders of verbatim comment text from a real run (epoch-hermes 0.7.0 plus
`npx @kyanitelabs/epoch@0.7.0` on a Hermes Kanban board).

### Desktop pane

The page reacts to agent tool calls via local Desktop events: successful estimates and recorded actuals refresh it, and `epoch_show` opens the page, switches chart view and optionally selects a card.
Events contain only refresh signals or bounded view/card ids; they carry no task text, file contents, paths or credentials.
Check that Epoch is on in Desktop Capabilities -> Plugins; enabling the pane is the one step a person does, then the agent can open it with `epoch_show`.
`/epoch status` repeats this guidance without claiming a Desktop listener is connected; older Hermes builds without the event bridge keep the estimation tools working.

Hermes Desktop gets an **Epoch** page (sidebar: Epoch). Pick an open Kanban card with an
`epoch: o/m/p` hint and it draws the Monte Carlo spread: a histogram, a "chance done by" curve or
50 equally likely outcomes, with P10–P95 markers, the P50–P90 likely range, the risks that could
push it out, and estimate-vs-actual from your ledger. Chart settings (colour, bar style, markers,
units) stay with you. Cards that already have an estimate show a `P50 · P90` badge on the board.

![Epoch Desktop pane](docs/desktop-pane.png)

That render uses sample data. Viewing a chart never writes the ledger: each forecast runs in a
throwaway data dir with a fixed seed, so the same hint always draws the same chart. The full
spread needs Epoch 0.8 or later; older Epochs show the percentiles only.

The page's backend lives in the plugin on the Hermes host (`/api/plugins/epoch/*`). The page itself
loads from `~/.hermes/desktop-plugins/epoch-hermes/plugin.js` (the folder takes the plugin's install name) on the machine running Desktop. When Desktop
connects to a remote Hermes, copy only `desktop/plugin.js` to that path on the Desktop machine; the
plugin, ledger and Epoch CLI stay on the Hermes host.

## How it works

- **Shared bindings, comments for display.** The dispatcher (claim) and the assignee's worker
  (complete) usually run in different profiles, and plugin state is per profile. The authoritative
  `run → feedbackRef` binding is written next to the ledger (default
  `<HERMES_HOME>/plugin-data/epoch/`, which every profile resolves to). Kanban comments still show
  `[epoch:estimate run=<run_id> ref=<feedbackRef>]` for humans, but forged or quoted markers are
  never trusted for recording. A late result from a reclaimed run is dropped, because the plugin
  re-checks that the claim still owns the task before it posts. Comment delivery is tracked
  separately from the ledger `recorded` flag and is claimed under the same bindings flock, so
  concurrent success/duplicate recorders and concurrent claim racers cannot double-post the audit
  comment. A crash after the board accepts the comment but before the local delivery flag flips
  can still retry (at-least-once for that crash window only); calibration data is never duplicated.
- **Either event order.** If a task finishes before its estimate is ready (a short task, or a
  slow first `npx`), the claim side records the actual after it stores the binding. Epoch accepts
  one actual per estimate, and the bindings store marks the run recorded, so each run is recorded
  once.
- **Process lifecycle.** Each job goes into a profile-local outbox before it starts. Outbox
  updates take a cross-process lock so concurrent Hermes processes cannot lose an enqueue or
  double-claim a lease. When the process exits, the plugin waits up to `shutdown_wait_seconds`
  for in-flight work. Anything left over (for example, a one-shot CLI that exits or is killed)
  replays the next time the plugin loads in that profile, up to 5 attempts within 7 days.
- **Missed completions are caught.** The completion hook fires only in the profile that finished
  the run. If that profile does not enable the plugin, the run's actual would never be recorded.
  So at load, on new claims and on dispatcher ticks at most every 10 minutes, the plugin checks up to 25 unrecorded
  runs against the board, logs a WARNING for each one that completed, and records it.
- **Public Hermes surface only.** Board reads and writes go through `ctx.dispatch_tool`
  (`kanban_show`, `kanban_comment`). Background threads run under `contextvars.copy_context()`,
  so the event's profile settings and state follow the job.

## Tests

Needs `pytest` and `hypothesis` (the binding state-machine property test).

```bash
python -m pytest plugins/epoch-hermes/tests               # unit + fake-Epoch regression tests
HERMES_AGENT_SRC=/path/to/hermes-agent python -m pytest plugins/epoch-hermes/tests   # + real Hermes, separate processes
node --experimental-vm-modules plugins/epoch-hermes/tests/test_pane_events.mjs   # shipped Desktop ESM + REST races
```

## Privacy

Estimates and actuals live in Epoch's local ledger under `<HERMES_HOME>/plugin-data/epoch/`.
Plugin-driven Epoch runs always have telemetry off (`EPOCH_TELEMETRY=0`). Standalone Epoch
telemetry is opt-in (`epoch telemetry enable`) and the plugin never turns it on. Task text goes
only to the local Epoch CLI, which runs with a scrubbed environment.

The MCP server and skills for Claude/Cursor are in [`../epoch`](../epoch).

## Known issues

- Epoch 0.7.0 did not screen path flags in `/epoch` pass-through. `/epoch share-data --output <path>` or `/epoch community-export --output <path>` could write a local JSON export (anonymized estimate records) to that path, including from gateway platforms. No data left the machine. 0.9.0 refuses `share-data` and any `--output` or `-o` path from `/epoch`. 0.7.0 and 0.8.0 do not.

## License

Apache-2.0. See [LICENSE](LICENSE). Epoch is an independent project by KyaniteLabs and is not endorsed by Nous Research.
