# CheckYourself Project Context

Generated locally by the CheckYourself scan & scaffold CLI (`tools/checkyourself.py`).
No secret values are included. Review before sharing with an AI assistant.

- Generated at: 2026-05-29T15:43:19+00:00
- Project root: `/tmp/epoch-check`
- Files scanned: 290

## Deterministic findings (local scan only)

> These are cheap, high-confidence checks. The full CheckYourself diagnostic, run by your
> AI assistant, sweeps the entire production surface and explains, ranks, and fixes findings.

Counts — P0: 1, P1: 0, P2: 0, P3: 0

### [P0] CY-001 — Possible hardcoded secrets in source

One or more files contain patterns that look like live credentials. Rotate anything real, move it to environment variables, and confirm it is gitignored.

Recommended first move: Rotate anything real, remove it from source, load it from environment variables, and confirm history exposure.

- src/dispatcher/tool-registry.ts (possible hardcoded secret; value omitted)

## Detected stack signals

- GitHub Actions: `.github/workflows`
- JavaScript/TypeScript project: `package.json`
- pnpm: `pnpm-lock.yaml`

## Dependency hints

- Hono: hono
- Vitest: vitest

## Package scripts

- `build`: `tsup`
- `canary`: `node canary-runner.mjs`
- `dataset:build`: `node scripts/export-public-benchmark.mjs`
- `dataset:verify`: `node scripts/validate-public-benchmark.mjs`
- `dev`: `tsx src/index.ts`
- `inspector`: `npx @modelcontextprotocol/inspector node dist/index.js`
- `lint`: `eslint src/`
- `test`: `vitest run`
- `test:watch`: `vitest`
- `typecheck`: `tsc --noEmit`

## Environment files

- No .env-style files detected.

## Test files/configs

- `src/dispatcher/dispatcher.test.ts`
- `src/dispatcher/formatters.test.ts`
- `src/dispatcher/index.test.ts`
- `src/dispatcher/mcp-adapter.test.ts`
- `src/entries/cli.test.ts`
- `src/entries/http.test.ts`
- `src/index.test.ts`
- `src/lib/accuracy-trend.test.ts`
- `src/lib/analytics.test.ts`
- `src/lib/calendar.test.ts`
- `src/lib/calibration-factors.test.ts`
- `src/lib/cocomo-ground-truth.test.ts`
- `src/lib/cocomo-validate.test.ts`
- `src/lib/community-export.test.ts`
- `src/lib/config.test.ts`
- `src/lib/cost.test.ts`
- `src/lib/data-status.test.ts`
- `src/lib/estimation.test.ts`
- `src/lib/feedback-batch.test.ts`
- `src/lib/feedback.test.ts`
- `src/lib/internal/error-helpers.test.ts`
- `src/lib/internal/logging.test.ts`
- `src/lib/internal/time-math-dispatch.test.ts`
- `src/lib/internal/urgency.test.ts`
- `src/lib/profiles.test.ts`
- `src/lib/reference-db-recalculation.test.ts`
- `src/lib/risk.test.ts`
- `src/lib/self-improve.test.ts`
- `src/lib/stress.test.ts`
- `src/lib/supplementary-data.test.ts`
- `src/lib/telemetry-integration.test.ts`
- `src/lib/telemetry-receiver.test.ts`
- `src/lib/telemetry-submit.test.ts`
- `src/lib/telemetry.test.ts`
- `src/lib/temporal.test.ts`
- `src/lib/token-time.test.ts`
- `src/schemas/index.test.ts`
- `src/test-support.ts`
- `src/tools/analytics.test.ts`
- `src/tools/estimation.test.ts`
- `src/tools/feedback.test.ts`
- `src/tools/temporal.test.ts`
- `vitest.config.ts`

## CI workflows

- `.github/workflows/agent-law.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/validate-community-data.yml`

## Risk-surface path hints

### AI agents
- `.github/workflows/agent-law.yml`
- `AGENTS.md`
- `Research/llm_time.agent.final.base.docx`
- `Research/llm_time.agent.final.converted.md`
- `Research/llm_time.agent.final.footnote.docx`
- `Research/llm_time.agent.final.md`
- `Research/llm_time.agent.outline.md`
- `Research/review_llm_time_agent_final.md`
- `docs/agent-law/empower-orchestrator.md`

## Directory sample

```text
.
  .coderabbit.yaml
  .cursorrules
  .editorconfig
  .gitignore
  .npmignore
  .npmrc
  .windsurfrules
  AGENTS.md
  CHANGELOG.md
  CLAUDE.md
  CONTRIBUTING-data.md
  CONTRIBUTING.md
  LICENSE
  README.md
  canary-runner.mjs
  eslint.config.js
  llms.txt
  package.json
  pnpm-lock.yaml
  server.json
  docs/
    PRIVACY.md
    TELEMETRY.md
    compatibility-matrix.md
    llms.txt
    superpowers/
      plans/
        2026-05-01-ship-ready-polish.md
      specs/
        2026-05-01-ship-ready-polish.md
    agent-law/
      empower-orchestrator.md
    ops/
      epoch-fleet-audit.md
      machines.md
      audits/
        .gitkeep
        epoch-fleet-audit-2026-05-24.md
    plans/
      2026-05-09-epoch-audit-remediation-baseline.md
      2026-05-09-epoch-audit-remediation-report.md
      2026-05-09-epoch-audit-remediation.md
  data/
    cocomo-calibration-data.json
    public-benchmark.json
    supplementary-database.json
    schemas/
      cocomo-project.schema.json
      estimation-record.schema.json
      model-calibration.schema.json
      public-benchmark.schema.json
      sprint-velocity.schema.json
    community/
      .gitkeep
      README.md
      example-estimation.json
  src/
    index.test.ts
    index.ts
    test-support.ts
    version.ts
    entries/
      cli.test.ts
      cli.ts
      http.test.ts
      http.ts
      mcp.ts
    schemas/
      index.test.ts
      index.ts
    data/
      reference-database.json
    types/
      index.ts
    lib/
      accuracy-trend.test.ts
      accuracy-trend.ts
      analytics.test.ts
      analytics.ts
      calendar.test.ts
      calendar.ts
      calibration-factors.test.ts
      calibration-factors.ts
      cocomo-ground-truth.test.ts
      cocomo-ground-truth.ts
      cocomo-validate.test.ts
      cocomo-validate.ts
      community-export.test.ts
      community-export.ts
      config.test.ts
      config.ts
      cost.test.ts
      cost.ts
      data-status.test.ts
      data-status.ts
      internal/
        error-helpers.test.ts
        error-helpers.ts
        logging.test.ts
        logging.ts
        time-math-dispatch.test.ts
        time-math-dispatch.ts
        urgency.test.ts
        urgency.ts
    dispatcher/
      dispatcher.test.ts
      formatters.test.ts
      formatters.ts
      index.test.ts
      index.ts
      mcp-adapter.test.ts
      mcp-adapter.ts
      tool-registry.ts
    tools/
      analytics.test.ts
      estimation.test.ts
      feedback.test.ts
      temporal.test.ts
  scripts/
    analyze-filtered.ts
    analyze-outliers.ts
    analyze-seed.ts
    audit-epoch-fleet.sh
    auto-record-actual.mjs
    backfill-telemetry.mjs
    batch-estimate.ts
    check-cf.ts
    check-complexity-cf.ts
    check-convergence.ts
    check-rce.ts
    check-sprint.ts
    check-ttb.ts
    check-unmatched.ts
    configure-mac-mini-telemetry.sh
    consolidate-and-improve.sh
    data-gather.mjs
    debug-sf.ts
    debug-unmatched.ts
    dogfood-seed-2.sh
...truncated...
```

## Hand this to CheckYourself

```text
Use this generated context with the CheckYourself diagnostic. Treat the deterministic
findings above as confirmed evidence, then sweep the whole production surface: infer the
stack, list unknowns, score production readiness 0-100 with caps, rank P0/P1/P2/P3 risks,
produce the complete remediation backlog and the safest first approval batch, and generate
a bespoke learning plan from the gaps.
```
