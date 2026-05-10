# Telemetry Documentation

**Last updated:** May 10, 2026

## Purpose

Epoch telemetry collects anonymized estimate/actual pairs to improve estimation accuracy for all users. When enough data flows through the system, the self-improvement engine can produce better correction factors, tighter confidence intervals, and more accurate reference class baselines.

Telemetry is **OFF by default** and requires explicit opt-in via `epoch telemetry enable`.
Epoch does not ship with a built-in default telemetry receiver URL; submissions require an explicitly configured endpoint.

## Data Schema

### AnonymizedRecord

Each individual record in a telemetry submission contains only these fields:

```json
{
  "task_type": "feature",
  "complexity": 3,
  "tool": "pert_estimate",
  "estimated_hours": 8.5,
  "actual_hours": 12.0,
  "ratio": 1.41,
  "date": "2026-05-01",
  "calibration_provenance": "prospective",
  "calibration_usage": "correction"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task_type` | `string` | yes | Category of work: `feature`, `bugfix`, `refactor`, `migration`, `infrastructure`, `documentation`, `testing`, `design` |
| `complexity` | `number \| null` | yes | Complexity rating (1-5). Null if not provided. |
| `tool` | `string` | yes | Epoch tool name that generated the estimate |
| `estimated_hours` | `number` | yes | Original estimated hours |
| `actual_hours` | `number` | yes | Actual hours recorded via `record_actual` |
| `ratio` | `number` | yes | `actual_hours / estimated_hours` -- the estimation accuracy ratio |
| `date` | `string` | yes | Date in `YYYY-MM-DD` format only. Time-of-day is stripped. |
| `calibration_provenance` | `string` | no | Non-identifying provenance class: `prospective`, `backfilled_real_session`, `backfilled_calibration`, `synthetic`, `smoke`, or `unknown`. |
| `calibration_usage` | `string` | no | Math eligibility: `correction`, `baseline`, or `exclude`. Legacy clients may omit it; receiver-side recalculation treats omitted receiver records as baseline-only. |

### SubmissionPayload

The full payload sent to the telemetry endpoint:

```json
{
  "schema_version": 1,
  "installation_id": "550e8400-e29b-41d4-a716-446655440000",
  "epoch_version": "0.2.4",
  "records": [
    { "task_type": "feature", "complexity": 3, "tool": "pert_estimate", "estimated_hours": 8.5, "actual_hours": 12.0, "ratio": 1.41, "date": "2026-05-01", "calibration_provenance": "prospective", "calibration_usage": "correction" }
  ],
  "generated_at": "2026-05-01T12:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `number` | Schema version for forward compatibility. Currently `1`. |
| `installation_id` | `string` | Random UUID for deduplication. Cannot identify a person. |
| `epoch_version` | `string` | Semantic version of the Epoch instance. |
| `records` | `AnonymizedRecord[]` | Array of anonymized estimate/actual pairs. |
| `generated_at` | `string` | ISO-8601 timestamp of when the payload was generated. |

## What Is Stripped

The following fields from your local data are **never** included in telemetry:

| Stripped field | Reason |
|----------------|--------|
| `estimateId` | Could correlate records across submissions |
| `source` | May contain project names |
| `notes` | Free-text, may contain sensitive information |
| `teamId` | Could identify teams or organizations |
| All free-text fields | Risk of containing sensitive information |
| Time-of-day from timestamps | Reduces identifiability; only YYYY-MM-DD is kept |

## How It Works

The telemetry pipeline runs entirely locally until you explicitly enable transmission:

```
Local JSONL files (estimates.jsonl + feedback.jsonl)
  |
  v
Extract matched estimate/actual pairs
  |
  v
Anonymize (strip identifying fields, truncate dates to YYYY-MM-DD)
  |
  v
Classify provenance and correction eligibility
  |
  v
Batch into SubmissionPayload (max 100 records)
  |
  v
Sign with HMAC-SHA256 (keyed by installation_id)
  |
  v
POST to configurable endpoint via HTTPS
```

### HMAC-SHA256 Signing

Every telemetry submission includes an `X-Epoch-Signature` header containing an HMAC-SHA256 signature of the JSON payload, keyed by the `installation_id`. This:

- Proves the data came from a real Epoch instance
- Prevents tampering during transmission
- Does **not** reveal any identity information (the `installation_id` is a random UUID)

The server can verify the signature using the `installation_id` from the payload.

## CLI Commands

### `epoch telemetry enable`

Opts in to telemetry with informed consent. The command:

1. Displays exactly what data will be shared
2. Shows a sample of the anonymized data
3. Asks for explicit confirmation
4. Optionally saves the receiver URL from `--endpoint`
5. Saves the opt-in setting to `~/.epoch/config.json`

Use `--endpoint <url>` when you already know the receiver:

```bash
epoch telemetry enable --endpoint https://your-server.example.com/v1/telemetry
```

### `epoch telemetry disable`

Opts out of telemetry. Stops all data transmission. Previously sent data is not affected (see deletion below).

Can also be triggered via environment variable: `EPOCH_TELEMETRY=0`

### `epoch telemetry preview`

Shows exactly what anonymized data would be sent if telemetry were enabled. This command does **not** transmit any data. Use it to verify what will be shared before opting in.

### `epoch telemetry status`

Displays current telemetry configuration:

- Whether telemetry is enabled or disabled
- Endpoint URL
- Whether the endpoint is usable or still unset/placeholder
- Number of records queued for next submission
- Timestamp of last successful submission
- Last and total receiver-accepted / receiver-deduplicated counts
- Installation ID

### `epoch telemetry set-endpoint`

Configures the telemetry receiver without changing the opt-in setting:

```bash
epoch telemetry set-endpoint --endpoint https://your-server.example.com/v1/telemetry
```

Endpoints must use HTTPS, except localhost receivers used for local development, Tailscale private `100.64.0.0/10` receivers, and Tailscale Serve hostnames ending in `.ts.net` used on private networks.

### `epoch telemetry submit`

Submits the queued anonymized records to the configured endpoint:

```bash
epoch telemetry submit
```

You can also set the endpoint immediately before submitting:

```bash
epoch telemetry submit --endpoint https://your-server.example.com/v1/telemetry
```

Successful submissions update `lastSubmissionAt`, `totalRecordsSubmitted`, `totalRecordsAccepted`, and `totalRecordsDeduplicated` in `epoch telemetry status`. Failed submissions leave records queued locally.

## Calibration Provenance and Math Eligibility

Telemetry can be useful without being allowed to change correction factors. Epoch separates the two:

- **Correction-eligible:** prospective estimate/actual pairs generated before the work completed. These update task, tool, complexity, and global correction factors.
- **Baseline-only:** real but retrospective/backfilled records, including records whose completion timestamp predates the estimate timestamp and legacy receiver records without explicit provenance.
- **Excluded:** smoke tests, synthetic data, seed data, and invalid records. These do not update math or reference DB factors.

The release recalculation command preserves this split in `provenanceSummary`:

```bash
pnpm run recalculate:reference-db -- --stage-dir <dir> --write
node scripts/verify-reference-db.mjs
```

For the May 10, 2026 UTC release recalculation, the reference DB was refreshed from 7,608 tool-call telemetry events, 59 correction-eligible matched pairs, 1,007 baseline-only records, and 698 Windows receiver records. The 322 legacy receiver records without explicit provenance and 51 receiver backfills duplicated by source feedback were intentionally held out of correction-factor math.

## Backfill Historical Records

The supported backfill script sends all currently available anonymized records in 100-record chunks. It imports the built package API, so build first:

```bash
pnpm run build
node scripts/backfill-telemetry.mjs --endpoint https://your-server.example.com/v1/telemetry --dry-run
node scripts/backfill-telemetry.mjs --endpoint https://your-server.example.com/v1/telemetry
```

Always run `--dry-run` first. Dry-run mode validates and counts records without making network calls or updating `~/.epoch/config.json`. A real backfill updates telemetry status with submitted, accepted, and deduplicated counts returned by the receiver.

`scripts/backfill-telemetry.mjs` is included in the npm package alongside this telemetry guide, so package consumers can run the same dry-run-first path from an installed package checkout.

For a private Mac mini receiver reachable through Tailscale, use the private endpoint explicitly:

```bash
node scripts/backfill-telemetry.mjs --endpoint http://100.x.y.z:3099/v1/telemetry --dry-run
# or, when the receiver is exposed through Tailscale Serve:
node scripts/backfill-telemetry.mjs --endpoint http://host.tailnet-name.ts.net:3099/v1/telemetry --dry-run
```

Side-effecting operational helpers such as `scripts/configure-mac-mini-telemetry.sh`
and `scripts/install-telemetry-launchd.sh` require `EPOCH_CONFIRM_OPS=1`. They can
enable telemetry, submit queued records, or install a user launchd agent, so review
`EPOCH_TELEMETRY_ENDPOINT` and `EPOCH_TELEMETRY_INTERVAL_SECONDS` before running them.
Both helpers also support `--dry-run`, and neither has a built-in default receiver:
set `EPOCH_TELEMETRY_ENDPOINT` explicitly for your own HTTPS, localhost, or private-network endpoint.

### `epoch telemetry export`

Writes all anonymized data to a JSON file on disk. The output file contains the same `SubmissionPayload` format that would be sent to the endpoint. This is useful for:

- Reviewing your data
- Contributing to the community dataset via PR
- Keeping a personal backup

### `epoch telemetry delete-data`

Provides instructions for deleting your data:

1. Local data: `rm -rf ~/.epoch/` removes all local files
2. Server-side data: Contact via GitHub Issues (see [PRIVACY.md](./PRIVACY.md))

### `epoch share-data`

Exports anonymized data formatted for community contribution to the Epoch GitHub repository. Produces a file suitable for submitting via Pull Request. See [CONTRIBUTING-data.md](../CONTRIBUTING-data.md) for the community contribution workflow.

## Rate Limits

Telemetry submissions are rate-limited to prevent accidental data flooding:

| Limit | Value |
|-------|-------|
| Max submissions per hour | 1 |
| Max records per submission | 100 |
| Max payload size | 1 MB |

If a submission fails, it is not retried automatically. Records remain in the local queue for the next scheduled submission.

## Server-Side Promises

When using a Kyanite Labs-operated endpoint, if one is explicitly configured, the following guarantees apply:

| Promise | Implementation |
|---------|---------------|
| No IP logging | Server does not record client IP addresses |
| No cross-correlation | Telemetry data is never joined with other data sources |
| Aggregation after 90 days | Raw records are aggregated into statistical summaries after 90 days |
| Self-hostable | The endpoint is a simple HTTP API; you can run your own |

## Self-Hosting

You can run your own telemetry endpoint to keep all data within your infrastructure. The API contract is minimal:

Epoch ships with a verified baseline reference database. Self-improvement writes the active learned database to `~/.epoch/reference-database.json` (or `EPOCH_DATA_DIR/reference-database.json`); run `epoch reference-db-status` to see whether the active database is bundled or user-local, when it was generated, how many correction factors are available, and why any bundled factor family is not populated yet. Bundled correction factors are updated only from records marked or inferred as correction-eligible.

### Endpoint Contract

```
POST /v1/telemetry
Content-Type: application/json
X-Epoch-Signature: <HMAC-SHA256 of body, keyed by installation_id>
X-Epoch-Version: <epoch_version from payload>
```

**Request body:** `SubmissionPayload` (see schema above)

**Expected responses:**

| Status | Meaning |
|--------|---------|
| `200 OK` | Accepted. Body: `{ "accepted": <record_count>, "deduplicated": <count> }` |
| `400 Bad Request` | Invalid payload or schema version mismatch |
| `429 Too Many Requests` | Rate limit exceeded. Body: `{ "retry_after_seconds": <seconds> }` |

Epoch's built-in HTTP server includes a local receiver for this contract:

```bash
EPOCH_TRANSPORT=http EPOCH_PORT=3099 node dist/index.js
epoch telemetry set-endpoint --endpoint http://localhost:3099/v1/telemetry
epoch telemetry submit
```

The built-in receiver verifies the signature and writes three local files:

- `~/.epoch/telemetry-records.jsonl` — shared anonymized records plus `received_at`
- `~/.epoch/telemetry-record-keys.jsonl` — receiver-local SHA-256 dedupe keys
- `~/.epoch/telemetry-receipts.jsonl` — aggregate receipts with accepted/deduplicated counts

The shared records file contains only anonymized telemetry fields: `task_type`, `complexity`, `tool`, `estimated_hours`, `actual_hours`, `ratio`, `date`, optional `calibration_provenance`, optional `calibration_usage`, and receiver-added `received_at`. It does not store installation IDs, notes, project names, source text, team IDs, or dedupe keys.

**Verification steps (server-side):**

1. Parse the JSON body
2. Compute HMAC-SHA256 of the raw body using `installation_id` from the payload as the key
3. Compare with `X-Epoch-Signature` header (constant-time comparison)
4. Validate `schema_version` is supported
5. Deduplicate records by a receiver-local hash of `(installation_id, record)`
6. Store anonymized records and aggregate receipts

### Configuring a custom endpoint

```bash
# Set via CLI while enabling telemetry
epoch telemetry enable --endpoint https://your-server.example.com/v1/telemetry

# Or set/update independently
epoch telemetry set-endpoint --endpoint https://your-server.example.com/v1/telemetry

# Or set in config.json directly
# ~/.epoch/config.json:
# { "telemetry": { "enabled": true, "endpoint": "https://your-server.example.com/v1/telemetry" } }
```

## Environment Variables

| Variable | Values | Description |
|----------|--------|-------------|
| `EPOCH_TELEMETRY` | `0` or `1` | Overrides config file. `0` disables telemetry, `1` enables it (requires prior consent). |
| `EPOCH_TELEMETRY_ENDPOINT` | URL | Overrides the configured telemetry receiver endpoint for status/submission. |

The environment variable takes precedence over the config file setting.

## Privacy

For full privacy details, see [PRIVACY.md](./PRIVACY.md).
