# Epoch -- Time Estimation MCP Server

[![CI](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml/badge.svg)](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE) [![MCP](https://img.shields.io/badge/MCP-Server-green.svg)](https://modelcontextprotocol.io) [![npm version](https://img.shields.io/npm/v/@puenteworks/epoch.svg)](https://www.npmjs.com/package/@puenteworks/epoch) [![Tests](https://img.shields.io/badge/tests-866-brightgreen.svg)]()

**Epoch helps AI agents understand time.**

AI can write code, analyze data, and build apps -- but it can't tell you how long something will take, what it'll cost, or whether a deadline is realistic. Epoch fixes that.

---

## Show Me

```
You: "How long will a 15,000 line project take with a small team?"

Claude (using Epoch):
  COCOMO II nominal: 100 person-months (traditional team)
  AI-adjusted: 9 person-months (LLM-assisted workflow)
  Schedule risk: medium (MAPE 15%, based on 28 historical features)
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
  gemini-2.0-flash:  $0.02 -- fast, budget-friendly
  gpt-4o-mini:       $0.02 -- fast, budget-friendly
  gemini-2.5-pro:    $0.37 -- standard, high quality
  claude-sonnet-4:    $0.57 -- standard, high quality
  Recommendation: gemini-2.0-flash for cost, claude-sonnet-4 for quality
```

## Why Epoch?

Every AI agent hallucinates timelines. "This should take about 2 hours" becomes 2 days. Epoch gives AI grounded, data-driven estimates instead of guesses. It packages established estimation methods (PERT, COCOMO II, Monte Carlo, reference class forecasting) into 24 tools any AI can call -- so your assistant stops guessing and starts calculating.

**Accuracy note:** Reference class baselines are built from 39 real AI-native tasks across 4 repositories. With correct complexity calibration, estimates fall within 25% of actuals ~67% of the time (vs ~25% for unaided human experts per Jorgensen 2004). Accuracy improves as teams submit estimated-vs-actual feedback through the self-improvement engine.

## What is MCP?

MCP (Model Context Protocol) is how AI assistants like Claude connect to external tools. Think of it like a plugin system -- you add Epoch with one command, and suddenly your AI assistant can estimate timelines, calculate business days, compare model costs, and predict whether your project will finish on time.

## Quick Start

**30-second setup -- works in Claude Code, Cursor, VS Code, and Windsurf:**

```bash
claude mcp add epoch -- npx @puenteworks/epoch
```

That's it. Your AI assistant now has 21 time estimation tools.

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

Five-layer design with 24 tools for time estimation, scheduling, and cost analysis:

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
  utcOffset: "-04:00"
}
```

**`convert_timezone`** -- Convert a timestamp between IANA timezones

```
Input:  { timestamp: "2026-05-01T12:00:00Z", target_tz: "Asia/Tokyo" }
Output: {
  iso: "2026-05-01T21:00:00.000+09:00",
  timezone: "Asia/Tokyo",
  utcOffset: "+09:00",
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
  countryCode: "US",
  humanReadable: "5 business days from 2026-05-01 to 2026-05-08 (US)."
}
```

**`count_business_days`** -- Count business days between two dates

```
Input:  { start_date: "2026-05-01", end_date: "2026-05-15", country: "US" }
Output: {
  startDate: "2026-05-01",
  endDate: "2026-05-15",
  businessDays: 10,
  countryCode: "US",
  humanReadable: "10 business days between 2026-05-01 and 2026-05-15 (US)."
}
```

### Layer 3 -- Estimation

**`pert_estimate`** -- PERT three-point estimation with confidence intervals and urgency scoring

```
Input:  {
  optimistic: 2,
  most_likely: 4,
  pessimistic: 12,
  unit: "hours"
}
Output: {
  expected: 5,
  variance: 2.78,
  stdDeviation: 1.67,
  confidence95: [1.67, 8.33],
  confidence99: [0, 10],
  unit: "hours",
  urgencyCategory: "medium",
  humanReadable: "Expected: 5 hours. 95% confidence: 1.67 to 8.33 hours. 99% confidence: 0 to 10 hours.",
  developerProfile: { mode: "ai_native", correctionFactor: 1.45 },
  adjustedEstimate: 7.25
}
```

**`cocomo_estimate`** -- COCOMO II software sizing with LLM-adapted cost drivers

```
Input:  {
  kloc: 15,
  reasoning_complexity: 1.2,
  context_completeness: 1.0,
  transformation_impact: 0.8,
  iterative_cycles: 1.5,
  human_oversight: 1.2
}
Output: {
  kloc: 15,
  personMonthsNominal: 99.9,
  personMonthsLlmAdjusted: 8.9,
  effortMultipliers: {
    reasoning_complexity: 1.2,
    context_completeness: 1.0,
    transformation_impact: 0.8,
    iterative_cycles: 1.5,
    human_oversight: 1.2,
    product: 1.728
  },
  developerProfile: { mode: "ai_native", correctionFactor: 1.45 }
}
```

LLM-adapted cost drivers include reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight requirements.

**`sprint_forecast`** -- Sprint velocity forecasting from historical data

```
Input:  {
  backlog_points: 100,
  velocity_history: [20, 25, 22, 23],
  sprint_length_days: 14,
  hours_per_sprint: 80
}
Output: {
  backlogPoints: 100,
  averageVelocity: 22.5,
  requiredSprints: 4.4,
  pessimisticSprints: 4.9,
  hoursPerPoint: 3.56,
  totalHours: 355.6,
  completionDays: 62,
  sprintLengthDays: 14,
  developerProfile: { mode: "ai_native", sprintVelocityPoints: 80, correctionFactor: 1.45 }
}
```

**`critical_path`** -- Critical Path Method with merge-bias adjustment for parallel tasks

```
Input:  {
  tasks: [
    { name: "A", duration: 5, predecessors: [] },
    { name: "B", duration: 3, predecessors: ["A"] },
    { name: "C", duration: 4, predecessors: ["A"] }
  ]
}
Output: {
  critical_path: ["A", "C"],
  total_duration: 9,
  slack_per_task: { A: 0, B: 1, C: 0 },
  merge_bias_adjustment: 0
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
  p10: "5.9",
  p50: "7.91",
  p80: "9.39",
  p95: "10.75",
  riskEvents: [{ description: "Task \"A\" exceeded 1.5x PERT expected in 5% of simulations", probability: 0.05, impactDays: 3 }],
  criticalPathProbability: 0.8
}
```

### Layer 4 -- Analytics

**`reference_class_estimate`** -- Reference class forecasting with planning fallacy correction

```
Input:  {
  task_type: "feature",
  complexity: 3
}
Output: {
  rawEstimate: 6.7,
  correctedEstimate: 11.1,
  correctionFactor: 1.67,
  sampleSize: 0,
  baselineSource: "real_tasks_28",
  confidence: "pessimistic",
  developerProfile: { mode: "ai_native", estimationMape: 15, underestimationBias: 0.2, correctionFactor: 1.45 },
  adjustedEstimate: 9.7,
  note: "Using reference database correction factors. Submit actuals via /v1/feedback/record-actual to improve accuracy."
}
```

Valid `task_type` values: `feature`, `bugfix`, `refactor`, `migration`, `infrastructure`, `documentation`, `testing`, `design`.

**`calibrate_estimates`** -- Team-specific accuracy calibration from historical estimated vs actual data

```
Input:  {
  task_type: "feature",
  team_id: "backend"
}
Output: {
  correctionFactor: 1.45,
  accuracyTrend: "stable",
  velocityTrend: "stable",
  recommendations: [
    "Using reference database correction factor (1.45x) — 3 samples, need 10.",
    "Submit actuals via POST /v1/feedback/record-actual to enable data-driven calibration."
  ]
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
  estimatedSeconds: 697,
  estimatedMinutes: 11.6,
  confidence: "likely",
  urgency: "short",
  breakdown: {
    promptTokens: 15000,
    completionTokens: 35000,
    toolOverheadSeconds: 2
  }
}
```

### Layer 5 -- Cost & Risk

**`token_cost_estimate`** -- Token cost estimation for LLM API calls

```
Input:  {
  tokens: 50000,
  model: "claude-sonnet-4-6"
}
Output: {
  tokens: 50000,
  model: "claude-sonnet-4-6",
  estimatedSeconds: 36,
  estimatedMinutes: 0.6,
  estimatedCost: 0.57,
  costBreakdown: { inputCost: 0.045, outputCost: 0.525, toolCallOverheadCost: 0 },
  confidence: "likely"
}
```

**`compare_models`** -- Side-by-side cost and capability comparison across LLM models

```
Input:  {
  tokens: 50000,
  sort_by: "cost"
}
Output: {
  tokens: 50000,
  models: [
    { model: "gemini-2.0-flash", estimatedCost: 0.0155, qualityTier: "fast", tokensPerSecond: 230 },
    { model: "deepseek-v3", estimatedCost: 0.0189, qualityTier: "fast", tokensPerSecond: 150 },
    { model: "claude-sonnet-4-6", estimatedCost: 0.57, qualityTier: "fast", tokensPerSecond: 140 }
  ],
  sortBy: "cost"
}
```

**`accuracy_trend`** -- Track estimation accuracy over time from recorded feedback data

```
Input:  { team_id: "backend", window_size: 50 }
Output: {
  overallTrend: "improving",
  currentMape: 26.5,
  industryBaselineMape: 25,
  totalEstimates: 1049,
  totalWithActuals: 1049,
  windows: [{ period: "Window 1 (estimates 1-50)", mape: 32, bias: 5.3, sampleSize: 50 }]
}
```

**`schedule_risk`** -- Schedule risk scoring for project timelines

```
Input:  {
  estimated_hours: 40,
  task_type: "feature"
}
Output: {
  estimatedHours: 40,
  riskLevel: "low",
  confidenceIntervals: { p50: 40, p80: 45.1, p95: 49.9 },
  historicalAccuracy: { mape: 15, sampleSize: 0 },
  recommendation: "Low risk. Estimate is within normal variance.",
  humanReadable: "Schedule risk: low. MAPE: 15% (based on 0 historical records). Confidence intervals: p50=40h, p80=45.1h, p95=49.9h."
}
```

**`cocomo_validate`** -- Validate COCOMO II estimates against reference data

```
Input:  {}
Output: {
  projectsEvaluated: 182,
  mape: 85.55,
  bias: 53.5,
  byProjectType: {
    organic: { mape: 86.57, count: 22 },
    semidetached: { mape: 84.75, count: 106 },
    embedded: { mape: 86.71, count: 54 }
  },
  recommendedAdjustments: []
}
```

## ai_native Mode

Epoch tools support dual estimation modes to account for the fundamentally different velocity of AI-assisted vs human-only development.

When `ai_native=true` (default), tools use Epoch's reference database with tool-aware correction factors. These baselines reflect AI agent workflows: faster iteration, higher output volume, and different error profiles.

When `ai_native=false`, tools apply human developer baselines:

| Parameter | Human Baseline | AI-Native Baseline |
|-----------|---------------|-------------------|
| Feature development | 14 calendar days (industry data) | 5.7h median (28 real tasks) |
| Bug fix turnaround | 72 hours (industry data) | 6.2h median (8 real tasks) |
| Sprint velocity | 35 story points (industry data) | 80 story points |
| Estimation accuracy (MAPE) | 25% (Jorgensen 2004) | 15% (from AI-native profiles) |
| Correction factor | 1.8x (industry standard) | 1.07-1.45x (from reference DB) |

Tools that support `ai_native`: `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `reference_class_estimate`, `schedule_risk`.

**Hybrid workflows:** `ai_native` accepts a float from 0.0 (fully human) to 1.0 (fully AI-native). Values like 0.5 produce interpolated profiles for mixed AI/human workflows. Boolean values (`true`/`false`) remain supported for backward compatibility.

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

The engine detects systematic biases (chronic under-estimation, accuracy degradation) and surfaces actionable recommendations.

## Community Data

Help improve Epoch by contributing anonymized estimation data. Community contributions expand the reference database, improve baseline accuracy for all users, and help calibrate AI-native vs human estimation modes.

See [CONTRIBUTING-data.md](./CONTRIBUTING-data.md) for guidelines on data format, privacy requirements, and submission process.

## Surfaces

Epoch exposes the same 24 tools through three interfaces:

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
epoch serve --port 3099
# or: EPOCH_TRANSPORT=http EPOCH_PORT=3099 epoch

# Call any tool
curl -X POST http://localhost:3099/v1/tools/pert_estimate \
  -H "Content-Type: application/json" \
  -d '{"optimistic": 2, "most_likely": 4, "pessimistic": 12, "unit": "hours"}'

# Health check
curl http://localhost:3099/health

# OpenAPI spec
curl http://localhost:3099/openapi.json
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
pnpm test          # Run test suite (866 tests)
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
- **Testing**: `vitest` 3.x with v8 coverage (97% statements, 88% branches)

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
