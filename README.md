<p align="center">
  <img src="assets/epoch-hero.webp" alt="Epoch — time estimation MCP server for AI agents: PERT, COCOMO II, Monte Carlo, schedule-risk tools" width="100%">
</p>

# Epoch — Time Estimation MCP Server

[![CI](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml/badge.svg)](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE) [![MCP](https://img.shields.io/badge/MCP-Server-green.svg)](https://modelcontextprotocol.io) [![npm version](https://img.shields.io/npm/v/@kyanitelabs/epoch.svg)](https://www.npmjs.com/package/@kyanitelabs/epoch) [![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue.svg)](https://registry.modelcontextprotocol.io/servers/io.github.KyaniteLabs/Epoch)

**Epoch is a time estimation MCP server that gives AI agents 24 tools for scheduling, cost analysis, and deadline forecasting.** It replaces hallucinated timelines with data-driven estimates powered by PERT, COCOMO II, Monte Carlo simulation, and reference class forecasting — all accessible through MCP, CLI, or REST.

Built with TypeScript and the Model Context Protocol SDK, Epoch ships with a bundled reference database of 126,223 real data points. No account, no setup — accurate estimates from day one.

---

## Features

- **24 estimation tools** across six layers: time math, calendar/business-day calculation, PERT, COCOMO II, Monte Carlo, sprint forecasting, CPM, token cost analysis, and more
- **Self-improving accuracy** — record actuals and Epoch learns your team's patterns over time
- **Multi-country holiday support** — US, UK, France, Germany, and Japan built in
- **12 AI model cost comparisons** — side-by-side token pricing for Claude, GPT, Gemini, and others
- **Three interfaces** — MCP (stdio), CLI, and REST API
- **Works out of the box** — bundled reference database with no data collection required
- **MCP-native** — compatible with Claude Code, Cursor, VS Code, Windsurf, Cline, Zed, and any MCP host
- **Zero runtime dependencies beyond the SDK** — lightweight, fast startup

---

## Installation

**Requirements:** Node.js ≥ 20

### npx (no install needed)

```bash
npx @kyanitelabs/epoch
```

### npm / pnpm

```bash
npm install -g @kyanitelabs/epoch
# or
pnpm add -g @kyanitelabs/epoch
```

### Docker

```bash
docker run -it --rm ghcr.io/kyanitelabs/epoch
```

---

## Quick Start

### MCP — Claude Code

```bash
claude mcp add epoch -- npx @kyanitelabs/epoch
```

### MCP — Any Host

Add to your project's `.mcp.json`:

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

### CLI

```bash
epoch pert --optimistic 2 --likely 4 --pessimistic 12 --unit hours
epoch cocomo --kloc 15 --team-size 3
epoch monte-carlo --simulations 10000
```

### REST API

```bash
epoch --http 3000
curl http://localhost:3000/api/tools/pert_estimate -d '{"optimistic":2,"most_likely":4,"pessimistic":12,"unit":"hours"}'
```

---

## Usage

### What Can Epoch Do?

| What you want | What Epoch does | Layer |
|---|---|---|
| "How long will this take?" | PERT three-point estimates with confidence intervals | Estimation |
| "Estimate this large project" | COCOMO II with AI-speed adjustment factors | Estimation |
| "Will we hit the deadline?" | Monte Carlo schedule simulation with probability of success | Risk |
| "How many business days until launch?" | Business-day math with holiday calendars (5 countries) | Calendar |
| "What will the API calls cost?" | Token cost comparison across 12 AI models | Cost |
| "Are our estimates improving?" | Accuracy tracking with MAPE and auto-calibration | Self-improve |
| "What's the critical path?" | Critical path method (CPM) for task dependencies | Scheduling |
| "Forecast this sprint" | Sprint velocity forecasting with team-specific calibration | Agile |

### Tool Reference

#### Layer 1 — Core Temporal

| Tool | Description |
|------|-------------|
| `get_current_time` | Current wall-clock time in any IANA timezone |
| `convert_timezone` | Convert a timestamp between IANA timezones |
| `parse_duration` | Parse human-readable duration strings (e.g. `2h30m`) |
| `time_math` | Date arithmetic: add days, diff, format, convert timezone |

#### Layer 2 — Calendar Math

| Tool | Description |
|------|-------------|
| `add_business_days` | Add N business days with holiday awareness (US/UK/FR/DE/JP) |
| `count_business_days` | Count business days between two dates with holiday support |

#### Layer 3 — Estimation

| Tool | Description |
|------|-------------|
| `pert_estimate` | PERT three-point estimation with confidence intervals and urgency scoring |
| `cocomo_estimate` | COCOMO II effort estimation with AI-adjustment factors |
| `sprint_forecast` | Sprint velocity forecasting with team calibration |
| `critical_path` | Critical path method (CPM) for task dependency scheduling |
| `monte_carlo_schedule` | Monte Carlo simulation for schedule risk analysis |

#### Layer 4 — Analytics

| Tool | Description |
|------|-------------|
| `reference_class_estimate` | Estimate by comparing to similar historical tasks |
| `calibrate_estimates` | Auto-calibrate estimation parameters from recorded actuals |
| `token_time_bridge` | Map token counts to wall-clock time across models |

#### Layer 5 — Cost & Risk

| Tool | Description |
|------|-------------|
| `token_cost_estimate` | Calculate API token costs for a given workload |
| `compare_models` | Side-by-side cost, speed, and quality comparison across 12 AI models |
| `accuracy_trend` | Track estimation accuracy over time (MAPE, bias) |
| `schedule_risk` | Schedule risk assessment with configurable confidence levels |
| `cocomo_validate` | Validate COCOMO estimates against actuals |

#### Layer 6 — Feedback

| Tool | Description |
|------|-------------|
| `record_actual` | Record actual time/cost for a completed task |
| `get_pending_estimates` | List estimates awaiting actuals |
| `batch_record_actuals` | Bulk-record actuals for multiple tasks |
| `feedback_health` | Health check for the feedback/self-improvement subsystem |

---

## Examples

### Estimate a Project with COCOMO II

```
You: "How long will a 15,000 line project take with a small team?"

Claude (using Epoch):
  COCOMO II nominal: 100 person-months (traditional team)
  AI-adjusted: 9 person-months (LLM-assisted workflow)
  Schedule risk: medium (MAPE 15%, based on 28 historical features)
  Cost estimate (Claude Sonnet): ~$340 in API tokens
```

### Count Business Days

```
You: "How many working days between now and launch?"

Claude (using Epoch):
  Start: May 1, 2026
  End: July 15, 2026
  Business days: 54
  Weekend days: 16
  Holidays: 1 (Independence Day)
  Total calendar days: 75
```

### Compare AI Model Costs

```
You: "Which AI model should we use for a 50k-token job?"

Claude (using Epoch):
  gemini-2.0-flash:  $0.02 — fast, budget-friendly
  gpt-4o-mini:       $0.02 — fast, budget-friendly
  gemini-2.5-pro:    $0.37 — standard, high quality
  claude-sonnet-4:   $0.57 — standard, high quality
  Recommendation: gemini-2.0-flash for cost, claude-sonnet-4 for quality
```

---

## Agent Skill

Epoch ships a public agent skill at [`skills/epoch/SKILL.md`](skills/epoch/SKILL.md). Use `$epoch` in compatible agent hosts when you want the agent to automatically choose the right Epoch MCP or CLI workflow for time estimates, business-day math, model-cost comparison, schedule risk, and estimate-vs-actual feedback.

---

## FAQ

### Does Epoch require an API key or account?

No. Epoch runs entirely locally. The bundled reference database ships with the package — estimates work immediately with no external calls or sign-ups.

### How does self-improvement work?

When you record actuals via `record_actual`, Epoch compares them against your estimates and computes calibration adjustments. Over time, your PERT, COCOMO, and sprint estimates converge toward your team's real-world patterns. All data stays local.

### What AI models does Epoch compare?

Epoch compares pricing and speed for 12 models including Claude Sonnet/Opus, GPT-4o/4o-mini, Gemini 2.0 Flash/2.5 Pro, and others. Use `compare_models` for the full list.

### Can I use Epoch without an AI assistant?

Yes. Epoch works as a standalone CLI (`epoch pert ...`, `epoch cocomo ...`) and as a REST API server (`epoch --http 3000`). You don't need an MCP host to use it.

### What holidays are supported?

Epoch includes holiday calendars for the United States, United Kingdom, France, Germany, and Japan. Pass the `country` parameter (e.g., `"US"`, `"UK"`, `"FR"`, `"DE"`, `"JP"`) to calendar tools.

### How accurate are the estimates?

Epoch's reference database is built from 126,223 real data points. Without any team-specific data, expect estimates within 20–30% MAPE for standard software tasks. With recorded actuals and calibration, accuracy improves significantly.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on development setup, coding standards, and pull request process.

For data contributions and calibration datasets, see [CONTRIBUTING-data.md](CONTRIBUTING-data.md).

---

## License

Epoch is licensed under the [Apache License 2.0](LICENSE).

```
Copyright 2025 Kyanite Labs

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

<p align="center">
  <strong>Kyanite Labs</strong> · <a href="https://github.com/KyaniteLabs/Epoch">GitHub</a> · <a href="https://www.npmjs.com/package/@kyanitelabs/epoch">npm</a> · <a href="https://kyanitelabs.github.io/Epoch/">Docs</a>
</p>