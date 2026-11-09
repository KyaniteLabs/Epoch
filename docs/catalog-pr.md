# Catalog PR draft — Epoch Estimator (KLH-325)

Simon opens this. Nothing in this repository submits it, and this file is not a pull request.

The listing is already on `NousResearch/hermes-agent` `main` as `plugin-catalog/epoch.yaml`, merged in [hermes-agent#149757](https://github.com/NousResearch/hermes-agent/pull/149757) at pin `36de521a89501c2b68b70251d50d32027ad96f2b` (Epoch plugin version 0.7.0). Do not open a second "add epoch" pull request while that file is present.

Open a pull request only to move that pin onto a newer Epoch commit (for example, after the demo script in this branch is on `main`). One file changes: `plugin-catalog/epoch.yaml`.

Before opening it:

1. Pin `sha` to the full 40-character commit on `KyaniteLabs/Epoch` `main` that you want reviewed. Replace every `REPLACE_WITH_FULL_SHA` below, including the image and docs URLs. Branches, tags, and short SHAs are rejected.
2. On a checkout of that commit, run `hermes plugins validate plugins/epoch-hermes --install-deps`. Read warnings before you open the PR.
3. Do not run `hermes update`. Do not restart a gateway. Do not touch a NucBox host. Do not publish npm. Do not merge the catalog PR from this repo.

`version` stays `"0.7.0"` until `plugins/epoch-hermes/plugin.yaml` changes. `tier` stays `community`.

## Title

```text
plugin-catalog: pin epoch to REPLACE_WITH_FULL_SHA
```

## Body

```markdown
Moves the Epoch catalog pin forward. Epoch posts a calibrated Monte Carlo P50/P90 (and P80/P95) on a Hermes Kanban card when a worker claims a task, and records that run's wall-clock hours when the run completes.

Surfaces (native plugin, not an MCP wrap):

- `plugin.yaml` plus `plugins/epoch-hermes/__init__.py`
- hooks: `kanban_task_claimed`, `kanban_task_completed`
- tool: `epoch_estimate`
- slash command: `/epoch`
- Kanban reads and writes go through `ctx.dispatch_tool` (`kanban_show`, `kanban_comment`) only

Secrets: none. `requires_env` is empty. The plugin does not call `get_secret`, does not read `auth.json` or `.env`, and has no hardcoded credential. A future credential would have to come from Hermes secret storage; this plugin does not need one. The Epoch child gets an allow-listed environment, so parent secrets are not passed through.

Rule 13 disclosure:

- Shells out to the configured Epoch CLI. The manifest default is `npx -y @kyanitelabs/epoch@0.7.0` (downloads Epoch from npm on first run; needs Node >= 22). That download is not covered by the catalog SHA pin. The child environment is scrubbed to PATH/HOME/locale/Node/npm/proxy variables. `EPOCH_TELEMETRY=0` is forced for plugin runs.
- Task title (first 80 characters) and an `epoch: o/m/p` hint are passed to that local CLI. Ledger, run bindings, and comments live under `<HERMES_HOME>/plugin-data/epoch/` (shared across profiles).
- Hook work runs on a short-lived background thread. Unfinished jobs stay in a profile outbox and resume the next time the plugin loads. No self-updater, no bundled binary, no gateway restart.
- `/epoch` refuses `serve`, `self-improve`, and telemetry/data mutations. Ledger writes from a gateway platform are refused unless `allow_write_slash_on_gateway` is set.

Demo (in the pinned tree, under 90 seconds, no gateway): `python plugins/epoch-hermes/scripts/demo.py`

Screenshots already in the pinned tree:

- `plugins/epoch-hermes/docs/banner.png`
- `plugins/epoch-hermes/docs/kanban-claim-comment.png`
- `plugins/epoch-hermes/docs/actual-recorded.png`
```

## File

`plugin-catalog/epoch.yaml`

```yaml
name: epoch
title: Epoch
repo: https://github.com/KyaniteLabs/Epoch
sha: REPLACE_WITH_FULL_SHA
subdir: plugins/epoch-hermes
version: "0.7.0"
description: "Calibrated time estimates on the Hermes Kanban board: when a worker claims a task, Epoch posts a Monte Carlo P50/P90 (plus P80/P95) estimate as a task comment, and when the run completes it records that run's wall-clock hours back to Epoch's ledger (auto_wallclock provenance, sanity-gated) so later estimates calibrate. Dispatcher and worker profiles can differ; the estimate-to-run binding lives next to the ledger, Kanban comments are display only. Also adds an epoch_estimate tool and /epoch. Disclosure — runs `npx -y @kyanitelabs/epoch@0.7.0` as a child process (downloads Epoch and its caret-ranged npm dependencies on first run, which the catalog pin does not cover; needs Node >=22), passing the task title and its three-point hint to the local CLI; the child env is scrubbed (allow-listed PATH/HOME/locale/Node/npm/proxy vars only, the parent environment is never passed through); estimates, actuals and run bindings live under <HERMES_HOME>/plugin-data/epoch/ and are shared by every profile; Epoch telemetry is forced off for plugin runs; no network besides the npm download, no API key; hook work runs on short-lived background threads and unfinished jobs resume when the plugin next loads; /epoch passes other Epoch subcommands through (it refuses serve, self-improve and telemetry/data mutations, and refuses ledger writes on gateway platforms unless opted in)."
maintainer: KyaniteLabs
tier: community
category: tools
requires_hermes: ">=0.21.6"
docs_url: https://github.com/KyaniteLabs/Epoch/tree/REPLACE_WITH_FULL_SHA/plugins/epoch-hermes#readme
image: https://raw.githubusercontent.com/KyaniteLabs/Epoch/REPLACE_WITH_FULL_SHA/plugins/epoch-hermes/docs/banner.png
screenshots:
  - https://raw.githubusercontent.com/KyaniteLabs/Epoch/REPLACE_WITH_FULL_SHA/plugins/epoch-hermes/docs/kanban-claim-comment.png
  - https://raw.githubusercontent.com/KyaniteLabs/Epoch/REPLACE_WITH_FULL_SHA/plugins/epoch-hermes/docs/actual-recorded.png
readme: true
platforms: []
known_issues:
  - "First run downloads Epoch from npm; an npm min-release-age policy can block the pinned version until it ages (the job stays queued and retries)."
capabilities:
  provides_tools: [epoch_estimate]
  provides_hooks: [kanban_task_claimed, kanban_task_completed]
  provides_middleware: []
  requires_env: []
```
