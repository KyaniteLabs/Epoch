# Epoch plugin

![Epoch icon](icon.png)

Calibrated time estimation for AI agents. The plugin adds the Epoch MCP
server (26 tools) and the `epoch` skill to your agent.

Plugin bundle **0.6.0** pins the runtime **@kyanitelabs/epoch 0.6.0**
(`npx -y @kyanitelabs/epoch@0.6.0`, stdio).

## Install

```
/plugin install epoch --marketplace KyaniteLabs/Epoch
```

## What it adds

- **MCP server `epoch`** — 26 tools covering temporal math, business-day
  calendars, PERT / COCOMO II / Monte Carlo estimation, sprint forecasting,
  reference-class calibration, token-time and model-cost bridges, schedule
  risk, and an estimate-vs-actual feedback loop.
- **Skill `epoch`** — when to call which tool, with CLI examples.

## Requirements

Node.js >= 22 and npm (for `npx`). No account, API key, or setup required:
Epoch ships with a bundled reference database, and estimates and feedback
are stored in local files on your machine.

Telemetry is off by default (`EPOCH_TELEMETRY=0`); opting in is a
human-only decision, never the agent's. Details:

- Privacy: <https://github.com/KyaniteLabs/Epoch/blob/main/docs/PRIVACY.md>
- Telemetry: <https://github.com/KyaniteLabs/Epoch/blob/main/docs/TELEMETRY.md>

## Health check

```bash
npx -y @kyanitelabs/epoch@0.6.0 --version   # -> 0.6.0
```

## Links

- Homepage / docs: <https://kyanitelabs.github.io/Epoch/>
- Tool reference: <https://github.com/KyaniteLabs/Epoch/blob/main/llms.txt>
- Issues: <https://github.com/KyaniteLabs/Epoch/issues>
- Security contact: admin@kyanitelabs.tech (see [SECURITY.md](https://github.com/KyaniteLabs/Epoch/blob/main/SECURITY.md))
- License: Apache-2.0 ([LICENSE](LICENSE))
