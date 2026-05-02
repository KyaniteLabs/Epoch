# Epoch -- Time Estimation MCP Server

[![CI](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml/badge.svg)](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE) [![MCP](https://img.shields.io/badge/MCP-Server-green.svg)](https://modelcontextprotocol.io) [![npm version](https://img.shields.io/npm/v/@puenteworks/epoch.svg)](https://www.npmjs.com/package/@puenteworks/epoch) [![Tests](https://img.shields.io/badge/tests-677-brightgreen.svg)]()

**Epoch helps AI agents understand time.**

AI can write code, analyze data, and build apps -- but it can't tell you how long something will take, what it'll cost, or whether a deadline is realistic. Epoch fixes that.

---

## Show Me

```
You: "How long will a 15,000 line project take with a small team?"

Claude (using Epoch):
  Expected effort: 45 person-months
  Duration: 8.3 months with 5-6 people
  Schedule risk: medium (62% confidence)
  Recommendation: add 2-week buffer for integration testing
  Cost estimate (Claude Sonnet): ~$340 in API tokens
```

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

```
You: "Which AI model should we use for a 50k-token job?"

Claude (using Epoch):
  claude-sonnet-4: $0.45 -- fast, high quality
  gpt-4o:          $0.55 -- fast, high quality
  gemini-2.5-pro:  $0.35 -- medium speed, high quality
  Recommendation: gemini-2.5-pro (best value for this workload)
```

## Why Epoch?

Every AI agent hallucinates timelines. "This should take about 2 hours" becomes 2 days. Epoch gives AI grounded, data-driven estimates instead of guesses. It packages decades of software engineering research into 21 tools any AI can call -- so your assistant stops guessing and starts calculating.

## What is MCP?

MCP (Model Context Protocol) is how AI assistants like Claude connect to external tools. Think of it like a plugin system -- you add Epoch with one command, and suddenly your AI assistant can estimate timelines, calculate business days, compare model costs, and predict whether your project will finish on time.

## Quick Start

**30-second setup -- works in Claude Code, Cursor, VS Code, and Windsurf:**

```bash
claude mcp add epoch -- npx @puenteworks/epoch
```

That's it. Your AI assistant now has 19 time estimation tools.

Or add it to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "epoch": {
      "command": "npx",
      "args": ["@puenteworks/epoch"]
    }
  }
}
```

## What Can Epoch Do?

| What you want | What Epoch does | No jargon |
|---|---|---|
| "How long will this take?" | Gives you a realistic estimate with best/worst case ranges | Estimates |
| "Can we hit this deadline?" | Tells you if your timeline is realistic or risky | Schedule risk |
| "How much will the AI calls cost?" | Calculates token costs across 12 AI models side-by-side | Cost comparison |
| "How many business days between now and launch?" | Counts days excluding weekends and holidays (5 countries) | Calendar math |
| "Are our estimates getting better?" | Tracks your accuracy over time and auto-corrects | Self-improving |
| "What model should we use?" | Compares speed, cost, and quality across all major AI models | Model comparison |

---

# Technical Reference

Everything below is for developers who want to understand the internals, use the CLI or REST API, or contribute to Epoch.

## Architecture

Five-layer design with 21 tools for time estimation, scheduling, and cost analysis:

| Layer | Purpose | Tools |
|-------|---------|-------|
| **1. Core Temporal** | Time, timezones, duration, date math | `get_current_time`, `convert_timezone`, `parse_duration`, `time_math` |
| **2. Calendar Math** | Business days, holidays (US/UK/FR/DE/JP) | `add_business_days`, `count_business_days` |
| **3. Estimation** | PERT, COCOMO II, sprint, CPM, Monte Carlo | `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `critical_path`, `monte_carlo_schedule` |
| **4. Analytics** | Reference class, calibration, token-time bridge | `reference_class_estimate`, `calibrate_estimates`, `token_time_bridge` |
| **5. Cost & Risk** | Token cost, model comparison, accuracy trends, risk, COCOMO validation | `token_cost_estimate`, `compare_models`, `accuracy_trend`, `schedule_risk`, `cocomo_validate` |

## Tool Reference

### Layer 1 -- Core Temporal

**`get_current_time`** -- Current wall-clock time in any IANA timezone

```
Input:  { timezone: "America/New_York" }
Output: {
  iso: "2026-05-01T08:30:00.000-04:00",
  humanReadable: "Fri, May 1, 2026, 8:30 AM EDT",
  timezone: "America/New_York",
  utcOffset: -240
}
```

**`convert_timezone`** -- Convert a timestamp between IANA timezones

```
Input:  { timestamp: "2026-05-01T12:00:00Z", target_tz: "Asia/Tokyo" }
Output: {
  iso: "2026-05-01T21:00:00.000+09:00",
  timezone: "Asia/Tokyo",
  utcOffset: 540,
  humanReadable: "Fri, May 1, 2026, 9:00 PM JST"
}
```

**`parse_duration`** -- Parse human-readable duration strings

```
Input:  { duration_string: "2h30m" }
Output: {
  input: "2h30m",
  totalSeconds: 9000,
  humanReadable: "2 hours 30 minutes"
}
```

**`time_math`** -- Date arithmetic operations

```
Input:  { operation: "add_days", date: "2026-05-01", value: 7 }
Output: {
  result: "2026-05-08T00:00:00.000Z",
  operation: "add_days",
  input: "2026-05-01"
}
```

Supported operations: `add_days`, `add_business_days`, `diff`, `convert_tz`, `parse_nl`, `format_duration`

### Layer 2 -- Calendar Math

**`add_business_days`** -- Add N business days with holiday awareness (US, UK, FR, DE, JP)

```
Input:  { start_date: "2026-05-01", days: 5, country: "US" }
Output: {
  startDate: "2026-05-01",
  endDate: "2026-05-08",
  businessDays: 5,
  weekendDays: 2,
  holidays: 0,
  countryCode: "US"
}
```

**`count_business_days`** -- Count business days between two dates

```
Input:  { start_date: "2026-05-01", end_date: "2026-05-15", country: "US" }
Output: {
  startDate: "2026-05-01",
  endDate: "2026-05-15",
  businessDays: 10,
  weekendDays: 4,
  holidays: 1,
  countryCode: "US"
}
```

### Layer 3 -- Estimation

**`pert_estimate`** -- PERT three-point estimation with confidence intervals and urgency scoring

```
Input:  {
  optimistic: 2,
  most_likely: 4,
  pessimistic: 12,
  unit: "hours",
  ai_native: true
}
Output: {
  expected: 5,
  stdDeviation: 1.67,
  confidence95: [1.67, 8.33],
  confidence99: [0, 10],
  urgencyCategory: "medium",
  aiNative: true,
  correctionFactor: 1.8
}
```

**`cocomo_estimate`** -- COCOMO II software sizing with LLM-adapted cost drivers

```
Input:  {
  kloc: 15,
  project_type: "organic",
  cost_drivers: { complexity: "nominal", reliability: "high" },
  ai_native: true
}
Output: {
  effort: 45.2,
  duration: 8.3,
  staff: 5.4,
  costDrivers: { ... },
  aiNative: true,
  correctionFactor: 1.8
}
```

LLM-adapted cost drivers include reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight requirements.

**`sprint_forecast`** -- Sprint velocity forecasting from historical data

```
Input:  {
  backlog_points: 100,
  velocity_history: [20, 25, 22, 23],
  sprint_length_days: 14,
  ai_native: true
}
Output: {
  requiredSprints: 4,
  pessimisticSprints: 6,
  completionDays: 56,
  hoursPerPoint: 2.5,
  velocityTrend: "stable",
  aiNative: true
}
```

**`critical_path`** -- Critical Path Method with merge-bias adjustment for parallel tasks

```
Input:  {
  tasks: [
    { id: "A", duration: 5, dependencies: [] },
    { id: "B", duration: 3, dependencies: ["A"] },
    { id: "C", duration: 4, dependencies: ["A"] }
  ]
}
Output: {
  criticalPath: ["A", "C"],
  totalDuration: 9,
  slack: { B: 2, C: 0 },
  mergeBiasAdjustment: 0.85
}
```

**`monte_carlo_schedule`** -- Monte Carlo simulation with seeded PRNG for deterministic, reproducible results

```
Input:  {
  tasks: [
    { name: "A", optimistic: 2, most_likely: 4, pessimistic: 8 },
    { name: "B", optimistic: 1, most_likely: 3, pessimistic: 6 }
  ],
  iterations: 10000
}
Output: {
  p10: 3.2,
  p50: 6.1,
  p80: 8.4,
  p95: 11.2,
  riskEvents: 2,
  criticalPathProbability: { A: 0.72, B: 0.28 }
}
```

### Layer 4 -- Analytics

**`reference_class_estimate`** -- Reference class forecasting with planning fallacy correction

```
Input:  {
  project_type: "web_application",
  scope: "medium",
  ai_native: true
}
Output: {
  baseEstimate: 12,
  referenceClassAdjustment: 1.6,
  adjustedEstimate: 19.2,
  confidenceInterval: [14.4, 24],
  planningFallacyCorrected: true,
  aiNative: true
}
```

**`calibrate_estimates`** -- Team-specific accuracy calibration from historical estimated vs actual data

```
Input:  {
  estimates: [
    { estimated: 8, actual: 12, type: "feature" },
    { estimated: 4, actual: 5, type: "bugfix" }
  ]
}
Output: {
  correctionFactor: 1.38,
  mape: 33.3,
  calibration: "under-estimating",
  recommendation: "Apply 1.38x multiplier to future estimates"
}
```

**`token_time_bridge`** -- Map LLM token budgets to wall-clock time for 12 model families

```
Input:  {
  tokens: 50000,
  model: "claude-sonnet-4-20250514",
  tool_calls: 10,
  reasoning_depth: "deep"
}
Output: {
  estimatedSeconds: 142,
  estimatedMinutes: 2.37,
  confidence: 0.82,
  breakdown: {
    tokenGeneration: 95,
    toolCallOverhead: 35,
    reasoningOverhead: 12
  }
}
```

### Layer 5 -- Cost & Risk

**`token_cost_estimate`** -- Token cost estimation for LLM API calls

```
Input:  {
  input_tokens: 50000,
  output_tokens: 10000,
  model: "claude-sonnet-4-20250514"
}
Output: {
  inputCost: 0.15,
  outputCost: 0.30,
  totalCost: 0.45,
  model: "claude-sonnet-4-20250514"
}
```

**`compare_models`** -- Side-by-side cost and capability comparison across LLM models

```
Input:  {
  input_tokens: 50000,
  output_tokens: 10000,
  models: ["claude-sonnet-4-20250514", "gpt-4o", "gemini-2.5-pro"]
}
Output: {
  comparisons: [
    { model: "claude-sonnet-4-20250514", totalCost: 0.45, speed: "fast", quality: "high" },
    { model: "gpt-4o", totalCost: 0.55, speed: "fast", quality: "high" },
    { model: "gemini-2.5-pro", totalCost: 0.35, speed: "medium", quality: "high" }
  ],
  recommendation: "gemini-2.5-pro"
}
```

**`accuracy_trend`** -- Track estimation accuracy over time from historical data

```
Input:  {
  history: [
    { date: "2026-04-01", estimated: 8, actual: 10 },
    { date: "2026-04-15", estimated: 5, actual: 6 },
    { date: "2026-05-01", estimated: 12, actual: 13 }
  ]
}
Output: {
  trendDirection: "improving",
  averageError: 18.5,
  mape: 16.7,
  dataPoints: 3,
  recommendation: "Correction factor converging -- estimates improving"
}
```

**`schedule_risk`** -- Schedule risk scoring for project timelines

```
Input:  {
  tasks: [
    { name: "Auth module", duration: 5, risk_level: "high", dependencies: [] },
    { name: "UI components", duration: 3, risk_level: "low", dependencies: ["Auth module"] }
  ]
}
Output: {
  overallRisk: "medium",
  riskScore: 0.62,
  highRiskTasks: ["Auth module"],
  contingencyRecommended: 2.5,
  riskBreakdown: { scope: 0.4, dependency: 0.3, technical: 0.3 }
}
```

**`cocomo_validate`** -- Validate COCOMO II estimates against reference data

```
Input:  {
  kloc: 15,
  project_type: "organic",
  estimated_effort: 45
}
Output: {
  valid: true,
  expectedRange: [38, 55],
  deviation: 0.05,
  confidence: 0.88,
  warnings: []
}
```

## ai_native Mode

Epoch tools support dual estimation modes to account for the fundamentally different velocity of AI-assisted vs human-only development.

When `ai_native=true` (default), tools use Epoch's reference database with tool-aware correction factors. These baselines reflect AI agent workflows: faster iteration, higher output volume, and different error profiles.

When `ai_native=false`, tools apply human developer baselines:

| Parameter | Human Baseline | AI-Native Baseline |
|-----------|---------------|-------------------|
| Feature development | 14 calendar days | Epoch reference data |
| Bug fix turnaround | 72 hours | Epoch reference data |
| Sprint velocity | 35 story points | Epoch reference data |
| Estimation accuracy (MAPE) | 25% | Epoch reference data |
| Correction factor | 1.8x | Tool-aware dynamic factor |

Tools that support `ai_native`: `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `reference_class_estimate`.

## Self-Improvement Engine

Epoch gets better the more you use it. The self-improvement engine works through a feedback loop:

1. **Estimate** -- Generate an initial estimate with any estimation tool
2. **Record** -- Track the actual outcome (time, cost, effort)
3. **Calibrate** -- `calibrate_estimates` computes correction factors from your estimated vs actual data
4. **Improve** -- Future estimates automatically apply updated correction factors
5. **Trend** -- `accuracy_trend` tracks whether your estimation accuracy is improving over time

```
Estimated vs Actual -> Correction Factor -> Better Estimates -> Repeat
```

The engine detects systematic biases (chronic under-estimation, scope-creep patterns) and surfaces actionable recommendations.

## Community Data

Help improve Epoch by contributing anonymized estimation data. Community contributions expand the reference database, improve baseline accuracy for all users, and help calibrate AI-native vs human estimation modes.

See [CONTRIBUTING-data.md](./CONTRIBUTING-data.md) for guidelines on data format, privacy requirements, and submission process.

## Surfaces

Epoch exposes the same 21 tools through three interfaces:

| Surface | Transport | Use Case |
|---------|-----------|----------|
| **MCP Server** | stdio | Claude Code, Cursor, VS Code, Windsurf |
| **CLI** | Direct invocation | Scripts, CI/CD, quick lookups |
| **REST API** | HTTP (Hono) | Web apps, AI agents, integrations |

Default behavior: running `epoch` with no arguments starts the MCP stdio server.

### CLI

```bash
# PERT estimate
epoch pert-estimate --optimistic 2 --most-likely 4 --pessimistic 12 --unit hours

# Token-to-time bridge
epoch token-time-bridge --tokens 50000 --model claude-sonnet-4-20250514

# Monte Carlo simulation
epoch monte-carlo-schedule --tasks '[{"name":"A","optimistic":2,"most_likely":4,"pessimistic":8}]'

# COCOMO II estimate
epoch cocomo-estimate --kloc 15 --project-type organic

# Schedule risk score
epoch schedule-risk --tasks '[{"name":"A","duration":5,"risk_level":"high"},{"name":"B","duration":3,"risk_level":"low"}]'

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

## Installation

```bash
git clone https://github.com/KyaniteLabs/Epoch.git
cd Epoch
pnpm install
pnpm run build
```

## Development

```bash
pnpm test          # Run test suite (677 tests)
pnpm run build     # Build with tsup
pnpm run typecheck # TypeScript strict mode check
pnpm run dev       # Run development server
pnpm run inspector # Open MCP Inspector for interactive testing
```

## Tech Stack

- **Runtime**: Node.js 20+ (ESM)
- **Language**: TypeScript 5.8 (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- **Validation**: Zod 3.24 with `.describe()` on every field
- **MCP SDK**: `@modelcontextprotocol/sdk` 1.12+
- **HTTP**: Hono (lightweight, multi-runtime)
- **CLI**: Commander.js
- **Date Handling**: `date-fns` 4.x + `date-fns-tz` 3.x
- **Build**: `tsup` (ESM output)
- **Testing**: `vitest` 3.x with v8 coverage (87%+ coverage)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EPOCH_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `EPOCH_PORT` | `3000` | HTTP server port |
| `EPOCH_HOST` | `127.0.0.1` | HTTP server bind address |
| `EPOCH_DATA_DIR` | `~/.epoch/` | Data directory for feedback and self-improvement |
| `EPOCH_COMMUNITY_DIR` | `data/community/` | Community data directory |
| `EPOCH_RATE_LIMIT` | `100` | Max requests per minute per IP (HTTP only) |

## License

MIT License. See [LICENSE](./LICENSE) for full terms.
