<p align="center">
  <img src="assets/epoch-hero.webp" alt="Epoch — estimation MCP server for AI agents: PERT, COCOMO II, Monte Carlo, schedule-risk tools" width="100%">
</p>

# Epoch -- Time Estimation MCP Server

[![CI](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml/badge.svg)](https://github.com/KyaniteLabs/Epoch/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE) [![MCP](https://img.shields.io/badge/MCP-Server-green.svg)](https://modelcontextprotocol.io) [![npm version](https://img.shields.io/npm/v/@kyanitelabs/epoch.svg)](https://www.npmjs.com/package/@kyanitelabs/epoch) [![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue.svg)](https://registry.modelcontextprotocol.io/servers/io.github.KyaniteLabs/Epoch)

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
  claude-sonnet-5:    $0.57 -- standard, high quality
  Recommendation: gemini-2.0-flash for cost, claude-sonnet-5 for quality
```

## Why Epoch?

Every AI agent hallucinates timelines. "This should take about 2 hours" becomes 2 days. Epoch gives AI grounded, data-driven estimates instead of guesses. It packages established estimation methods (PERT, COCOMO II, Monte Carlo, reference class forecasting) into 25 tools any AI can call -- so your assistant stops guessing and starts calculating.

**Works out of the box.** Epoch ships with a bundled reference database built from 126,223 real data points across task types, complexity levels, and estimation tools. You get accurate estimates from day one — no data collection or account setup required. If you choose to record your actuals, Epoch's self-improvement engine learns your patterns and gets even more precise over time.

## What is MCP?

MCP (Model Context Protocol) is how AI assistants like Claude connect to external tools. Think of it like a plugin system -- you add Epoch with one command, and suddenly your AI assistant can estimate timelines, calculate business days, compare model costs, and predict whether your project will finish on time.

## Quick Start

**30-second setup -- works in Claude Code, Cursor, VS Code, and Windsurf:**

```bash
claude mcp add epoch -- npx @kyanitelabs/epoch
```

That's it. Your AI assistant now has 25 time estimation tools.

Or add it to your project's `.mcp.json`:

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

## Agent Skill

Epoch also ships a public agent skill at [`skills/epoch/SKILL.md`](skills/epoch/SKILL.md). Use `$epoch` in compatible agent hosts when you want the agent to choose the right Epoch MCP or CLI workflow for time estimates, business-day math, model-cost comparison, schedule risk, and estimate-vs-actual feedback.

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

Six-layer design with 25 tools for time estimation, scheduling, cost analysis, and feedback:

| Layer | Purpose | Tools |
|-------|---------|-------|
| **1. Core Temporal** | Time, timezones, duration, date math | `get_current_time`, `convert_timezone`, `parse_duration`, `time_math` |
| **2. Calendar Math** | Business days, holidays (US/UK/FR/DE/JP) | `add_business_days`, `count_business_days` |
| **3. Estimation** | PERT, COCOMO II, sprint, CPM, Monte Carlo | `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `critical_path`, `monte_carlo_schedule` |
| **4. Analytics** | Reference class, context classification, calibration, token-time bridge | `reference_class_estimate`, `estimate_from_context`, `calibrate_estimates`, `token_time_bridge` |
| **5. Cost & Risk** | Token cost, model comparison, accuracy trends, risk, COCOMO validation | `token_cost_estimate`, `compare_models`, `accuracy_trend`, `schedule_risk`, `cocomo_validate` |
| **6. Feedback** | Record actuals, track pending estimates, batch operations, health checks | `record_actual`, `get_pending_estimates`, `batch_record_actuals`, `feedback_health` |

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
  sampleSize: 126223,
  baselineSource: "self-improvement",
  confidence: "pessimistic",
  developerProfile: { mode: "ai_native", estimationMape: 15, underestimationBias: 0.2, correctionFactor: 1.45 },
  adjustedEstimate: 9.7,
  note: "Correction factors from bundled reference database (126,223 samples). Record actuals to personalize further."
}
```

Valid `task_type` values: `feature`, `bugfix`, `refactor`, `migration`, `infrastructure`, `documentation`, `testing`, `design`.

**`estimate_from_context`** -- Classify a free-text task description and delegate to reference class estimation

```
Input:  {
  context: "Add OAuth2 login support to the API, including refresh token rotation and a new /auth/callback endpoint"
}
Output: {
  tool: "estimate_from_context",
  rawEstimate: 2,
  correctedEstimate: 2,
  correctionFactor: 1,
  sampleSize: 0,
  baselineSource: "inferred_scope_medium_real_tasks",
  scopeUsed: "medium",
  scopeGuide: "For feature tasks: small=~2.3h, medium=~6h, large=~10.6h, xl=~17h",
  classification: {
    classified_task_type: "feature",
    classified_complexity: 3,
    confidence: "medium",
    signals: ["task_type_matched:feature"],
    task_type_from_hint: false,
    complexity_from_hint: false
  },
  note: "Using reference database correction factors. Submit actuals via record_actual to improve accuracy."
}
```

Classifies `task_type` and `complexity` from free text (an issue body, PR/diff description, or task summary) using a local, deterministic keyword/signal heuristic -- no LLM call is made. Caller-supplied `task_type`/`complexity` hints always override the classification. The resolved inputs are then delegated to the same reference-class-forecasting path used by `reference_class_estimate`, so the response carries the same estimate fields plus a `classification` provenance block explaining how the tool read the context. When classification confidence is low, an additional `lowConfidenceNote` field is returned rather than silently guessing.

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
    "Using reference database correction factor (1.45x) — personalized from 126,223 samples.",
    "Record actuals via POST /v1/feedback/record-actual to refine for your team's patterns."
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
  model: "claude-sonnet-5"
}
Output: {
  tokens: 50000,
  model: "claude-sonnet-5",
  estimatedSeconds: 695,
  estimatedMinutes: 11.6,
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
    { model: "deepseek-v3", estimatedCost: 0.0189, qualityTier: "standard", tokensPerSecond: 97 },
    { model: "gpt-4o-mini", estimatedCost: 0.0233, qualityTier: "fast", tokensPerSecond: 180 }
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
  historicalAccuracy: { mape: 15, sampleSize: 126223 },
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
| Feature development | 14 calendar days (industry data) | 5.7h median (126K+ real tasks) |
| Bug fix turnaround | 72 hours (industry data) | 6.2h median (1,498 matched pairs) |
| Sprint velocity | 35 story points (industry data) | 80 story points |
| Estimation accuracy (MAPE) | 25% (Jorgensen 2004) | 15% (from AI-native profiles) |
| Correction factor | 1.8x (industry standard) | 1.07-1.45x (from reference DB) |

Tools that support `ai_native`: `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `reference_class_estimate`, `schedule_risk`.

**Hybrid workflows:** `ai_native` accepts a float from 0.0 (fully human) to 1.0 (fully AI-native). Values like 0.5 produce interpolated profiles for mixed AI/human workflows. Boolean values (`true`/`false`) remain supported for backward compatibility.

## Self-Improvement Engine

Epoch learns your patterns the more you use it. The bundled reference database already contains 126,223 data points with correction factors tuned from real estimate-vs-actual pairs across 8 task types — **it works accurately on day one.**

If you record your actuals, Epoch personalizes further:

1. **Estimate** -- Generate an initial estimate with any estimation tool
2. **Record** -- Track the actual outcome (`record_actual`)
3. **Learn** -- Self-improvement computes personalized correction factors from your data
4. **Improve** -- Future estimates apply your team's actual patterns
5. **Trend** -- `accuracy_trend` tracks whether your accuracy is improving over time

```
Your estimates + your actuals -> Your correction factors -> Better estimates -> Repeat
```

**The loop can close itself.** Recording actuals is the step everyone forgets, so Epoch can do it for you: `epoch auto-actuals --session <id>` records wall-clock-derived actuals for a session's unfinished estimates (agent hosts can wire it into a session-end hook). Auto-recorded actuals are sanity-bounded (0.05–12h, <10x the estimate), provenance-labeled `auto_wallclock`, never overwrite a real actual, and `feedback_health` reports them separately (`byProvenance`) so automated data can't silently skew your calibration.

**Estimates lead with honest ranges.** When at least 5 matched pairs exist for a task type, `pert_estimate` and `reference_class_estimate` open with a calibrated 80% interval ("Expected 1.6–4.2 hours (80% confidence interval); point estimate 2.5 hours") derived from your own historical estimate-vs-actual ratios — and say plainly when there isn't enough data yet.

The engine detects systematic biases (chronic under-estimation, accuracy degradation) and surfaces actionable recommendations.

**You do not need to share data with anyone for this to work.** Self-improvement runs entirely locally using your own `~/.epoch/` data.

### The correction loop, measured

The self-improvement claim above isn't marketing copy -- it's backed by a runnable receipt. `scripts/backtest-pert-correction.mjs` makes a read-only temp copy of your `~/.epoch` ledger, chronologically splits matched `pert_estimate` (estimate, actual) pairs 80/20, trains the learned per-(tool, task_type) correction factor on the training split only, and reports MdAPE on the held-out test split it never trained on:

```bash
npx tsx scripts/backtest-pert-correction.mjs
```

Measured on the maintainers' production ledger (697 held-out matched pairs at time of writing): MdAPE improved from 105.2% (uncorrected) to 80.5% (learned correction) on data the correction factor never saw during training. This is the mechanism `EPOCH_PERT_LEARNED_CORRECTION` gates behind before it's recommended on by default -- the script also checks that the corrected median actual/predicted ratio lands in [0.7, 1.3], and reports `HOLD` (not recommended yet) when that second guard hasn't cleared, so the flag doesn't ship as "on" until both hold. Run the script against your own ledger for your own numbers; they move as more actuals get recorded, which is the point.

`reference_class_estimate`'s correction factors are the same learned mechanism applied to a different tool. Track its current calibration with `epoch data status` or `feedback_health` (per-tool MAPE/MdAPE, bias, and trend), or generate a full calibration decision-surface report with `node scripts/build-calibration-dashboard.mjs` -- also strictly read-only against your ledger.

## Data Pipeline

Epoch uses a three-layer data strategy so it's accurate from the start and gets better over time:

**1. Bundled reference database (works immediately, no setup):**
Epoch ships with a pre-built reference database containing 126,223 data points across 8 task types and 5 complexity levels. Correction factors are computed from real estimate-vs-actual pairs. You get accurate estimates the moment you install it.

**2. Local self-improvement (automatic, private):**
As you use Epoch and record actuals, the self-improvement engine recalibrates correction factors from *your* data. This runs entirely locally in `~/.epoch/` — nothing leaves your machine. The engine triggers automatically every 100 tool calls or 24 hours.

- **Auto-recording:** Use `scripts/auto-record-actual.mjs` to automatically record actual time against pending estimates.
- **Source tagging:** Set `EPOCH_SOURCE=<project-name>` to tag estimates by project.
- **Inspect your data:** `epoch data where` and `epoch data status` show what's stored locally.

**3. Community contributions (optional, opt-in):**
You can optionally share anonymized data to help improve baselines for all users. Community data is stripped of all identifying information — only task type, complexity, estimated hours, actual hours, and date remain. See [CONTRIBUTING-data.md](./CONTRIBUTING-data.md) for format and privacy requirements.

```bash
epoch share-data --validate --description "My anonymized estimation data"
```

This is completely optional. Epoch works great without it.

## Surfaces

Epoch exposes the same 25 tools through three interfaces:

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

## Agent-First

Epoch is built for agents as first-class callers, not humans typing in a terminal as an afterthought.

**Why agents need time-sense.** An LLM has no grounded sense of duration or cost -- it will say "quick fix" for a two-day migration and "big project" for a two-hour config change with equal confidence, because it has no feedback loop telling it otherwise. That's fine for a chat answer; it breaks down the moment an agent is planning multi-step work, sequencing a sprint, or deciding whether a deadline is realistic. Epoch gives the agent a calculator instead of a guess: PERT/COCOMO/Monte Carlo math, a reference-class baseline built from real task data, and a feedback loop that corrects itself as the agent (or its operator) records actuals.

**`EPOCH_TELEMETRY=1` for headless/agent operators.** Telemetry is off by default and requires informed consent. For a human at a terminal, that consent is `epoch telemetry enable`, which shows the data and asks for confirmation. An agent should never be the one clicking "yes" to that prompt on its own behalf -- there is deliberately no MCP tool that enables telemetry, so an agent cannot self-consent. For headless or agent-operated deployments, the operator opts in out-of-band by setting `EPOCH_TELEMETRY=1` in the server's environment (for example, the `env` block of the MCP server config) before the agent ever starts. Consent stays with the human who configures the deployment, not the agent that runs inside it.

**MCP client qualification.** Epoch's telemetry schema (v2) records `client_name`/`client_version` from the MCP `clientInfo` your host reports at connection time, plus `transport` (`stdio`/`http`). This is agent *qualification*, not agent *identification*: it lets aggregate accuracy stats count "5.7h median across N agent-driven feature estimates" as first-class agent data rather than lumping it in with anonymous CLI usage, without adding any new per-user identifying signal. MCP clients that report `clientInfo` (Claude Code, Cursor, and most current hosts do) get this for free; clients that don't are still fully functional, they just show up as `client_name: null`.

Epoch also provides built-in discoverability endpoints so agents can find and use the HTTP API without prior configuration:

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
pnpm test          # Run the Vitest suite
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
| `EPOCH_SOURCE` | _(none)_ | Project/source tag attached to estimate records |
| `EPOCH_TELEMETRY` | `0` | Set to `1` to enable anonymous telemetry. See [Telemetry & Privacy](#telemetry--privacy). |
| `EPOCH_TELEMETRY_ENDPOINT` | _(none)_ | Override the configured telemetry receiver endpoint for status/submission. |

## Telemetry & Privacy

Epoch can share **anonymized** estimate/actual pairs to improve accuracy for all users. This is **off by default** and requires explicit opt-in.

**Agent-operator consent model:** there is deliberately no MCP tool that enables telemetry -- an agent must not be able to self-consent on a human's behalf. Humans opt in interactively with `epoch telemetry enable`. Agent/headless operators opt in out-of-band by setting `EPOCH_TELEMETRY=1` in the server's environment before the agent starts (see [Agent-First](#agent-first)). Either way, consent belongs to the person who configures the deployment.

```bash
epoch telemetry enable     # Opt in (shows exactly what will be shared)
epoch telemetry preview    # Preview anonymized data before enabling
epoch telemetry status     # Show current settings
epoch telemetry set-endpoint --endpoint https://your-server.example.com/v1/telemetry
epoch telemetry submit     # Submit queued anonymized records to the configured endpoint
epoch telemetry disable    # Opt out
epoch telemetry export     # Export all local data as anonymized JSON
```

**What is shared:** task type, complexity, tool name, estimated hours, actual hours, ratio, date (YYYY-MM-DD only).

**What is NEVER shared:** project names, notes, team IDs, IP addresses, timestamps with time-of-day, source code, descriptions.

See [Privacy Policy](docs/PRIVACY.md) and [Telemetry Documentation](docs/TELEMETRY.md) for full details.

## Where Your Data Lives

By default, Epoch stores local data under `~/.epoch/` or `EPOCH_DATA_DIR`. Your local usage data is not automatically committed to GitHub and is not automatically submitted anywhere.

```bash
epoch data where     # Show local data file locations
epoch data status    # Show data file counts, feedback health, telemetry config
```

## Sharing Data

Use `epoch share-data --validate` to create a community-data JSON file suitable for `data/community/`. Review the file before opening a PR.

```bash
epoch share-data --description "Anonymized Epoch usage export" --validate
```

## Machine Labels

`windows-receiver` is a historical label. The current receiver host is `ubuntu-receiver` at `100.113.174.74`. See [docs/ops/machines.md](docs/ops/machines.md) for the full inventory.

## License

MIT License. See [LICENSE](./LICENSE) for full terms.

---

## Part of KyaniteLabs

More from [KyaniteLabs](https://kyanitelabs.tech). Related projects:

- **[mcp-video](https://github.com/KyaniteLabs/mcp-video)** — guardrailed video-editing MCP server for AI agents
- **[DialectOS](https://github.com/KyaniteLabs/DialectOS)** — Spanish dialect localization MCP server & CLI
- **[checkyourself](https://github.com/KyaniteLabs/checkyourself)** — local-first production-readiness checks for AI-built code

→ More at **[kyanitelabs.tech](https://kyanitelabs.tech)**
