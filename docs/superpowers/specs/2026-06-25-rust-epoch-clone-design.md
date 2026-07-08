# Rust Epoch Clone - Full Design Spec

**Date:** 2026-06-25
**Status:** Approved design direction; implementation not started
**Decision:** Build a wire-compatible Rust successor in this repo during migration
**Scope:** Full Rust clone of the current Epoch public contract, with stricter verification and better operational properties

---

## Executive Summary

Epoch should be rebuilt as a Rust-native successor that preserves the current public v1 contract while replacing the implementation behind it.

"Clone" means public-boundary compatibility:

- The same 24 MCP tool names.
- The same broad request and response JSON contract.
- The same CLI command intent.
- The same HTTP route surface.
- Compatible local state and feedback-token workflows.
- The same privacy stance: local-first, telemetry off by default, explicit opt-in only.

"Superior" means measurable improvement after parity:

- A standalone Rust binary for MCP, CLI, and HTTP use.
- Typed contract boundaries with generated schemas.
- Atomic local-state writes and migration-aware data handling.
- CI drift checks across tools, schemas, docs, skill, CLI, and HTTP.
- Local canaries that identify the failing surface instead of hiding regressions in one large smoke test.

This spec intentionally does not authorize Rust implementation yet. It records the approved design direction and the execution plan boundary.

---

## Current Contract Evidence

The current TypeScript implementation is the migration oracle until the Rust implementation passes parity gates.

Validated current-state facts:

- Package identity: `@kyanitelabs/epoch`.
- Runtime surfaces: MCP server, CLI, HTTP server, OpenAPI, `llms.txt`, AI plugin manifest.
- Current MCP tool count: 24.
- Current HTTP route count: 11.
- Local state root: `~/.epoch` or `EPOCH_DATA_DIR`.
- Telemetry: opt-in, no built-in default receiver URL, signed submissions, receiver dedupe.
- Public skill: `skills/epoch/SKILL.md`.
- Historical specs may contain stale counts; use current code and docs as source of truth.

Current MCP tool names:

```text
get_current_time
convert_timezone
parse_duration
time_math
add_business_days
count_business_days
pert_estimate
cocomo_estimate
sprint_forecast
critical_path
monte_carlo_schedule
reference_class_estimate
calibrate_estimates
token_time_bridge
token_cost_estimate
compare_models
accuracy_trend
schedule_risk
cocomo_validate
cocomo_ground_truth
record_actual
get_pending_estimates
batch_record_actuals
feedback_health
```

Write tools must remain visibly distinct from read tools:

```text
record_actual
batch_record_actuals
```

Current HTTP routes to preserve:

```text
/health
/v1/tools
/v1/tools/:toolName
/v1/telemetry
/.well-known/ai-plugin.json
/llms.txt
/openapi.json
/v1/feedback/record-actual
/v1/feedback/pending
/v1/feedback/batch-record-actuals
/v1/feedback/health
```

---

## Design Decision

Choose **Option A: Wire-Compatible Rust Successor**.

This is the strongest fit for the user request because it treats Rust as the chance to improve the implementation without sacrificing existing users, agent integrations, docs, feedback data, or calibration trust.

Rejected alternatives:

- **Behavior-frozen port first:** safest parity story, but delays the improvements that make the Rust version worth doing.
- **Breaking Rust v2 rewrite:** cleanest code freedom, but too expensive for trust, existing data, docs, npm users, and agent compatibility.

The Rust successor may improve internals, schemas, binary distribution, state handling, and tests. It may not break public behavior unless a compatibility exception is recorded and explicitly approved.

---

## RALPLAN-DR Record

### Principles

1. Public contract first.
2. Rust-native internals, compatibility at the boundary.
3. One source of truth for tool, schema, CLI, HTTP, docs, and skill surfaces.
4. Local-first privacy and state safety are product requirements.
5. Superiority must be proven by tests, canaries, and reduced drift.

### Decision Drivers

1. Compatibility risk across npm, MCP, CLI, HTTP, docs, and existing local data.
2. Calibration trust across estimates, actuals, telemetry, and reference-class data.
3. Operational simplicity through a standalone Rust binary and cleaner release gates.

### Review Outcome

Planner, Architect, and Critic reached consensus on Option A after one Architect revision.

Architect-required fixes were applied before approval:

- Initial in-repo `rust/` topology.
- Compatibility exception policy.
- Output-schema exposure policy.
- Measurable superiority gate.

Critic approval carried non-blocking execution recommendations:

- Decide npm wrapper strategy before packaging or release work.
- Add the compatibility-exception record template before first parity fixtures land.
- Decide JSONL write-versioning after read compatibility is proven.
- Treat Option A as the decision now that user approval has been granted.

---

## Target Architecture

Start the Rust implementation inside this repository under `rust/` during migration.

```text
rust/
  Cargo.toml
  crates/
    epoch-contract/
    epoch-core/
    epoch-data/
    epoch-mcp/
    epoch-cli/
    epoch-http/
    epoch-canary/
    xtask/
```

### Crate Responsibilities

`epoch-contract`

- Public request and response structs.
- Tool manifest.
- Tool annotations.
- Error envelopes.
- Generated JSON schemas.
- Versioned local-data schemas.
- Compatibility exception records.

`epoch-core`

- Pure estimation logic.
- Temporal and business-day math.
- Calendar rules.
- Analytics, calibration, reference-class logic.
- Cost and schedule-risk logic.
- No MCP, HTTP, CLI, telemetry receiver, or direct filesystem writes.

`epoch-data`

- Local config.
- JSONL estimate and feedback state.
- Reference database loading.
- Telemetry payload extraction.
- Receiver records, receipts, dedupe keys.
- Atomic writes.
- Read-compatible migrations.

`epoch-mcp`

- Official Rust MCP SDK integration.
- Stdio transport.
- Tool list and tool call handlers.
- Read/write annotations.
- MCP-compatible errors and result content.

`epoch-cli`

- `epoch` command adapter.
- Existing command-family intent.
- Human/table output and JSON output modes.
- Exit-code semantics.

`epoch-http`

- Current HTTP routes.
- OpenAPI.
- `llms.txt`.
- AI plugin manifest.
- Feedback endpoints.
- Telemetry receiver endpoint.

`epoch-canary`

- Cross-implementation fixtures.
- Local-only parity runner.
- Provider-canary bridge after local parity passes.

`xtask`

- Drift checks.
- Schema generation.
- Fixture regeneration.
- Contract inventory.
- Release verification orchestration.

---

## Runtime Flow

### Tool Call Flow

1. MCP, CLI, or HTTP receives a request.
2. Adapter parses the request into `epoch-contract` types.
3. Shared dispatcher resolves the tool from the manifest.
4. `epoch-core` or `epoch-data` executes the operation.
5. Adapter renders a v1-compatible result envelope.
6. Estimate-bearing outputs emit or preserve a Feedback Token when applicable.
7. Local telemetry/self-improvement hooks are notified without leaking sensitive details.

### Feedback Flow

1. An estimate returns a Feedback Token.
2. A later actual is recorded through MCP, CLI, or HTTP.
3. The actual is matched to the estimate locally.
4. Calibration reads matched pairs and produces local correction data.
5. No network submission occurs unless telemetry is explicitly enabled.

### Telemetry Flow

1. User opts into telemetry and configures a receiver.
2. Rust extracts anonymized matched estimate/actual records.
3. Submission is signed with HMAC-SHA256.
4. Receiver deduplicates records and writes aggregate receipts.
5. Receiver never requires raw notes, full local paths, credentials, project names, or unrelated environment data.

---

## Contract Preservation

The Rust clone must preserve these public surfaces before it can replace the TypeScript implementation:

- 24 MCP tool names.
- MCP input-schema compatibility.
- MCP read/write annotations.
- MCP call result compatibility.
- CLI command-family intent and key flags.
- CLI JSON output shape for agent workflows.
- HTTP route list.
- HTTP status-code intent and error envelopes.
- OpenAPI, `llms.txt`, and AI plugin manifest surfaces.
- Local feedback-token workflow.
- Existing local data read compatibility.
- Telemetry opt-in, no-default-receiver, signing, and dedupe semantics.
- Public docs and public skill alignment.

Human-facing text may improve as long as machine-readable fields stay compatible.

---

## Compatibility Exception Policy

Default rule: preserve public behavior at the boundary.

Every TypeScript-to-Rust divergence must be classified as one of:

- **Contract preserve:** match current behavior because docs, tests, clients, local data, or telemetry semantics depend on it.
- **Bug fix with compatibility shim:** correct behavior in Rust while preserving old inputs, aliases, or response fields long enough for migration.
- **Internal cleanup:** change freely because behavior is not public and does not affect persisted data, telemetry, docs, or clients.
- **Breaking deferred:** worthwhile but postponed to a future v2 because it would violate the v1 clone contract.

Each exception record must include:

```text
id:
surface:
classification:
current_typescript_behavior:
proposed_rust_behavior:
affected_clients:
parity_test_treatment:
migration_note:
approval:
```

Public behavior includes tool names, JSON fields, CLI flags, exit-code intent, HTTP route semantics, telemetry fields, feedback-token semantics, and persisted-data meaning.

---

## Output Schema Policy

Rust should generate output schemas from typed contract models from day one.

Use generated output schemas for:

- OpenAPI.
- Local validation.
- Golden fixtures.
- Drift checks.
- Documentation sanity checks.

Do not expose MCP `outputSchema` until host compatibility is validated. The current public contract relies on input schemas plus result content, and some hosts may be stricter than the TypeScript-era surface expects.

---

## Local Data Policy

Rust must read TypeScript-created local state before it writes new shapes.

Rules:

- Tests use isolated `EPOCH_DATA_DIR` values.
- Migration tests run on temp copies, not user data.
- Writes are atomic.
- New fields must be additive unless explicitly excepted.
- JSONL write-versioning is deferred until read compatibility is proven.
- Failed migrations must leave original files intact.
- Diagnostics must not print full local paths by default.

Primary state categories:

- Config.
- Estimates.
- Feedback actuals.
- Telemetry records.
- Reference data.
- Receiver records.
- Receiver receipts.
- Dedupe keys.

---

## Distribution Policy

The Rust version should produce a standalone binary for normal MCP, CLI, and HTTP use.

Before implementation starts, decide the npm bridge:

- Keep `@kyanitelabs/epoch` as the install identity.
- Prefer an npm wrapper that downloads or invokes the platform binary.
- Preserve `npx @kyanitelabs/epoch` behavior for MCP setup.
- Do not require Node for normal runtime after installation unless the bridge itself needs Node for package-manager compatibility.
- Document platform support and fallback behavior before release packaging work.

This is an execution pre-flight, not a late packaging detail.

---

## Superiority Gate

Rust is not superior enough merely because it is Rust.

The first Rust release candidate must pass all parity gates and these improvement gates:

- **Standalone runtime:** normal MCP, CLI, and HTTP use works through a Rust binary without requiring Node.
- **Surface drift prevention:** CI fails when tools, schemas, annotations, CLI, HTTP, docs, or skill diverge.
- **Typed boundaries:** public request/response models are `serde` and `schemars` types; core logic avoids unstructured JSON except at adapters.
- **State safety:** local writes are atomic, isolated in tests, and migration-aware.
- **Leak-resistant diagnostics:** public errors do not expose full local paths, free-text notes, credentials, project names, or telemetry-sensitive fields.
- **Contract localization:** parity failures identify the affected tool and surface.

---

## Verification Plan

### Phase 0: Contract Inventory

- Generate the canonical tool manifest from current TypeScript.
- Inventory CLI commands and flags.
- Inventory HTTP routes and response envelopes.
- Inventory local state shapes.
- Inventory docs and public skill references.
- Add the compatibility-exception template.

### Phase 1: Rust Contract Skeleton

- Create `epoch-contract` types and manifest.
- Generate JSON schemas.
- Compare Rust schemas against TypeScript/Zod schemas.
- Do not implement business logic beyond test scaffolding.

### Phase 2: Core Parity

- Port pure logic tool family by tool family.
- Add golden fixtures for all 24 tools.
- Validate success and error cases.
- Classify every divergence.

### Phase 3: Adapter Parity

- MCP `tools/list` and `tools/call` smoke tests.
- CLI smoke tests under isolated `EPOCH_DATA_DIR`.
- HTTP route smoke tests.
- OpenAPI and `llms.txt` drift checks.
- Feedback endpoint parity.

### Phase 4: Local State and Telemetry

- Read TypeScript-created state from temp copies.
- Verify feedback-token matching.
- Verify calibration on matched estimate/actual pairs.
- Verify telemetry opt-in and no-default-receiver behavior.
- Verify HMAC signing and receiver dedupe.

### Phase 5: Release Candidate

- Local-only canary is the release gate.
- Provider canaries run only after local parity passes.
- npm bridge is tested on supported platforms.
- Docs, README, OpenAPI, and public skill are regenerated or checked from the same manifest.

---

## Acceptance Criteria

The Rust successor is acceptable when:

- All 24 MCP tools are discoverable.
- Write tools remain annotated as write tools.
- All 11 HTTP routes are present.
- CLI command families match current intent.
- Golden fixtures pass for all tool families.
- Rust reads TypeScript-created local state without corruption.
- Telemetry remains opt-in with no default receiver URL.
- Receiver dedupe behavior is preserved.
- Public docs and `skills/epoch/SKILL.md` match the canonical manifest.
- Release checks fail on public-surface drift.
- Leak audit passes for generated docs and public artifacts.

---

## Non-Goals

- No breaking v2 tool redesign in the first Rust migration.
- No cloud-first telemetry.
- No default receiver endpoint.
- No migration that rewrites user data before read compatibility is proven.
- No provider-canary dependency as the primary release gate.
- No hand-maintained duplicate tool lists after the manifest exists.

---

## Risks And Mitigations

**Risk:** Compatibility surface is larger than the math code.

Mitigation: Start from inventory, schemas, and fixtures before implementation.

**Risk:** TypeScript quirks become permanent by accident.

Mitigation: Classify divergences with the compatibility exception policy.

**Risk:** A single manifest becomes too abstract.

Mitigation: Keep it limited to public contract; business logic remains in typed modules.

**Risk:** Local data migration corrupts user state.

Mitigation: Read first, test on temp copies, write atomically, and version only after compatibility is proven.

**Risk:** Provider canary volatility obscures local regressions.

Mitigation: Local-only parity is the release gate; provider canaries are compatibility signals.

**Risk:** npm packaging becomes an afterthought.

Mitigation: Decide the npm bridge as the first implementation pre-flight.

---

## Execution Handoff Guidance

Recommended next workflow:

1. Use the execution-planning skill to break this spec into implementation phases.
2. Use an Ultragoal-style goal when the next session should execute end to end with durable checkpoints.
3. Use a Team or Ultrawork lane only after contract inventory is complete and worker scopes are isolated.
4. Use Ralph only if an explicit self-referential orchestration loop is requested.
5. Use performance or autoresearch modes only for bounded benchmarks or external validation, not for the base migration.

Suggested agent roles for follow-up work:

- **Planner:** turn this design into an execution plan and ordered milestones.
- **Architect:** review crate boundaries, manifest design, and compatibility policy.
- **Dependency Expert:** validate `rmcp`, `schemars`, HTTP framework, CLI framework, and npm binary bridge choices.
- **Test Engineer:** build parity fixture strategy and local-state test harness.
- **Executor:** implement one narrow crate or tool-family slice at a time.
- **Verifier:** run drift checks, parity tests, canaries, and leak audits.
- **Critic:** challenge release readiness and migration safety before replacement.
- **Writer:** update README, docs, OpenAPI prose, and public skill from the manifest.
- **Git Master:** stage and commit cleanly after leak audit and verification pass.

Worker discipline:

- Use isolated scopes.
- One artifact equals one change unit.
- Verify before commit.
- Never write outside the assigned scope.
- Keep TypeScript behavior available as the oracle until the Rust release candidate passes.

---

## ADR

**Decision:** Build a wire-compatible Rust successor in this repo during migration.

**Drivers:** Compatibility risk, calibration trust, operational simplicity.

**Alternatives:** Behavior-frozen Rust port first; breaking Rust v2 rewrite.

**Why:** Option A protects existing users and data while enabling Rust-native internals, standalone distribution, stricter schemas, better drift prevention, and safer local state.

**Consequences:** The migration must invest early in fixtures, schema parity, CLI/HTTP/MCP smoke tests, local-state compatibility, and npm packaging strategy. Rust cannot replace TypeScript until parity gates pass.

**Follow-ups:** Decide npm bridge, add compatibility-exception records, pre-classify known TypeScript quirks, decide JSONL write-versioning after read compatibility, and generate docs from the contract manifest.
