# Epoch Audit Remediation Implementation Plan

> Historical archive: this was the execution plan for the May 9, 2026 remediation run.
> For current release truth, use `docs/plans/2026-05-09-epoch-audit-remediation-report.md`
> and the release verification commands in `README.md`.

**Goal:** Remediate every issue found in the 2026-05-09 Epoch audit so telemetry/data ingestion is verifiable, calculations use fresh calibration data, CI/release gates are real, and the repo can be safely released.

**Architecture:** Treat this as a sequence of small, test-first repair lanes. First stabilize the current working tree and test isolation, then make CI/release fail closed, then repair public API/docs contracts, then make telemetry/calibration ingestion observable and verifiable, then clean lint/debt and publish a final evidence bundle. Each task has an atomic commit boundary using the repo Lore Commit Protocol.

**Tech Stack:** TypeScript, Node.js >=20, pnpm, Vitest, ESLint, tsup, Hono, Commander, Zod, GitHub Actions, JSONL local data under `~/.epoch` or `EPOCH_DATA_DIR`.

---

## Success criteria

The remediation is complete only when all of these are true:

- `git status --short` contains only intentional committed changes or is clean.
- `pnpm run typecheck` passes.
- `pnpm run lint` passes with zero errors; warnings are either zero or explicitly accepted in `eslint.config.js`.
- `pnpm test` passes.
- `pnpm run build` passes.
- `node scripts/validate-community-data.mjs` passes.
- `npm pack --dry-run --json` shows expected package contents and no accidental `.omx`, `.omc`, `coverage`, or private runtime files.
- HTTP `/openapi.json` documents `/v1/telemetry` and feedback endpoints, not just tool endpoints.
- Telemetry status, preview, submit, receiver, and backfill semantics agree under an isolated `EPOCH_DATA_DIR` integration test.
- Calibration/reference DB freshness is visible and test-covered.
- CI and release cannot pass/publish after failed typecheck/lint/tests.
- A final remediation report maps every original audit issue to code/test evidence.

---

## Phase 0: protect the dirty working tree and create an execution lane

### Task 0.1: Capture current state before edits

**Files:**
- Create: `docs/plans/2026-05-09-epoch-audit-remediation-baseline.md`

**Step 1: Record the current git state**

Run:

```bash
git status --short
git branch --show-current
git log -1 --oneline
git diff --stat
git diff --name-status
```

Expected: output includes the current dirty telemetry/doc changes and untracked telemetry scripts.

**Step 2: Save a baseline note**

Write the command outputs into `docs/plans/2026-05-09-epoch-audit-remediation-baseline.md` with sections:

```markdown
# Epoch Audit Remediation Baseline

- Branch: main
- Base commit: <git log -1 --oneline>
- Dirty files: <paste git status --short>
- Existing failing gates: pnpm test, pnpm run lint
```

**Step 3: Create a remediation branch/worktree**

Preferred if no one else owns the lane:

```bash
git switch -c audit-remediation-2026-05-09
```

If preserving current `main` dirty state is safer, use a worktree instead:

```bash
git worktree add ../Epoch-audit-remediation -b audit-remediation-2026-05-09
```

**Step 4: Commit only the plan/baseline if desired**

```bash
git add docs/plans/2026-05-09-epoch-audit-remediation.md docs/plans/2026-05-09-epoch-audit-remediation-baseline.md
git commit -m "Plan audit remediation before repairs

Constraint: Existing working tree already contains telemetry and documentation edits.
Confidence: high
Scope-risk: narrow
Directive: Preserve pre-existing dirty changes unless a task explicitly owns the file.
Tested: git status --short; git diff --stat
Not-tested: no code changed"
```

---

## Phase 1: make the current tests deterministic and green

### Task 1.1: Isolate HTTP telemetry tests from real `~/.epoch`

**Original issue covered:** Telemetry receiver test is non-isolated and currently fails.

**Files:**
- Modify: `src/entries/http.test.ts`

**Step 1: Write/adjust the failing isolation test setup**

Add imports near the top:

```ts
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
```

Add a deterministic test data directory:

```ts
const TEST_DIR = join(tmpdir(), `epoch-http-test-${process.pid}`);
```

Change the existing `beforeEach`/`afterEach` block to isolate data:

```ts
beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  app = createApiApp();
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});
```

**Step 2: Prove the previously failing test now passes**

Run:

```bash
pnpm exec vitest run src/entries/http.test.ts -t "accepts signed anonymized telemetry payloads" --reporter=verbose
```

Expected: PASS.

**Step 3: Run full HTTP test file**

```bash
pnpm exec vitest run src/entries/http.test.ts --reporter=verbose
```

Expected: all HTTP tests pass.

**Step 4: Commit**

```bash
git add src/entries/http.test.ts
git commit -m "Isolate HTTP telemetry receiver tests

Constraint: Telemetry dedupe keys persist in EPOCH_DATA_DIR and were leaking from the real user store.
Rejected: Changing receiver dedupe behavior to satisfy the test | the bug is test isolation, not dedupe.
Confidence: high
Scope-risk: narrow
Directive: New tests that touch ~/.epoch must set EPOCH_DATA_DIR.
Tested: pnpm exec vitest run src/entries/http.test.ts -t 'accepts signed anonymized telemetry payloads' --reporter=verbose; pnpm exec vitest run src/entries/http.test.ts --reporter=verbose"
```

### Task 1.2: Re-run the full test suite and fix any fallout

**Files:**
- Modify only files implicated by failures.

**Step 1: Run full tests**

```bash
pnpm test
```

Expected after Task 1.1: all tests pass.

**Step 2: If failures remain, fix test-first**

For each failure:
1. Copy the exact failing assertion into the baseline note.
2. Add/adjust the smallest test proving intended behavior.
3. Implement the minimal fix.
4. Re-run the specific file.
5. Re-run `pnpm test`.

**Step 3: Commit if additional code changed**

Use one commit per independent failure.

---

## Phase 2: make CI and release fail closed

### Task 2.1: Remove `continue-on-error` from CI quality gates

**Original issue covered:** CI can pass with failed typecheck/lint/tests.

**Files:**
- Modify: `.github/workflows/ci.yml:32-42`

**Step 1: Edit CI workflow**

Change:

```yaml
      - name: Typecheck
        run: pnpm run typecheck
        continue-on-error: true

      - name: Lint
        run: pnpm run lint
        continue-on-error: true

      - name: Test
        run: pnpm test
        continue-on-error: true
```

to:

```yaml
      - name: Typecheck
        run: pnpm run typecheck

      - name: Lint
        run: pnpm run lint

      - name: Test
        run: pnpm test
```

**Step 2: Add a workflow guard test**

Create or extend `src/entries/cli.test.ts` is not appropriate for workflows. Prefer a small Node script only if repo already has workflow tests. If not, add a shell verification command to final evidence:

```bash
node - <<'NODE'
const fs = require('fs');
for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  const text = fs.readFileSync(file, 'utf8');
  if (/continue-on-error:\s*true/.test(text)) {
    throw new Error(`${file} still has continue-on-error: true`);
  }
}
console.log('workflow gates are fail-closed');
NODE
```

Expected: `workflow gates are fail-closed`.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Make CI quality gates fail closed

Constraint: Release readiness cannot depend on proxy green builds.
Rejected: Keeping continue-on-error for developer convenience | it hides broken tests and lint.
Confidence: high
Scope-risk: narrow
Directive: Do not reintroduce continue-on-error on typecheck, lint, or tests.
Tested: node workflow gate check"
```

### Task 2.2: Remove `continue-on-error` from release workflow

**Original issue covered:** Release can publish after failed typecheck/test.

**Files:**
- Modify: `.github/workflows/release.yml:31-37`

**Step 1: Edit release workflow**

Change:

```yaml
      - name: Typecheck
        run: pnpm run typecheck
        continue-on-error: true

      - name: Test
        run: pnpm test
        continue-on-error: true
```

to:

```yaml
      - name: Typecheck
        run: pnpm run typecheck

      - name: Lint
        run: pnpm run lint

      - name: Test
        run: pnpm test
```

**Step 2: Run workflow guard**

```bash
node - <<'NODE'
const fs = require('fs');
for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  const text = fs.readFileSync(file, 'utf8');
  if (/continue-on-error:\s*true/.test(text)) throw new Error(`${file} unsafe`);
}
if (!fs.readFileSync('.github/workflows/release.yml','utf8').includes('pnpm run lint')) {
  throw new Error('release workflow must run lint');
}
console.log('release gates are fail-closed');
NODE
```

Expected: `release gates are fail-closed`.

**Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "Block release on failed validation

Constraint: npm publish must not run after failed tests or lint.
Rejected: Relying on CI branch checks before tag release | tag releases can bypass stale branch evidence.
Confidence: high
Scope-risk: narrow
Directive: Release workflow must run typecheck, lint, test, and build before publish.
Tested: node workflow gate check"
```

---

## Phase 3: repair HTTP/OpenAPI/API surface contracts

### Task 3.1: Document telemetry and feedback endpoints in OpenAPI

**Original issue covered:** OpenAPI omits non-tool endpoints.

**Files:**
- Modify: `src/entries/http.ts:292-367`
- Test: `src/entries/http.test.ts`

**Step 1: Add failing OpenAPI tests**

Add tests under `GET /openapi.json`:

```ts
it("documents telemetry receiver endpoint", async () => {
  const res = await app.request("/openapi.json");
  const spec = await res.json() as { paths: Record<string, unknown> };
  expect(spec.paths["/v1/telemetry"]).toBeTruthy();
});

it("documents feedback endpoints", async () => {
  const res = await app.request("/openapi.json");
  const spec = await res.json() as { paths: Record<string, unknown> };
  expect(spec.paths["/v1/feedback/record-actual"]).toBeTruthy();
  expect(spec.paths["/v1/feedback/pending"]).toBeTruthy();
  expect(spec.paths["/v1/feedback/batch-record-actuals"]).toBeTruthy();
  expect(spec.paths["/v1/feedback/health"]).toBeTruthy();
});
```

Run:

```bash
pnpm exec vitest run src/entries/http.test.ts -t "documents telemetry receiver endpoint|documents feedback endpoints" --reporter=verbose
```

Expected: FAIL before implementation.

**Step 2: Add OpenAPI path builders**

In `src/entries/http.ts`, add helper objects near `buildOpenApiSpec()`:

```ts
const telemetryPath = {
  post: {
    operationId: "receiveTelemetry",
    summary: "Receive signed anonymized Epoch telemetry payloads.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["schema_version", "installation_id", "epoch_version", "records", "generated_at"],
            properties: {
              schema_version: { type: "integer", const: 1 },
              installation_id: { type: "string" },
              epoch_version: { type: "string" },
              generated_at: { type: "string", format: "date-time" },
              records: {
                type: "array",
                maxItems: 100,
                items: {
                  type: "object",
                  required: ["task_type", "complexity", "tool", "estimated_hours", "actual_hours", "ratio", "date"],
                  properties: {
                    task_type: { type: "string" },
                    complexity: { anyOf: [{ type: "number" }, { type: "null" }] },
                    tool: { type: "string" },
                    estimated_hours: { type: "number" },
                    actual_hours: { type: "number" },
                    ratio: { type: "number" },
                    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Accepted telemetry counts" },
      "400": { description: "Invalid payload" },
      "401": { description: "Missing or invalid signature" },
    },
  },
} satisfies Record<string, unknown>;
```

Then append after tool paths are built:

```ts
paths["/v1/telemetry"] = telemetryPath;
paths["/v1/feedback/record-actual"] = feedbackRecordActualPath;
paths["/v1/feedback/pending"] = feedbackPendingPath;
paths["/v1/feedback/batch-record-actuals"] = feedbackBatchPath;
paths["/v1/feedback/health"] = feedbackHealthPath;
```

Keep helper objects compact; do not duplicate every response schema in full unless tests require it.

**Step 3: Re-run tests**

```bash
pnpm exec vitest run src/entries/http.test.ts --reporter=verbose
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/entries/http.ts src/entries/http.test.ts
git commit -m "Document telemetry and feedback HTTP endpoints

Constraint: OpenAPI previously described only tool routes while HTTP exposed ingestion routes.
Rejected: Leaving telemetry route undocumented | clients cannot discover the real intake API.
Confidence: high
Scope-risk: moderate
Directive: Any new HTTP route must be represented in /openapi.json or explicitly internal-only.
Tested: pnpm exec vitest run src/entries/http.test.ts --reporter=verbose"
```

### Task 3.2: Decide and fix runtime exports contract

**Original issue covered:** package exports no runtime symbols despite `exports`/`types` contract.

**Files:**
- Modify: `src/index.ts`
- Possibly create: `src/public-api.ts`
- Test: add `src/index.test.ts` or extend package/import test if one exists.
- Modify: `package.json` only if choosing CLI-only contract.

**Decision:** Prefer exporting a real public API while keeping CLI side effects guarded. This is better than removing `exports` because the package already advertises types and library importability.

**Step 1: Add failing import test**

Create `src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";

it("exports stable runtime APIs without starting a server", async () => {
  const mod = await import("./index.js");
  expect(typeof mod.pertEstimate).toBe("function");
  expect(typeof mod.referenceClassEstimate).toBe("function");
  expect(typeof mod.submitTelemetry).toBe("function");
});
```

Run:

```bash
pnpm exec vitest run src/index.test.ts --reporter=verbose
```

Expected: FAIL before implementation.

**Step 2: Export stable functions**

At top-level in `src/index.ts`, add exports:

```ts
export { pertEstimate, sprintForecast, cocomoEstimate, criticalPath, monteCarloSim } from "./lib/estimation.js";
export { referenceClassEstimate, calibrateEstimates, tokenTimeBridge, computeAccuracyMetrics } from "./lib/analytics.js";
export { tokenCostEstimate, compareModels } from "./lib/cost.js";
export { scheduleRisk } from "./lib/risk.js";
export { recordEstimate, recordActual, getCalibrationData, getFeedbackHealthReport } from "./lib/feedback.js";
export { extractAnonymizedRecords, buildPayload, signPayload, submitTelemetry } from "./lib/telemetry-submit.js";
export { receiveTelemetry } from "./lib/telemetry-receiver.js";
```

Guard CLI startup so imports have no side effects:

```ts
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) main();
```

This requires:

```ts
import { pathToFileURL } from "node:url";
```

**Step 3: Re-run import/build tests**

```bash
pnpm exec vitest run src/index.test.ts --reporter=verbose
pnpm run build
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m).sort().slice(0, 10)))"
```

Expected: import test passes; build passes; runtime import prints exported symbols and does not start MCP/HTTP.

**Step 4: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "Expose a side-effect-free public API

Constraint: package.json exports dist/index.js as an importable module.
Rejected: Removing exports and treating Epoch as CLI-only | consumers already get type declarations and expect imports to work.
Confidence: medium
Scope-risk: moderate
Directive: Keep startup behind an entrypoint guard; imports must never launch MCP or HTTP servers.
Tested: pnpm exec vitest run src/index.test.ts --reporter=verbose; pnpm run build; node import smoke"
```

---

## Phase 4: make telemetry/data ingestion truth visible and correct

### Task 4.1: Split telemetry preview into `allRecords` and `queuedRecords`

**Original issue covered:** telemetry status said `queuedRecords: 0` while preview showed 383 available records.

**Files:**
- Modify: `src/entries/cli.ts:621-660`
- Test: `src/entries/cli.test.ts`

**Step 1: Add failing CLI tests**

Add tests under telemetry CLI tests:

```ts
it("telemetry preview reports all records and queued records separately", async () => {
  // arrange isolated EPOCH_DATA_DIR, one old submitted record, one new record
  // assert JSON has totalRecords and queuedRecords with distinct values
});

it("telemetry status exposes last submission cutoff used for queued records", async () => {
  // arrange config.lastSubmissionAt
  // assert status JSON includes lastSubmissionAt and queuedRecords
});
```

Use existing CLI test helpers and isolated `EPOCH_DATA_DIR` setup already present in `src/entries/cli.test.ts`.

**Step 2: Implement preview semantics**

Change preview summary from:

```ts
const records = extractAnonymizedRecords();
const summary = { totalRecords: records.length, ... };
```

to:

```ts
const { loadConfig } = await import("../lib/config.js");
const config = loadConfig();
const allRecords = extractAnonymizedRecords();
const queuedRecords = extractAnonymizedRecords(config.telemetry.lastSubmissionAt ?? undefined);
const summary = {
  totalRecords: allRecords.length,
  queuedRecords: queuedRecords.length,
  lastSubmissionAt: config.telemetry.lastSubmissionAt,
  fields: Object.keys(allRecords[0] ?? {}),
  strippedFields: ["estimateId", "source", "notes", "teamId", "time-of-day"],
  sample: allRecords.slice(0, 5),
};
```

**Step 3: Re-run CLI tests**

```bash
pnpm exec vitest run src/entries/cli.test.ts -t "telemetry" --reporter=verbose
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/entries/cli.ts src/entries/cli.test.ts
git commit -m "Clarify telemetry preview queue semantics

Constraint: total historical anonymized records and queued post-cutoff records answer different operational questions.
Rejected: Renaming queuedRecords only in docs | the CLI JSON contract itself was ambiguous.
Confidence: high
Scope-risk: narrow
Directive: Status answers queue state; preview must show all-vs-queued explicitly.
Tested: pnpm exec vitest run src/entries/cli.test.ts -t telemetry --reporter=verbose"
```

### Task 4.2: Make submit counters reflect accepted and deduplicated receiver results

**Original issue covered:** local `totalRecordsSubmitted` is sender bookkeeping, not receiver acceptance proof.

**Files:**
- Modify: `src/lib/telemetry-submit.ts`
- Test: `src/lib/telemetry-submit.test.ts`
- Modify: `src/lib/config.ts` if adding fields.
- Test: `src/lib/config.test.ts` if config shape changes.

**Step 1: Extend config model**

In `src/lib/config.ts`, add optional counters:

```ts
lastSubmissionAcceptedCount: number;
lastSubmissionDeduplicatedCount: number;
totalRecordsAccepted: number;
totalRecordsDeduplicated: number;
```

Add defaults of `0` in `DEFAULT_CONFIG`.

**Step 2: Add failing tests**

In `src/lib/telemetry-submit.test.ts`, add:

```ts
it("records accepted and deduplicated counts returned by receiver", async () => {
  // arrange one valid record and config enabled
  globalThis.fetch = (async () => new Response(JSON.stringify({ accepted: 0, deduplicated: 1 }), { status: 200 })) as typeof fetch;
  const { submitTelemetry } = await import("./telemetry-submit.js");
  const result = await submitTelemetry();
  expect(result).toEqual({ ok: true, recordCount: 1, accepted: 0, deduplicated: 1 });
  const { loadConfig } = await import("./config.js");
  expect(loadConfig().telemetry.totalRecordsAccepted).toBe(0);
  expect(loadConfig().telemetry.totalRecordsDeduplicated).toBe(1);
});
```

Update `SubmissionResult` expected type accordingly.

**Step 3: Parse receiver body in submit**

In `submitTelemetry()` after `response.ok`:

```ts
const body = await response.json().catch(() => ({})) as { accepted?: unknown; deduplicated?: unknown };
const accepted = typeof body.accepted === "number" ? body.accepted : capped.length;
const deduplicated = typeof body.deduplicated === "number" ? body.deduplicated : 0;
config.telemetry.lastSubmissionRecordCount += capped.length;
config.telemetry.lastSubmissionAcceptedCount = accepted;
config.telemetry.lastSubmissionDeduplicatedCount = deduplicated;
config.telemetry.totalRecordsAccepted += accepted;
config.telemetry.totalRecordsDeduplicated += deduplicated;
```

Return:

```ts
return { ok: true, recordCount: capped.length, accepted, deduplicated };
```

**Step 4: Surface counters in CLI status**

In `src/entries/cli.ts`, add fields:

```ts
lastSubmissionAcceptedCount: config.telemetry.lastSubmissionAcceptedCount,
lastSubmissionDeduplicatedCount: config.telemetry.lastSubmissionDeduplicatedCount,
totalRecordsAccepted: config.telemetry.totalRecordsAccepted,
totalRecordsDeduplicated: config.telemetry.totalRecordsDeduplicated,
```

**Step 5: Re-run targeted tests**

```bash
pnpm exec vitest run src/lib/config.test.ts src/lib/telemetry-submit.test.ts src/entries/cli.test.ts -t "telemetry|config" --reporter=verbose
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lib/config.ts src/lib/config.test.ts src/lib/telemetry-submit.ts src/lib/telemetry-submit.test.ts src/entries/cli.ts src/entries/cli.test.ts
git commit -m "Track receiver-accepted telemetry counts

Constraint: sender submitted counts do not prove receiver acceptance or uniqueness.
Rejected: Reporting submitted count as proof | dedupe and receiver rejection make that misleading.
Confidence: high
Scope-risk: moderate
Directive: Operational status must distinguish submitted, accepted, and deduplicated counts.
Tested: pnpm exec vitest run src/lib/config.test.ts src/lib/telemetry-submit.test.ts src/entries/cli.test.ts -t 'telemetry|config' --reporter=verbose"
```

### Task 4.3: Add isolated end-to-end telemetry ingestion test

**Original issues covered:** data ingestion proof, silent intake mismatch, status/preview/receiver semantics.

**Files:**
- Create: `src/lib/telemetry-integration.test.ts` or add to `src/lib/telemetry-submit.test.ts`

**Step 1: Write an integration test using only local functions**

Create `src/lib/telemetry-integration.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(tmpdir(), `epoch-telemetry-e2e-${process.pid}`);

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("telemetry ingestion end to end", () => {
  it("extracts feedback, signs payload, receives records, and deduplicates repeats", async () => {
    const { recordEstimate, recordActual } = await import("./feedback.js");
    const id = recordEstimate("reference_class_estimate", { task_type: "feature", complexity: 3 }, { correctedEstimate: 4 });
    expect(recordActual(id, 5)).toBe(true);

    const { extractAnonymizedRecords, buildPayload, signPayload } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords();
    expect(records).toHaveLength(1);

    const payload = buildPayload(records);
    const raw = JSON.stringify(payload);
    const signature = signPayload(payload, payload.installation_id);
    expect(signature).toBe(createHmac("sha256", payload.installation_id).update(raw).digest("hex"));

    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    expect(receiveTelemetry(raw, signature)).toMatchObject({ ok: true, accepted: 1, deduplicated: 0 });
    expect(receiveTelemetry(raw, signature)).toMatchObject({ ok: true, accepted: 0, deduplicated: 1 });

    const stored = readFileSync(join(TEST_DIR, "telemetry-records.jsonl"), "utf8").trim().split("\n");
    expect(stored).toHaveLength(1);
    expect(existsSync(join(TEST_DIR, "telemetry-receipts.jsonl"))).toBe(true);
  });
});
```

**Step 2: Run test**

```bash
pnpm exec vitest run src/lib/telemetry-integration.test.ts --reporter=verbose
```

Expected: PASS.

**Step 3: Commit**

```bash
git add src/lib/telemetry-integration.test.ts
git commit -m "Prove telemetry ingestion end to end

Constraint: Sender status alone cannot prove receiver storage or dedupe behavior.
Rejected: Relying only on live Tailscale receiver checks | tests need local deterministic proof.
Confidence: high
Scope-risk: narrow
Directive: Keep telemetry e2e tests isolated with EPOCH_DATA_DIR.
Tested: pnpm exec vitest run src/lib/telemetry-integration.test.ts --reporter=verbose"
```

### Task 4.4: Make backfill script safe, documented, and tested or explicitly experimental

**Original issue covered:** untracked telemetry backfill/deploy scripts are part of dirty operational state.

**Files:**
- Modify: `scripts/backfill-telemetry.mjs`
- Test: create `scripts/backfill-telemetry.test.mjs` only if adding script tests is practical; otherwise add CLI smoke in final evidence.
- Modify: `docs/TELEMETRY.md`

**Step 1: Decide script status**

If script is production-supported, keep it and test it. If it is one-off rescue tooling, move under `scripts/ops/` and label it operational.

Preferred: keep `scripts/backfill-telemetry.mjs` and add a dry-run mode.

**Step 2: Add dry-run support**

Add:

```js
const dryRun = process.argv.includes("--dry-run");
```

Before fetch:

```js
if (dryRun) {
  submitted += chunk.length;
  continue;
}
```

Final JSON includes `dryRun`.

**Step 3: Smoke test**

```bash
EPOCH_DATA_DIR=$(mktemp -d) node scripts/backfill-telemetry.mjs --endpoint http://127.0.0.1:3099/v1/telemetry --dry-run
```

Expected: JSON with `ok: true`, `dryRun: true`, no network call.

**Step 4: Document it**

In `docs/TELEMETRY.md`, add a short “Backfill” section:

```md
### Backfill historical anonymized records

Use this only after verifying the endpoint. It sends the same anonymized fields shown by `epoch telemetry preview` and reports submitted, accepted, and deduplicated counts.

```bash
node scripts/backfill-telemetry.mjs --endpoint http://100.x.y.z:3099/v1/telemetry --dry-run
node scripts/backfill-telemetry.mjs --endpoint http://100.x.y.z:3099/v1/telemetry
```
```

**Step 5: Commit**

```bash
git add scripts/backfill-telemetry.mjs docs/TELEMETRY.md
git commit -m "Make telemetry backfill auditable

Constraint: Historical submissions need a safe preview path before network writes.
Rejected: Keeping backfill as untracked local rescue code | operational data paths need reviewable scripts.
Confidence: medium
Scope-risk: moderate
Directive: Backfill must report submitted, accepted, and deduplicated counts and support dry-run.
Tested: EPOCH_DATA_DIR=$(mktemp -d) node scripts/backfill-telemetry.mjs --endpoint http://127.0.0.1:3099/v1/telemetry --dry-run"
```

---

## Phase 5: make calibration freshness and calculation data use explicit

### Task 5.1: Add reference database freshness reporting

**Original issue covered:** local data is present, but bundled reference DB is stale.

**Files:**
- Modify: `src/lib/self-improve.ts`
- Modify: `src/entries/cli.ts`
- Test: `src/lib/self-improve.test.ts`, `src/entries/cli.test.ts`

**Step 1: Export a reference DB status helper**

In `src/lib/self-improve.ts`, add:

```ts
export interface ReferenceDbStatus {
  path: string | null;
  loaded: boolean;
  generatedAt: string | null;
  sampleSize: number | null;
  source: string | null;
  globalCorrectionFactor: number | null;
  taskTypeCorrectionFactorCount: number;
  toolTaskCorrectionFactorCount: number;
  complexityCorrectionFactorCount: number;
}

export function getReferenceDbStatus(): ReferenceDbStatus {
  const db = loadReferenceDb();
  return {
    path: db ? REFERENCE_DB_PATH : null,
    loaded: db !== null,
    generatedAt: db?.generatedAt ?? null,
    sampleSize: db?.sampleSize ?? null,
    source: db?.source ?? null,
    globalCorrectionFactor: db?.globalCorrectionFactor ?? null,
    taskTypeCorrectionFactorCount: Object.keys(db?.taskTypeCorrectionFactors ?? {}).length,
    toolTaskCorrectionFactorCount: Object.keys(db?.toolTaskCorrectionFactors ?? {}).length,
    complexityCorrectionFactorCount: Object.keys(db?.complexityCorrectionFactors ?? {}).length,
  };
}
```

If exposing `REFERENCE_DB_PATH` is undesirable, return `sourceKind: "user" | "bundled" | "fallback"` instead.

**Step 2: Add CLI command**

In `src/entries/cli.ts`, add command:

```ts
program
  .command("reference-db-status")
  .description("Show active reference database provenance and calibration freshness")
  .action(async () => {
    const { getReferenceDbStatus } = await import("../lib/self-improve.js");
    process.stdout.write(JSON.stringify(getReferenceDbStatus(), null, 2) + "\n");
    process.exit(0);
  });
```

**Step 3: Add tests**

Add self-improve test that mocked DB returns counts. Add CLI test that command returns JSON with `loaded`, `sampleSize`, `globalCorrectionFactor`.

**Step 4: Run tests**

```bash
pnpm exec vitest run src/lib/self-improve.test.ts src/entries/cli.test.ts -t "reference-db" --reporter=verbose
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/self-improve.ts src/lib/self-improve.test.ts src/entries/cli.ts src/entries/cli.test.ts
git commit -m "Expose reference database freshness

Constraint: Calculation accuracy depends on knowing which calibration DB is active.
Rejected: Treating bundled DB freshness as implicit | local learned data can diverge from package data.
Confidence: high
Scope-risk: moderate
Directive: Any accuracy report must include active reference DB provenance.
Tested: pnpm exec vitest run src/lib/self-improve.test.ts src/entries/cli.test.ts -t reference-db --reporter=verbose"
```

### Task 5.2: Regenerate or intentionally freeze bundled reference data

**Original issue covered:** package reference DB lags local learned data.

**Files:**
- Modify: `src/data/reference-database.json`
- Possibly modify: `dist/reference-database.json` only after build.
- Scripts: `scripts/recompute-refdb.py` or `node dist/index.js self-improve`

**Step 1: Decide policy**

Choose one:

A. **Bundle refreshed aggregate data**: regenerate `src/data/reference-database.json` from approved anonymized/calibrated records.
B. **Keep package DB as a verified baseline**: document that package uses a verified bundled baseline, and user-local `~/.epoch/reference-database.json` is the self-improving source.

Preferred for this audit: A, but only if input data is anonymized and approved for repo inclusion. If not, choose B and make freshness status explicit.

**Step 2A: If refreshing bundled DB**

Run the approved recompute command:

```bash
python scripts/recompute-refdb.py
pnpm run build
node -e "const j=require('./dist/reference-database.json'); console.log(j.generatedAt, j.sampleSize, j.globalCorrectionFactor)"
```

Expected: `generatedAt` updates, sample size reflects approved dataset, complexity factors present if source data supports them.

**Step 2B: If freezing bundled DB**

Add docs in `docs/TELEMETRY.md` or `README.md`:

```md
Epoch ships with a verified baseline reference database. Self-improvement writes an active user-local database to `~/.epoch/reference-database.json`; use `epoch reference-db-status` to see which database is active and why any bundled factor family is not populated yet.
```

**Step 3: Add freshness verifier**

Create `scripts/verify-reference-db.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from "node:fs";
const db = JSON.parse(readFileSync("src/data/reference-database.json", "utf8"));
if (!db.generatedAt || !db.sampleSize || typeof db.globalCorrectionFactor !== "number") {
  throw new Error("reference database missing required provenance fields");
}
console.log(JSON.stringify({ ok: true, generatedAt: db.generatedAt, sampleSize: db.sampleSize, globalCorrectionFactor: db.globalCorrectionFactor }));
```

Run:

```bash
node scripts/verify-reference-db.mjs
```

Expected: `ok: true` JSON.

**Step 4: Commit**

```bash
git add src/data/reference-database.json scripts/verify-reference-db.mjs docs/TELEMETRY.md README.md
git commit -m "Make reference database freshness explicit

Constraint: Local calibration data may be newer than bundled package data.
Rejected: Silent fallback to stale bundled calibration | users need provenance for accuracy claims.
Confidence: medium
Scope-risk: moderate
Directive: Regenerate or explicitly freeze bundled reference data before release.
Tested: node scripts/verify-reference-db.mjs; pnpm run build"
```

### Task 5.3: Add calculation correctness characterization tests for each estimator family

**Original issue covered:** ensure calculations are correct and using ingested data.

**Files:**
- Modify: `src/lib/estimation.test.ts`
- Modify: `src/lib/analytics.test.ts`
- Modify: `src/lib/risk.test.ts`
- Modify: `src/lib/feedback.test.ts`

**Step 1: Add reference-class correction test**

In `src/lib/analytics.test.ts`, add a test with 5 historical records whose median actual/estimated ratio is known and assert `correctionFactor` and `correctedEstimate`.

**Step 2: Add schedule-risk data-vs-profile fallback test**

In `src/lib/risk.test.ts`, mock or isolate `getCalibrationData()` with >=5 records and assert risk uses `computeAccuracyMetrics()` rather than developer profile fallback.

**Step 3: Add telemetry extraction from new feedback test**

In `src/lib/telemetry-submit.test.ts`, create two estimate/actual pairs before and after a cutoff and assert `extractAnonymizedRecords(cutoff)` includes only the newer record.

**Step 4: Run calculation tests**

```bash
pnpm exec vitest run src/lib/estimation.test.ts src/lib/analytics.test.ts src/lib/risk.test.ts src/lib/feedback.test.ts src/lib/telemetry-submit.test.ts --reporter=verbose
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/estimation.test.ts src/lib/analytics.test.ts src/lib/risk.test.ts src/lib/feedback.test.ts src/lib/telemetry-submit.test.ts
git commit -m "Characterize calibrated calculation behavior

Constraint: Audit requires proof that new feedback data changes estimates correctly.
Rejected: Relying on broad passing tests | the coverage must prove data-driven correction paths.
Confidence: high
Scope-risk: narrow
Directive: Keep estimator tests tied to known formulas and known fixture medians.
Tested: pnpm exec vitest run src/lib/estimation.test.ts src/lib/analytics.test.ts src/lib/risk.test.ts src/lib/feedback.test.ts src/lib/telemetry-submit.test.ts --reporter=verbose"
```

---

## Phase 6: eliminate silent failure blind spots

### Task 6.1: Replace silent telemetry/self-improvement catches with debug-visible errors

**Original issue covered:** swallowed errors in telemetry, feedback, self-improvement.

**Files:**
- Modify: `src/lib/telemetry.ts:104-108`
- Modify: `src/lib/telemetry-submit.ts:156`
- Modify: `src/lib/self-improve.ts:91-95`
- Test: relevant tests in `src/lib/telemetry.test.ts`, `src/lib/telemetry-submit.test.ts`, `src/lib/self-improve.test.ts`

**Step 1: Add shared internal logger**

Create `src/lib/internal/logging.ts`:

```ts
export function debugLog(scope: string, err: unknown): void {
  if (process.env["EPOCH_DEBUG"] !== "1") return;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[epoch:${scope}] ${message}\n`);
}
```

**Step 2: Replace silent catches**

Examples:

```ts
} catch (err) {
  debugLog("telemetry.flush", err);
}
```

```ts
submitTelemetry().catch((err: unknown) => { debugLog("telemetry.submit", err); });
```

```ts
updateReferenceDatabase().catch((err: unknown) => {
  debugLog("self-improve", err);
})
```

**Step 3: Add tests only where practical**

Test `debugLog()` directly:

```ts
it("writes debug logs only when EPOCH_DEBUG=1", () => { ... });
```

Do not overfit tests to private catch sites if it makes code brittle.

**Step 4: Run tests**

```bash
pnpm exec vitest run src/lib/internal src/lib/telemetry.test.ts src/lib/telemetry-submit.test.ts src/lib/self-improve.test.ts --reporter=verbose
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/internal/logging.ts src/lib/telemetry.ts src/lib/telemetry-submit.ts src/lib/self-improve.ts src/lib/internal/logging.test.ts src/lib/telemetry.test.ts src/lib/telemetry-submit.test.ts src/lib/self-improve.test.ts
git commit -m "Make non-critical failures debug-visible

Constraint: Telemetry and self-improvement should not crash normal tool calls.
Rejected: Fully throwing background errors | non-critical paths must stay non-blocking.
Confidence: high
Scope-risk: moderate
Directive: Non-critical catches must either return a typed reason or emit EPOCH_DEBUG diagnostics.
Tested: pnpm exec vitest run src/lib/internal src/lib/telemetry.test.ts src/lib/telemetry-submit.test.ts src/lib/self-improve.test.ts --reporter=verbose"
```

### Task 6.2: Preserve write failure reasons in feedback APIs

**Original issue covered:** `recordActual()` returns false without cause; HTTP reports misleading “Estimate ID may not exist”.

**Files:**
- Modify: `src/entries/http.ts:519-549`
- Test: `src/entries/http.test.ts`

**Step 1: Use `recordActualDetailed` in HTTP route**

Change import:

```ts
import { recordActualDetailed, ... } from "../lib/feedback.js";
```

Change route logic:

```ts
const result = recordActualDetailed(estimateId, actualHours, notes);
if (!result.ok) {
  const status = result.reason === "duplicate" ? 409 : result.reason === "below_threshold" || result.reason === "synthetic_id" ? 400 : 500;
  return c.json({
    ok: false,
    error: {
      isError: true,
      message: `Failed to record actual: ${result.reason}.`,
      retryHint: "Use a real estimate_id, positive actual_hours >= 0.25, and avoid duplicate submissions.",
    },
  }, status);
}
```

**Step 2: Add HTTP tests**

Add tests for duplicate and below-threshold actuals.

**Step 3: Run tests**

```bash
pnpm exec vitest run src/entries/http.test.ts -t "record-actual" --reporter=verbose
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/entries/http.ts src/entries/http.test.ts
git commit -m "Return explicit feedback write failure reasons

Constraint: Feedback writes can fail for threshold, duplicate, synthetic, or filesystem reasons.
Rejected: Generic estimate-id failure message | it obscures calibration data quality problems.
Confidence: high
Scope-risk: narrow
Directive: Public feedback APIs must preserve typed failure reasons.
Tested: pnpm exec vitest run src/entries/http.test.ts -t record-actual --reporter=verbose"
```

---

## Phase 7: fix lint baseline and code smells

### Task 7.1: Remove unused imports and dead code flagged by ESLint

**Original issue covered:** lint baseline has unused imports and dead wires.

**Files:**
- Modify: `src/dispatcher/mcp-adapter.ts`
- Modify: `src/dispatcher/tool-registry.ts`
- Modify: `src/lib/risk.ts`
- Modify test files with unused variables flagged by `pnpm run lint`.

**Step 1: Remove unused imports**

Known removals from audit:

```ts
// src/dispatcher/mcp-adapter.ts
// remove: type ToolDefinition

// src/dispatcher/tool-registry.ts
// remove unused TaskType, TimeMathOp, recordActual if still unused

// src/lib/risk.ts
// remove getEstimationResearch if still unused
```

**Step 2: Re-run lint and fix next unused errors**

```bash
pnpm run lint
```

Expected initially: fewer errors.

**Step 3: Commit unused/dead-code cleanup**

```bash
git add src/dispatcher/mcp-adapter.ts src/dispatcher/tool-registry.ts src/lib/risk.ts <other touched files>
git commit -m "Remove dead imports from lint baseline

Constraint: Lint currently fails on unused symbols that hide real issues.
Rejected: Disabling no-unused-vars | dead wires should be deleted.
Confidence: high
Scope-risk: narrow
Directive: Keep lint errors actionable instead of suppressed.
Tested: pnpm run lint"
```

### Task 7.2: Replace `any` casts in tests with typed fixtures

**Original issue covered:** `@typescript-eslint/no-explicit-any` errors in tests.

**Files:**
- Modify: `src/lib/feedback.test.ts`
- Modify: `src/lib/accuracy-trend.test.ts`
- Modify: any remaining lint-reported test files.

**Step 1: Add typed helpers in `feedback.test.ts`**

At top of `src/lib/feedback.test.ts`, import types:

```ts
import type { EstimateRecord, ActualRecord } from "./feedback.js";
```

Replace `estimates as any, actuals as any` with typed arrays:

```ts
const estimates: EstimateRecord[] = [{ ... }];
const actuals: ActualRecord[] = [{ ... }];
const result = matchEstimatesToActuals(estimates, actuals);
```

For `completedAt` legacy compatibility tests, use a local intersection type:

```ts
type LegacyActualRecord = ActualRecord & { completedAt?: string };
const actuals = [...] satisfies LegacyActualRecord[];
const result = matchEstimatesToActuals(estimates, actuals as ActualRecord[]);
```

If the cast remains necessary, prefer `unknown as ActualRecord[]` and add one helper wrapper, not repeated `as any`.

**Step 2: Fix `accuracy-trend.test.ts` mock type**

Replace:

```ts
mockGetCalibrationData.mockReturnValue(records as any);
```

with a properly typed fixture or helper:

```ts
const records: HistoricalRecord[] = makeRecords(...).map(...);
mockGetCalibrationData.mockReturnValue(records);
```

**Step 3: Re-run lint**

```bash
pnpm run lint
```

Expected: no `no-explicit-any` errors remain.

**Step 4: Commit**

```bash
git add src/lib/feedback.test.ts src/lib/accuracy-trend.test.ts <other touched test files>
git commit -m "Replace test any casts with typed fixtures

Constraint: Tests should enforce the same type discipline as production code.
Rejected: Relaxing no-explicit-any for tests | that hides fixture drift.
Confidence: high
Scope-risk: moderate
Directive: Add typed fixture helpers instead of repeated escape hatches.
Tested: pnpm run lint"
```

### Task 7.3: Decide and enforce non-null assertion policy

**Original issue covered:** 252 lint warnings for non-null assertions.

**Files:**
- Modify: `eslint.config.js`
- Optionally modify selected source files if choosing strict cleanup.

**Decision:** Do not attempt a repo-wide non-null rewrite in this remediation unless the team wants a large diff. Convert the rule from warning to either accepted warning with a debt ticket or error in production only.

Preferred compromise:

```js
{
  files: ["src/lib/**/*.ts", "src/dispatcher/**/*.ts", "src/entries/**/*.ts", "src/tools/**/*.ts"],
  ignores: ["**/*.test.ts"],
  rules: {
    "@typescript-eslint/no-non-null-assertion": "error",
  },
},
{
  files: ["src/**/*.test.ts"],
  rules: {
    "@typescript-eslint/no-non-null-assertion": "warn",
  },
}
```

Then fix production non-null assertions or keep warning policy explicit.

**Step 1: Apply chosen ESLint policy**

Update `eslint.config.js`.

**Step 2: Run lint**

```bash
pnpm run lint
```

Expected: zero errors. Warnings may remain only if accepted by policy.

**Step 3: Commit**

```bash
git add eslint.config.js <production files fixed if any>
git commit -m "Clarify non-null assertion lint policy

Constraint: The repo had hundreds of warnings that made lint noisy but not actionable.
Rejected: Mass mechanical rewrite in one remediation pass | it risks behavior drift.
Confidence: medium
Scope-risk: moderate
Directive: Production non-null assertions should be eliminated incrementally with focused tests.
Tested: pnpm run lint"
```

---

## Phase 8: clean package, docs, and operational scripts

### Task 8.1: Reconcile `.npmignore` and `package.json.files`

**Original issue covered:** package content is mostly correct, but `.npmignore` says `data/` while `package.json.files` includes `data`.

**Files:**
- Modify: `.npmignore`
- Test: `npm pack --dry-run --json`

**Step 1: Remove contradictory `data/` ignore**

Since package `files` intentionally includes `data`, remove this line from `.npmignore`:

```gitignore
data/
```

Keep ignores for `docs/`, `.omx/`, `.omc/`, `coverage/`, `Research/`, etc.

**Step 2: Verify package contents**

```bash
npm pack --dry-run --json
```

Expected: package includes `dist/`, `data/`, `README.md`, `LICENSE`, `package.json`; excludes `.omx`, `.omc`, `coverage`, `Research`, `docs`, scripts unless intentionally included.

**Step 3: Commit**

```bash
git add .npmignore
git commit -m "Align npm ignore rules with packaged data

Constraint: package.json.files intentionally includes data for runtime calibration assets.
Rejected: Leaving data ignored in .npmignore | contradictory packaging rules confuse release review.
Confidence: high
Scope-risk: narrow
Directive: Verify npm pack contents after packaging metadata changes.
Tested: npm pack --dry-run --json"
```

### Task 8.2: Classify and commit or delete untracked operational scripts

**Original issue covered:** dirty working tree contains untracked telemetry scripts.

**Files:**
- `scripts/backfill-telemetry.mjs`
- `scripts/configure-mac-mini-telemetry.sh`
- `scripts/install-telemetry-launchd.sh`
- Docs: `docs/TELEMETRY.md`

**Step 1: Classify scripts**

- `scripts/backfill-telemetry.mjs`: keep if Task 4.4 made it safe/tested.
- `scripts/install-telemetry-launchd.sh`: keep if this is a supported macOS automation path; otherwise move to `scripts/ops/` with warning docs.
- `scripts/configure-mac-mini-telemetry.sh`: likely ops-specific; either keep under `scripts/ops/` or delete if it encodes machine-specific assumptions.

**Step 2: If keeping ops scripts, add guardrails**

For shell scripts, add:

```bash
if [[ "${EPOCH_CONFIRM_OPS:-}" != "1" ]]; then
  echo "Set EPOCH_CONFIRM_OPS=1 to run this operational script." >&2
  exit 1
fi
```

Do not add this guard to non-destructive dry-run commands.

**Step 3: Shell syntax check**

```bash
bash -n scripts/install-telemetry-launchd.sh
bash -n scripts/configure-mac-mini-telemetry.sh
```

Expected: no output, exit 0.

**Step 4: Commit**

```bash
git add scripts/backfill-telemetry.mjs scripts/install-telemetry-launchd.sh scripts/configure-mac-mini-telemetry.sh docs/TELEMETRY.md
git commit -m "Classify telemetry operational scripts

Constraint: Telemetry deployment scripts affect user-local launchd and endpoint configuration.
Rejected: Leaving scripts untracked | hidden operational paths cause repeatable audit confusion.
Confidence: medium
Scope-risk: moderate
Directive: Machine-specific operations require explicit guardrails and docs.
Tested: bash -n scripts/install-telemetry-launchd.sh; bash -n scripts/configure-mac-mini-telemetry.sh; backfill dry-run smoke"
```

---

## Phase 9: final verification and release-readiness report

### Task 9.1: Run full local verification matrix

**Files:**
- No code changes unless failures require fixes.

**Step 1: Run all gates**

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
node scripts/validate-community-data.mjs
node scripts/verify-reference-db.mjs
npm pack --dry-run --json
```

Expected: every command exits 0.

**Step 2: Run CLI smoke tests with isolated data**

```bash
TMP_EPOCH_DIR=$(mktemp -d)
EPOCH_DATA_DIR="$TMP_EPOCH_DIR" node dist/index.js telemetry status
EPOCH_DATA_DIR="$TMP_EPOCH_DIR" node dist/index.js telemetry preview
EPOCH_DATA_DIR="$TMP_EPOCH_DIR" node dist/index.js reference-db-status
rm -rf "$TMP_EPOCH_DIR"
```

Expected: JSON outputs, no writes to real `~/.epoch`.

**Step 3: Run HTTP smoke**

```bash
PORT=3999 EPOCH_DATA_DIR=$(mktemp -d) EPOCH_TRANSPORT=http node dist/index.js > /tmp/epoch-http.log 2>&1 &
PID=$!
sleep 1
curl -fsS http://127.0.0.1:3999/health
curl -fsS http://127.0.0.1:3999/openapi.json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(!j.paths["/v1/telemetry"]) throw new Error("missing telemetry path"); console.log("openapi ok")})'
kill $PID
```

Expected: health JSON, `openapi ok`.

### Task 9.2: Create final remediation report

**Files:**
- Create: `docs/plans/2026-05-09-epoch-audit-remediation-report.md`

**Step 1: Map every audit issue to evidence**

Use this template:

```markdown
# Epoch Audit Remediation Report

| Audit issue | Remediation commit | Files changed | Verification |
|---|---|---|---|
| Telemetry HTTP test leaked real ~/.epoch state | <sha> | src/entries/http.test.ts | pnpm exec vitest run src/entries/http.test.ts |
| CI/release fail open | <sha> | .github/workflows/ci.yml, .github/workflows/release.yml | workflow gate script |
| OpenAPI omitted telemetry/feedback | <sha> | src/entries/http.ts, src/entries/http.test.ts | openapi smoke |
| Package exports no runtime API | <sha> | src/index.ts, src/index.test.ts | node import smoke |
| Reference DB stale/opaque | <sha> | src/lib/self-improve.ts, scripts/verify-reference-db.mjs | reference-db-status + verifier |
| Status/preview semantics conflict | <sha> | src/entries/cli.ts | CLI tests |
| Silent failures | <sha> | src/lib/internal/logging.ts, telemetry/self-improve files | debug logging tests |
| Lint baseline broken | <sha> | lint-target files | pnpm run lint |
| Dirty ops scripts | <sha> | scripts/*, docs/TELEMETRY.md | bash -n, dry-run |
```

**Step 2: Commit report**

```bash
git add docs/plans/2026-05-09-epoch-audit-remediation-report.md
git commit -m "Record audit remediation evidence

Constraint: Completion requires prompt-to-artifact evidence, not proxy green checks alone.
Confidence: high
Scope-risk: narrow
Directive: Future audits should update this table instead of relying on memory.
Tested: pnpm run typecheck; pnpm run lint; pnpm test; pnpm run build; node scripts/validate-community-data.mjs; node scripts/verify-reference-db.mjs; npm pack --dry-run --json"
```

---

## Final PR checklist

Before opening PR:

```bash
git status --short
git log --oneline --decorate -10
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
node scripts/validate-community-data.mjs
node scripts/verify-reference-db.mjs
npm pack --dry-run --json
```

PR description must include:

- Summary of each audit issue remediated.
- Exact verification commands and pass/fail output summary.
- Any remaining accepted risks, especially if bundled reference DB is intentionally frozen.
- Confirmation that tests used isolated `EPOCH_DATA_DIR` and did not touch real `~/.epoch`.
- Confirmation that CI/release fail closed.
