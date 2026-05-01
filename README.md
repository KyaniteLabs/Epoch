# Epoch

[![CI](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml/badge.svg)](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Server-green.svg)](https://modelcontextprotocol.io)

A Time Estimation MCP Server — giving LLMs accurate temporal reasoning through external tools. **14 structured tools** across **5 layers**, accessible via MCP, CLI, and REST API.

## Why This Exists

LLMs cannot track continuous wall-clock time. They have no persistent hidden state, positional encodings represent token sequence position (not real-world time), and self-attention provably cannot model counting behaviors. This leads to systematic failures in duration prediction, temporal ordering, and time estimation — especially in software engineering contexts where agents estimate in token budgets rather than minutes.

Epoch solves this by providing structured external representations that LLMs can request rather than calculate.

## Quick Start

### MCP Server (for Claude Code, Cursor, VS Code)

```bash
# Add to Claude Code
claude mcp add epoch -- npx @kyanitelabs/epoch

# Or add to .mcp.json
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
# PERT estimate
epoch pert-estimate --optimistic 2 --most-likely 4 --pessimistic 12 --unit hours

# Token-to-time bridge
epoch token-time-bridge --tokens 50000 --model claude-sonnet-4-20250514

# Monte Carlo simulation
epoch monte-carlo-schedule --tasks '[{"name":"A","optimistic":2,"most_likely":4,"pessimistic":8}]'

# List all tools
epoch list-tools

# Pretty table output
epoch pert-estimate --optimistic 2 --most-likely 4 --pessimistic 12 --pretty
```

### REST API

```bash
# Start the server
epoch serve --port 3000
# or: EPOCH_TRANSPORT=http epoch

# Call any tool
curl -X POST http://localhost:3000/v1/tools/pert_estimate \
  -H "Content-Type: application/json" \
  -d '{"optimistic": 2, "most_likely": 4, "pessimistic": 12, "unit": "hours"}'

# Health check
curl http://localhost:3000/health

# OpenAPI spec
curl http://localhost:3000/openapi.json
```

## For AI Agents

Epoch provides built-in discoverability endpoints so AI agents can find and use the API without prior configuration:

| Endpoint | Description |
|----------|-------------|
| `GET /.well-known/ai-plugin.json` | OpenAI plugin manifest |
| `GET /llms.txt` | LLM-consumable documentation |
| `GET /openapi.json` | OpenAPI 3.1 specification |
| `GET /health` | Service health and version |

## Architecture

Five-layer design with 14 tools:

| Layer | Purpose | Tools |
|-------|---------|-------|
| **Core Temporal** | Time retrieval, timezone conversion, duration parsing, date math | `get_current_time`, `convert_timezone`, `parse_duration`, `time_math` |
| **Calendar Math** | Business days, holiday awareness (US, UK, FR, DE, JP), working hours | `add_business_days`, `count_business_days` |
| **Software Estimation** | PERT, COCOMO II (LLM-adapted), sprint velocity, critical path, Monte Carlo | `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `critical_path`, `monte_carlo_schedule` |
| **Data Integration** | Reference class forecasting, accuracy calibration | `reference_class_estimate`, `calibrate_estimates` |
| **Advanced Analytics** | Token-to-wall-clock time mapping, planning fallacy correction | `token_time_bridge` |

## Tool Reference

### Core Temporal

**`get_current_time`** — Current time in any IANA timezone
```
Input:  { timezone: "America/New_York" }
Output: { iso, humanReadable, timezone, utcOffset }
```

**`convert_timezone`** — Convert a timestamp between timezones
```
Input:  { timestamp: "2026-05-01T12:00:00Z", target_tz: "Asia/Tokyo" }
Output: { iso, timezone, utcOffset, humanReadable }
```

**`parse_duration`** — Parse duration strings (`"2h30m"`, `"1d6h"`, `"45m"`)
```
Input:  { duration_string: "2h30m" }
Output: { input, totalSeconds, humanReadable }
```

**`time_math`** — Date arithmetic: `add_days`, `add_business_days`, `diff`, `convert_tz`, `parse_nl`, `format_duration`

### Calendar Math

**`add_business_days`** — Add N business days with holiday awareness (US, UK, FR, DE, JP)
```
Input:  { start_date: "2026-05-01", days: 5, country: "US" }
Output: { startDate, endDate, businessDays, countryCode }
```

**`count_business_days`** — Count business days between two dates

### Software Estimation

**`pert_estimate`** — PERT three-point estimation with confidence intervals
```
Input:  { optimistic: 2, most_likely: 4, pessimistic: 12, unit: "hours" }
Output: { expected: 5, stdDeviation: 1.67, confidence95: [1.67, 8.33], confidence99: [0, 10], urgencyCategory: "medium" }
```

**`cocomo_estimate`** — COCOMO II with LLM-adapted cost drivers (reasoning complexity, context completeness, transformation impact, iterative cycles, human oversight)

**`sprint_forecast`** — Sprint velocity forecasting from historical data
```
Input:  { backlog_points: 100, velocity_history: [20, 25, 22, 23], sprint_length_days: 14 }
Output: { requiredSprints, pessimisticSprints, completionDays, hoursPerPoint }
```

**`critical_path`** — Critical Path Method with merge-bias adjustment for parallel tasks

**`monte_carlo_schedule`** — Monte Carlo simulation with seeded PRNG for deterministic results
```
Input:  { tasks: [...], iterations: 10000 }
Output: { p10, p50, p80, p95, riskEvents, criticalPathProbability }
```

### Analytics

**`token_time_bridge`** — Map LLM token budgets to wall-clock time for 12 model families
```
Input:  { tokens: 50000, model: "claude-sonnet-4-20250514", tool_calls: 10, reasoning_depth: "deep" }
Output: { estimatedSeconds, estimatedMinutes, confidence, breakdown }
```

**`reference_class_estimate`** — Reference class forecasting with planning fallacy correction
**`calibrate_estimates`** — Team-specific accuracy calibration from historical data

## Surfaces

Epoch exposes the same 14 tools through three interfaces:

| Surface | Transport | Use Case |
|---------|-----------|----------|
| **MCP Server** | stdio | Claude Code, Cursor, VS Code, Windsurf |
| **CLI** | Direct invocation | Scripts, CI/CD, quick lookups |
| **REST API** | HTTP (Hono) | Web apps, AI agents, integrations |

Default behavior: running `epoch` with no arguments starts the MCP stdio server.

```bash
epoch                           # MCP stdio server (default)
epoch pert-estimate ...         # CLI subcommand
epoch serve --port 3000         # REST API server
EPOCH_TRANSPORT=http epoch      # REST API via env var
```

## Installation

```bash
git clone https://github.com/KyaniteLabs/Epoch.git
cd Epoch
npm install
npm run build
```

## Development

```bash
npm test          # Run test suite (139 tests)
npm run build     # Build with tsup
npm run typecheck # TypeScript strict mode check
npm run dev       # Run development server
npm run inspector # Open MCP Inspector for interactive testing
```

## Tech Stack

- **Runtime**: Node.js 22+ (ESM)
- **Language**: TypeScript 5.8 (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- **Validation**: Zod 3.24 with `.describe()` on every field
- **MCP SDK**: `@modelcontextprotocol/sdk` 1.12+
- **HTTP**: Hono (lightweight, multi-runtime)
- **CLI**: Commander.js
- **Date Handling**: `date-fns` 4.x + `date-fns-tz` 3.x
- **Build**: `tsup` (ESM output)
- **Testing**: `vitest` 3.x with v8 coverage (87%+ coverage)

## License

MIT License. See [LICENSE](./LICENSE) for full terms.
