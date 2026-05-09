# Epoch Audit Remediation Report

Date: 2026-05-09  
Branch: `audit-remediation-2026-05-09`  
Worktree: `.worktrees/audit-remediation-2026-05-09`  
Base: `29fbadb` (`origin/docs/mcp-registry-links`)  
Original remediation report HEAD: `982f4f8`
Follow-up closure branch HEAD: updated by the residual-closure commits after `982f4f8`

## Outcome

The audit remediation is implemented as atomic Lore-protocol commits. The release path now fails closed, HTTP and package contracts are discoverable, telemetry ingestion/accounting is executable and isolated, reference database provenance is visible, silent failures are debug-visible, and the local canary verifies the current API shape instead of stale fields.

## Issue-to-remediation map

| Audit issue | Remediation commit | Main files | Verification evidence |
|---|---:|---|---|
| Remediation needed a durable plan before edits | `5d44587` | `docs/plans/2026-05-09-epoch-audit-remediation.md` | Plan committed before repair commits |
| HTTP telemetry tests leaked real `~/.epoch` state | `e1bc206` | `src/entries/http.test.ts` | `pnpm exec vitest run src/entries/http.test.ts --reporter=verbose` passed |
| CI/release gates failed open | `cf88db6` | `.github/workflows/ci.yml`, `.github/workflows/release.yml` | Workflow guard check; final test/lint/build matrix passes |
| OpenAPI omitted telemetry and feedback endpoints | `31e711b` | `src/entries/http.ts`, `src/entries/http.test.ts` | HTTP smoke checked `/v1/telemetry` and 4 feedback paths; 24 tool paths documented |
| Package entrypoint was not a side-effect-free public API | `f52336d` | `src/index.ts`, `src/index.test.ts` | Public import smoke checked 9 exports from `dist/index.js`; import test passed |
| Telemetry preview/status accounting conflicted | `b6fb423` | `src/entries/cli.ts`, `src/lib/config.ts`, `src/lib/telemetry-submit.ts` | CLI smoke: telemetry disabled, preview empty, counters available; targeted CLI/config tests passed |
| Telemetry receiver did not prove persisted, deduplicated ingestion | `6f1d027` | `src/lib/telemetry-receiver.ts`, `src/lib/telemetry-integration.test.ts` | `pnpm test` includes isolated e2e ingestion; final local canary passes API surface |
| Backfill/deploy telemetry scripts were untracked/unsafe to rely on | `27bf77d`, `d054f1d` | `scripts/backfill-telemetry.mjs`, `scripts/configure-mac-mini-telemetry.sh`, `scripts/install-telemetry-launchd.sh`, `docs/TELEMETRY.md` | Backfill dry-run smoke passed; shell scripts pass `bash -n`; ops scripts require `EPOCH_CONFIRM_OPS=1` |
| Reference database was stale/opaque | `fac4aae` | `src/lib/self-improve.ts`, `src/entries/cli.ts`, `scripts/verify-reference-db.mjs`, `src/data/reference-database.json`, docs | `node scripts/verify-reference-db.mjs` passed with sampleSize 5895/source self-improvement; CLI `reference-db-status` loaded bundled DB in isolated data |
| Calculation behavior lacked regression characterization | `654a4d5` | `src/lib/analytics.test.ts`, `src/lib/risk.test.ts`, `src/lib/telemetry-submit.test.ts` | Full `pnpm test` passed 956 tests; local canary surface 21/21 |
| Silent telemetry/self-improvement/feedback failures were hidden | `7fa5859` | `src/lib/internal/logging.ts`, `src/lib/telemetry.ts`, `src/lib/telemetry-submit.ts`, `src/lib/self-improve.ts`, `src/entries/http.ts` | Debug logging tests passed; HTTP feedback returns typed 400/409/500 reason paths |
| Lint baseline had actionable errors and noisy production non-null assertions | `4aa5415` | `eslint.config.js`, production lint targets, typed tests | Originally fixed to zero errors with accepted test warnings, then closed in follow-up: `pnpm run lint` now exits 0 with zero warnings |
| `.npmignore` contradicted packaged `data/` assets | `d054f1d` | `.npmignore` | `npm pack --dry-run --json` includes `dist/`, `data/`, `README.md`, `LICENSE`, `package.json`; excludes docs/scripts |
| Canary produced false failures/false-green exits against current local API | `73bb54d` | `canary-runner.mjs` | Local-only canary: surface 21/21, failure modes 11/11; local API failures now set non-zero exit code |

## Final verification from current HEAD

Executed after `73bb54d`:

| Gate | Result |
|---|---|
| `git status --short` | Clean before report creation |
| `pnpm run typecheck` | Pass |
| `pnpm run lint` | Pass: 0 errors, 0 warnings |
| `pnpm test` | Pass: 36 files, 956 tests |
| `pnpm run build` | Pass |
| `node scripts/validate-community-data.mjs` | Pass: 12 records valid |
| `node scripts/verify-reference-db.mjs` | Pass: sampleSize 5895, source `self-improvement`, globalCorrectionFactor 0.3 |
| `npm pack --dry-run --json` | Pass: includes `dist/index.js`, `dist/reference-database.json`, `data/cocomo-calibration-data.json`, telemetry/privacy docs, and supported backfill script |
| CLI isolated smoke | Pass: `telemetry status`, `telemetry preview`, and `reference-db-status` with temp `EPOCH_DATA_DIR` |
| Public import smoke | Pass: checked 9 stable exports from `dist/index.js` |
| Backfill dry-run smoke | Pass: dry-run made no network/config mutation, extracted/submitted 0 in temp data |
| HTTP smoke | Pass: `/health`, `/openapi.json`, 24 tool paths, telemetry path, and 4 feedback paths |
| Local canary | Pass: `pnpm run canary` uses `--local-only`; provider compatibility is explicit via `pnpm run canary:providers` |

## Operator-path coverage

- **CLI:** telemetry status/preview, reference database status, backfill dry-run.
- **HTTP:** health endpoint, OpenAPI discovery, telemetry receiver docs, feedback endpoint docs, 24 tool paths.
- **Library import:** side-effect-free `dist/index.js` import with estimation, analytics, telemetry, receiver, reference DB, and config exports.
- **Telemetry receiver:** unit and e2e ingestion/dedupe persistence tests with temp `EPOCH_DATA_DIR`.
- **Release package:** dry-run package contents validated against intended publish boundary, including package-shipped telemetry/privacy docs and the supported backfill script.
- **Canary:** local API and failure-mode checks are aligned with current response shapes and fail closed for local regressions; external provider compatibility has an explicit opt-in command.

## Residual closure follow-up

A second pass converted the earlier caveats into explicit contracts or removed them:

- Test non-null assertions were removed and `no-non-null-assertion` is enforced across all `src/**/*.ts`, including tests.
- The bundled reference database is now described as a verified package baseline, and empty bundled complexity factors carry a machine-readable `complexityCorrectionFactorStatus` explaining the approved-data threshold. No private user-local data was imported into the package baseline.
- `pnpm run canary` is local-only and fail-closed for the Epoch API surface; external provider compatibility moved to explicit `pnpm run canary:providers`.
- Telemetry ops scripts support `--dry-run`, require an explicit `EPOCH_TELEMETRY_ENDPOINT`, and no longer default to a private Tailscale receiver.
- The npm package includes the telemetry/privacy docs and supported `scripts/backfill-telemetry.mjs` path instead of leaving that operator flow repo-only.
- Historical `docs/superpowers` plans now carry archive banners so old tool counts and line references cannot be mistaken for current release truth.
- `docs/llms.txt` no longer embeds volatile test-suite counts; it points readers to `pnpm test` and `epoch reference-db-status` for current truth.
- The unused deprecated `getDeveloperProfile` wrapper was removed; `getDeveloperProfileGradient` is the sole profile API in `src/lib/profiles.ts`.
- `scripts/verify-remediation-closure.mjs` and `pnpm run verify:remediation` enforce these closure checks.

## Isolation statement

Final CLI, telemetry, HTTP, reference DB, and canary smokes used temporary `EPOCH_DATA_DIR` directories. No final verification path intentionally wrote to the real `~/.epoch` data directory.
