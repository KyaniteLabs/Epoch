# Epoch architecture

Epoch is a Node >=22 TypeScript estimation service distributed as an npm CLI with MCP stdio and optional HTTP interfaces (`package.json`, `src/index.ts`). Engineering owns implementation; Product owns user-facing descriptions. This map describes current source, not deployment acceptance.

## Components and flow

- `src/entries/{cli,mcp,http}.ts` adapt commands, MCP calls and Hono routes. `src/dispatcher/tool-registry.ts` registers tools; `src/schemas/index.ts` supplies input contracts.
- `src/dispatcher/index.ts` dispatches registered handlers, records telemetry and successful estimates, and triggers improvement notifications. Numerical, calendar, risk and calibration logic lives in `src/lib/`; `src/types/` holds shared types. `src/contract/` exports the public surface.
- `src/data/reference-database.json` and `data/` supply bundled calibration, community and benchmark inputs. Research under `Research/` is supporting material, not automatically validated production truth.
- `src/lib/ledger.ts`, `feedback-ledger.ts`, `feedback.ts`, `config.ts` and `self-improve.ts` implement local history/configuration and learning. `scripts/` contains dataset, migration, release and fleet operator tools.
- `workers/telemetry-receiver/` is a separately deployed Cloudflare Worker with SQL persistence; `plugins/` and `skills/` integrate agent hosts. `site/` is a static product/discovery surface.

Example: an MCP `pert_estimate` request reaches the adapter and registry, passes schema validation, computes through estimation logic, then dispatch records its estimate in local feedback storage. A successful persisted hour estimate receives a `feedbackRef`. `record_actual` pairs subsequent actuals for analytics/calibration. Storage failure returns a storage error instead of a phantom reference (`src/dispatcher/index.ts`, `src/lib/feedback.ts`). CLI/HTTP share the dispatcher, with transport-specific formatting and errors.

## Boundaries and risky changes

Local state defaults to `~/.epoch`, overridable with `EPOCH_DATA_DIR` (`src/lib/config.ts`, `ledger.ts`). Treat recorded inputs/history as private operational data. Tests must use isolated writable directories. Telemetry submission is opt-in, default disabled; configuration and payload filtering are separate from authentication (`docs/PRIVACY.md`, `docs/TELEMETRY.md`, `src/lib/telemetry-submit.ts`). The Worker validates payloads/signatures and applies quota/deduplication; installation-id-based HMAC is not independent identity attestation (`workers/telemetry-receiver/src/index.ts`).

HTTP exposure, authentication/proxy settings, body/rate limits and feedback routes require security review (`src/entries/http.ts`). Ledger locking/appends/migrations, feedback units/provenance, exclusions and learned correction factors can corrupt measurement even when responses look plausible. Changes to registry/schemas must preserve all transport contracts; publishing workflows and operator scripts cross deployment boundaries. Do not infer calibration accuracy from sample count or schema validity.

## Failure and verification

Observable failures include validation/unknown-tool envelopes, storage errors without feedback references, HTTP size/rate/auth rejections, malformed/quarantined history, and contract/data-check failures. Tests colocated in `src/**/*.test.ts` cover numerical, persistence, transport and process seams; `vitest.config.ts` sets differentiated coverage thresholds. GitHub and Forgejo CI live in `.github/workflows/` and `.forgejo/workflows/`; plugin/Worker tests have separate prerequisites. Run `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, and data/contract scripts from `package.json`. Ownership inventory: `qa/architecture-paths.json`; current evidence, untested boundaries and mirror reconciliation: `qa/FOUNDATION-GAPS.md`.
