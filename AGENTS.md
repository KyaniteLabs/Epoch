# Epoch agent contract

Epoch is a TypeScript MCP server for structured time estimation, temporal
math, analytics, cost, risk, and estimate-vs-actual feedback.

## Commands and public skill

- `pnpm run build` — tsup bundle
- `pnpm test` — Vitest
- `pnpm run typecheck` — TypeScript check
- `node canary-runner.mjs` — function-calling canary
- `skills/epoch/SKILL.md` is the public agent skill; keep it aligned with the
  MCP tool list, CLI commands, and feedback-token workflow.

## Architecture

- `src/index.ts` — stdio MCP entry point
- `src/dispatcher/` — tool registry and routing
- `src/schemas/` — centralized Zod schemas
- `src/lib/` — pure business logic for estimation, temporal, analytics, cost,
  risk, profiles, calendar, feedback, self-improvement, and telemetry
- `src/tools/` — MCP registration
- `src/data/` — reference databases

Schemas and tool registrations are shared hot paths. Register tools through the
existing server pattern; keep library code independent of MCP concerns. Use
co-located Vitest tests and preserve the estimate-vs-actual feedback contract.

Do not put current tool counts, provider endpoints, quotas, release state, or
task status in this file. Preserve dirty work, verify current branch/remote/CI
and runtime state, and run focused checks before claims. Stop before external,
credentialed, public, financial, or destructive actions without approval.

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
