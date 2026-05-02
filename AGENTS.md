# Epoch — Time Estimation MCP Server

## Identity
`@puenteworks/epoch` — Structured external time representations for LLMs. 19 tools across 5 layers (estimation, temporal, analytics, cost, risk).

## Stack
TypeScript | vitest | tsup | zod | MCP SDK

## Commands
- `pnpm run build` — tsup bundle
- `pnpm test` — vitest run
- `pnpm run typecheck` — tsc --noEmit
- `node canary-runner.mjs` — cross-model function-calling canary

## Architecture
```
src/index.ts          — MCP server entry (stdio transport)
src/dispatcher/       — Tool registry + routing
  tool-registry.ts    — 19 tool definitions, schema bindings
  formatters.ts       — Output formatting helpers
src/schemas/
  index.ts            — Zod schemas for all tools
src/lib/              — Core business logic (layer implementations)
  estimation.ts       — Layer 1: PERT, Delphi, COCOMO
  temporal.ts         — Layer 2: business hours, calendar math
  analytics.ts        — Layer 3: reference class, calibration, token-time bridge
  accuracy-trend.ts   — Accuracy tracking over time
  cost.ts             — Model cost estimation, comparisons
  risk.ts             — Schedule risk, Monte Carlo
  profiles.ts         — Team/profile management
  calendar.ts         — Holiday-aware calendar
  feedback.ts         — Estimate-vs-actual feedback loop
  self-improve.ts     — Self-tuning from calibration data
  supplementary-data.ts — Reference data enrichment
  telemetry.ts        — Usage telemetry
src/tools/            — MCP tool registration (wires lib → MCP schemas)
src/data/             — Reference databases (JSON)
src/entries/          — Entry point variants
src/types/            — Shared TypeScript types
```

## Hot Paths
- `src/schemas/index.ts` — All tool schemas, touched by every tool change
- `src/dispatcher/tool-registry.ts` — Tool routing, 19 tool registrations
- `canary-runner.mjs` — Function-calling canary for cross-model compatibility

## Patterns
- Tools: registered via `server.tool(name, description, zodSchema, handler)` in `src/tools/`
- Lib functions: pure logic in `src/lib/`, no MCP dependency
- Tests: co-located `*.test.ts` files, vitest
- Schemas: centralized in `src/schemas/index.ts`, imported by tool registrations

## Current State
Active development. Recent focus: LLM-friendly response enrichment, function-calling canary, stress testing.
