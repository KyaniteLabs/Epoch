# Epoch

A Time Estimation MCP Server — giving LLMs accurate temporal reasoning through external tools.

## Why This Exists

LLMs cannot track continuous wall-clock time. They have no persistent hidden state, positional encodings represent token sequence position (not real-world time), and self-attention provably cannot model counting behaviors. This leads to systematic failures in duration prediction, temporal ordering, and time estimation — especially in software engineering contexts where agents estimate in token budgets rather than minutes.

Epoch solves this by providing structured external representations that LLMs can request rather than calculate.

## Architecture

Five-layer design:

| Layer | Purpose | Tools |
|-------|---------|-------|
| **Core Temporal** | Time retrieval, timezone conversion, duration parsing, date math | `get_current_time`, `convert_timezone`, `parse_duration`, `time_math` |
| **Calendar Math** | Business days, holiday awareness, working hours, urgency classification | `add_business_days`, `count_business_days` |
| **Software Estimation** | PERT, COCOMO II (LLM-adapted), sprint velocity, critical path, Monte Carlo | `pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `critical_path`, `monte_carlo_schedule` |
| **Data Integration** | Reference class forecasting, accuracy calibration | `reference_class_estimate`, `calibrate_estimates` |
| **Advanced Analytics** | Token-to-wall-clock time mapping, planning fallacy correction | `token_time_bridge` |

## Installation

```bash
# Clone
git clone https://github.com/KyaniteLabs/Epoch.git
cd Epoch

# Install dependencies
npm install

# Build
npm run build
```

## Usage with Claude Code

```bash
claude mcp add epoch -- npx @kyanitelabs/epoch
```

Or add to your `.mcp.json`:

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

## Tool Reference

### Core Temporal

**`get_current_time`** — Current time in any timezone
```
Input:  { timezone: "America/New_York" }
Output: { iso, unix, timezone, offset, formatted }
```

**`convert_timezone`** — Convert a timestamp between timezones
```
Input:  { timestamp: "2026-05-01T12:00:00Z", target_tz: "Asia/Tokyo" }
Output: { iso, timezone, offset, formatted }
```

**`parse_duration`** — Parse human-readable duration strings
```
Input:  { duration_string: "2h30m" }
Output: { totalSeconds, breakdown: { hours, minutes, seconds }, original }
```

**`time_math`** — Date arithmetic (add_days, diff, add_hours, add_minutes, format_duration, add_weeks)

### Calendar Math

**`add_business_days`** — Add N business days with holiday awareness (US, UK, FR, DE, JP)
```
Input:  { start_date: "2026-05-01", days: 5, country: "US" }
Output: { endDate, skippedHolidays, skippedWeekends }
```

**`count_business_days`** — Count business days between two dates

### Software Estimation

**`pert_estimate`** — Three-point PERT estimation
```
Input:  { optimistic: 2, most_likely: 4, pessimistic: 12, unit: "hours" }
Output: { expected: 5, standardDeviation: 1.67, unit: "hours" }
```

**`cocomo_estimate`** — COCOMO II with LLM-adapted cost drivers
```
Input:  { kloc: 10, reasoning_complexity: 1.2, context_completeness: 0.8, ... }
Output: { personMonthsNominal, personMonthsLlmAdjusted, effortMultipliers }
```

**`sprint_forecast`** — Sprint velocity forecasting
**`critical_path`** — Critical Path Method with forward/backward pass
**`monte_carlo_schedule`** — Monte Carlo schedule simulation with seeded PRNG

### Analytics

**`token_time_bridge`** — Map LLM token budgets to wall-clock time
```
Input:  { tokens: 50000, model: "claude-sonnet-4-20250514", tool_calls: 10, reasoning_depth: "deep" }
Output: { estimatedSeconds, estimatedMinutes, confidence, model }
```

**`reference_class_estimate`** — Reference class forecasting with planning fallacy correction

## Development

```bash
npm test          # Run test suite (129 tests)
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
- **Date Handling**: `date-fns` 4.x + `date-fns-tz` 3.x
- **Build**: `tsup` (ESM output)
- **Testing**: `vitest` 3.x with v8 coverage (87%+ coverage)

## License

Business Source License 1.1 (BSL-1.1). Non-production use is permitted freely. See [LICENSE](./LICENSE) for full terms. Converts to MIT on 2029-01-01.
