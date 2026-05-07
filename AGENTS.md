# Epoch — Time Estimation MCP Server

## Identity
`@kyanitelabs/epoch` — Structured external time representations for LLMs. 19 tools across 5 layers (estimation, temporal, analytics, cost, risk).

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

<!-- EMPOWER_ORCHESTRATOR:START -->
## Empower the Orchestrator

This repository is governed by the Empower Orchestrator law. Every top-level/orchestrator agent session is an audition to improve the system, not only finish the current task.

When you notice a repeatable task done 3+ times or a recurring agent failure mode, consider shipping the smallest durable artifact that prevents the repetition: a tool, skill, slash command, hook, guardrail, memory entry, test, verifier, or doctrine doc.

This applies to top-level/orchestrator sessions. Background workers execute their assigned slice and do not independently widen scope.

Before dispatching automation or creating a durable system change, state the four-question blast-radius check in chat:

1. Scale: one file/workspace/all sessions?
2. Severity: minor friction/broken workflow/data loss or leaked content?
3. Reversibility: single revert/manual cleanup/surgery?
4. Predictability: bounded failure mode/guessing/unknown?

All green permits auto mode. Any yellow requires inline human approval. Any red means do not dispatch; do the work inline or escalate.

Worker discipline: isolated worktree/sandbox, one artifact equals one commit/change unit, verify before commit, register through the target tool's native discovery surface, and never write outside the assigned scope.

Success line: “I noticed X, found a better way. The system just got an upgrade.”

Full recipe: `docs/agent-law/empower-orchestrator.md`.
<!-- EMPOWER_ORCHESTRATOR:END -->
